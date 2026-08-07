'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CollabBus } from '@/lib/flows/use-flow-collab'
import { reduceHuddleSignal, type HuddleSignal } from '@/lib/flows/huddle-signals'
import { rmsLevel, SPEAKING_THRESHOLD } from '@/lib/flows/audio-level'
import { describeMediaError, type MediaErrorInfo } from '@/lib/flows/media-errors'
import { nextPeerAction, recoveryDelayMs } from '@/lib/flows/peer-recovery'
import { isPttTrigger, micEnabled } from '@/lib/flows/push-to-talk'
import { partitionDevices, type DeviceOption } from '@/lib/flows/audio-devices'

// STUN-only v1: connects on most home/office networks. A minority behind
// strict/symmetric NATs need a TURN relay — a deliberate follow-up, not v1.
const RTC_CONFIG: RTCConfiguration = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }

type PeerEntry = {
  pc: RTCPeerConnection
  audio: HTMLAudioElement | null
  analyser: AnalyserNode | null
  /** Whether WE sent the original offer — only this side restarts ICE. */
  isInitiator: boolean
  attempts: number
  timer: number | null
}

/** How a peer's link looks to the rest of the UI. */
export type PeerConnectionState = 'connected' | 'reconnecting' | 'lost'

/** Per-peer playback, local to this listener. Never broadcast. */
export type PeerAudioSettings = { volume: number; muted: boolean }

/** The hook's full surface. Passed as one prop so the Jam widget's controls
 *  cannot drift out of sync with what the hook actually exposes. */
export type FlowHuddle = ReturnType<typeof useFlowHuddle>

const DEFAULT_PEER_AUDIO: PeerAudioSettings = { volume: 1, muted: false }

/**
 * P2P voice huddle over the flow's collab channel: audio-only WebRTC mesh
 * (one RTCPeerConnection per other participant — fine for the 2-5 person jams
 * this targets), signaled via the 'huddle' bus event. The pure signaling
 * policy lives in huddle-signals.ts; this hook performs the side effects.
 * Presence (`inHuddle`) is flipped via setInHuddle so avatars react.
 */
export function useFlowHuddle(
  bus: CollabBus,
  selfClientId: string,
  setInHuddle: (inHuddle: boolean) => void,
) {
  const [joined, setJoined] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [muted, setMuted] = useState(false)
  const [pttEnabled, setPttEnabledState] = useState(false)
  const [pttHeld, setPttHeld] = useState(false)
  const [speakingIds, setSpeakingIds] = useState<Set<string>>(new Set())
  const [error, setError] = useState<MediaErrorInfo | null>(null)
  const [peerStates, setPeerStates] = useState<Map<string, PeerConnectionState>>(new Map())
  const [peerAudio, setPeerAudioState] = useState<Map<string, PeerAudioSettings>>(new Map())
  // Deliberately NOT cleared by closePeer: a reconnect builds a fresh audio
  // element, and without this your volume choice would silently reset every
  // time that peer's wifi hiccupped.
  const peerAudioRef = useRef<Map<string, PeerAudioSettings>>(new Map())
  const [devices, setDevices] = useState<{ inputs: DeviceOption[]; outputs: DeviceOption[] }>({ inputs: [], outputs: [] })
  const [inputDeviceId, setInputDeviceId] = useState<string | null>(null)
  const [outputDeviceId, setOutputDeviceId] = useState<string | null>(null)
  const outputDeviceIdRef = useRef<string | null>(null)
  outputDeviceIdRef.current = outputDeviceId
  // Chrome/Edge only. A visible but inert picker is worse than none, so the UI
  // omits the control entirely where this is false.
  const canSelectOutput = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype
  const peers = useRef<Map<string, PeerEntry>>(new Map())
  const localStream = useRef<MediaStream | null>(null)
  const audioCtx = useRef<AudioContext | null>(null)
  const localAnalyser = useRef<AnalyserNode | null>(null)
  const joinedRef = useRef(false)
  // ICE config from the auth-gated endpoint. Fetched on EVERY join (a rare,
  // deliberate gesture) so short-lived credentials cannot go stale in a
  // long-lived tab. Any failure falls back to baked-in STUN.
  const iceServersRef = useRef<RTCIceServer[] | null>(null)
  // Whether the ICE config includes a TURN relay. null = never fetched. When
  // false, a peer that can't connect is probably behind a NAT that STUN alone
  // can't traverse — the panel uses this to explain the failure.
  const [relayAvailable, setRelayAvailable] = useState<boolean | null>(null)

  const send = useCallback((signal: Omit<HuddleSignal, 'from'>) => {
    bus.send('huddle', { ...signal, from: selfClientId })
  }, [bus, selfClientId])

  const setPeerState = useCallback((peerId: string, state: PeerConnectionState | null) => {
    setPeerStates((prev) => {
      const next = new Map(prev)
      if (state === null) next.delete(peerId)
      else next.set(peerId, state)
      return next
    })
  }, [])

  const closePeer = useCallback((peerId: string) => {
    const entry = peers.current.get(peerId)
    if (!entry) return
    peers.current.delete(peerId)
    if (entry.timer !== null) window.clearTimeout(entry.timer)
    try { entry.pc.close() } catch { /* already closed */ }
    entry.audio?.remove()
  }, [])

  const applyPeerAudio = useCallback((peerId: string) => {
    const entry = peers.current.get(peerId)
    if (!entry?.audio) return
    const settings = peerAudioRef.current.get(peerId) ?? DEFAULT_PEER_AUDIO
    entry.audio.volume = settings.volume
    entry.audio.muted = settings.muted
  }, [])

  const setPeerAudio = useCallback((peerId: string, patch: Partial<PeerAudioSettings>) => {
    const next = { ...(peerAudioRef.current.get(peerId) ?? DEFAULT_PEER_AUDIO), ...patch }
    peerAudioRef.current.set(peerId, next)
    setPeerAudioState(new Map(peerAudioRef.current))
    applyPeerAudio(peerId)
  }, [applyPeerAudio])

  const attachAnalyser = useCallback((stream: MediaStream): AnalyserNode | null => {
    try {
      audioCtx.current ??= new AudioContext()
      const source = audioCtx.current.createMediaStreamSource(stream)
      const analyser = audioCtx.current.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)
      return analyser
    } catch {
      return null // no speaking pulse, audio still works
    }
  }, [])

  const restartIce = useCallback(async (peerId: string) => {
    const entry = peers.current.get(peerId)
    if (!entry) return
    entry.attempts += 1
    try {
      entry.pc.restartIce()
      const offer = await entry.pc.createOffer()
      await entry.pc.setLocalDescription(offer)
      // A re-offer to a peer we already have: reduceHuddleSignal routes it to
      // the existing connection, so no signaling change was needed.
      send({ kind: 'offer', to: peerId, sdp: offer })
    } catch {
      // The scheduled follow-up evaluates state again and closes if needed.
    }
  }, [send])

  const scheduleRecovery = useCallback((peerId: string) => {
    const entry = peers.current.get(peerId)
    if (!entry || entry.timer !== null) return
    const delay = recoveryDelayMs(entry.pc.connectionState, entry.attempts)
    entry.timer = window.setTimeout(() => {
      const current = peers.current.get(peerId)
      if (!current) return
      current.timer = null
      if (current.pc.connectionState === 'connected') {
        setPeerState(peerId, 'connected')
        current.attempts = 0
        return
      }
      const action = nextPeerAction(current.pc.connectionState, current.attempts, current.isInitiator)
      if (action === 'restart-ice') {
        void restartIce(peerId)
        scheduleRecoveryRef.current(peerId)
      } else if (action === 'close') {
        setPeerState(peerId, 'lost')
        closePeer(peerId)
      }
    }, delay)
  }, [restartIce, closePeer, setPeerState])

  // scheduleRecovery re-schedules itself; a ref breaks the declaration cycle.
  const scheduleRecoveryRef = useRef(scheduleRecovery)
  scheduleRecoveryRef.current = scheduleRecovery

  const createPeer = useCallback((peerId: string, isInitiator: boolean): RTCPeerConnection => {
    const pc = new RTCPeerConnection({ iceServers: iceServersRef.current ?? RTC_CONFIG.iceServers })
    for (const track of localStream.current?.getTracks() ?? []) pc.addTrack(track, localStream.current!)
    pc.onicecandidate = (event) => {
      if (event.candidate) send({ kind: 'ice', to: peerId, candidate: event.candidate.toJSON() })
    }
    pc.ontrack = (event) => {
      const stream = event.streams[0]
      if (!stream) return
      // Created after the user's explicit Join gesture, so autoplay is allowed.
      const audio = document.createElement('audio')
      audio.autoplay = true
      audio.srcObject = stream
      document.body.appendChild(audio)
      const entry = peers.current.get(peerId)
      if (entry) {
        // Remove any previous element FIRST. Without this a second ontrack —
        // renegotiation, or a second track — orphans the old element in the
        // body, still attached and still playing, with nothing referencing it.
        entry.audio?.remove()
        entry.audio = audio
        entry.analyser = attachAnalyser(stream)
        applyPeerAudio(peerId) // a reconnecting peer returns at the volume you set
        // Elements created after an output switch must adopt the chosen sink.
        if (outputDeviceIdRef.current) {
          void (audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> })
            .setSinkId?.(outputDeviceIdRef.current)?.catch(() => {})
        }
      }
    }
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState
      if (state === 'connected') {
        const entry = peers.current.get(peerId)
        if (entry) {
          entry.attempts = 0
          if (entry.timer !== null) { window.clearTimeout(entry.timer); entry.timer = null }
        }
        setPeerState(peerId, 'connected')
      } else if (state === 'disconnected' || state === 'failed') {
        // Was: closePeer(peerId) — a 2s wifi blip killed the peer for good.
        setPeerState(peerId, 'reconnecting')
        scheduleRecoveryRef.current(peerId)
      } else if (state === 'closed') {
        setPeerState(peerId, null)
        closePeer(peerId)
      }
    }
    peers.current.set(peerId, { pc, audio: null, analyser: null, isInitiator, attempts: 0, timer: null })
    return pc
  }, [send, closePeer, attachAnalyser, setPeerState, applyPeerAudio])

  // Signaling: run the pure policy, then perform the WebRTC side effects.
  useEffect(() => bus.on('huddle', (payload) => {
    const run = async () => {
      const signal = payload as unknown as HuddleSignal
      const instructions = reduceHuddleSignal(selfClientId, joinedRef.current, Array.from(peers.current.keys()), signal)
      for (const instruction of instructions) {
        try {
          if (instruction.action === 'create-offer') {
            const pc = createPeer(instruction.peerId, true)
            const offer = await pc.createOffer()
            await pc.setLocalDescription(offer)
            send({ kind: 'offer', to: instruction.peerId, sdp: offer })
          } else if (instruction.action === 'apply-offer') {
            const pc = peers.current.get(instruction.peerId)?.pc ?? createPeer(instruction.peerId, false)
            await pc.setRemoteDescription(instruction.sdp as RTCSessionDescriptionInit)
            const answer = await pc.createAnswer()
            await pc.setLocalDescription(answer)
            send({ kind: 'answer', to: instruction.peerId, sdp: answer })
          } else if (instruction.action === 'apply-answer') {
            await peers.current.get(instruction.peerId)?.pc.setRemoteDescription(instruction.sdp as RTCSessionDescriptionInit)
          } else if (instruction.action === 'add-ice') {
            await peers.current.get(instruction.peerId)?.pc.addIceCandidate(instruction.candidate as RTCIceCandidateInit)
          } else {
            closePeer(instruction.peerId)
          }
        } catch {
          // One bad peer or stale signal must not break the rest of the mesh.
        }
      }
    }
    void run()
  }), [bus, selfClientId, createPeer, closePeer, send])

  const join = useCallback(async () => {
    if (joinedRef.current) return
    setError(null)
    setConnecting(true)
    try {
      try {
        const res = await fetch('/api/flows/huddle-ice', { cache: 'no-store' })
        const data = await res.json().catch(() => null)
        if (res.ok && Array.isArray(data?.iceServers) && data.iceServers.length) {
          iceServersRef.current = data.iceServers
        }
      } catch { /* keep whatever we had; createPeer falls back to STUN */ }
      iceServersRef.current ??= (RTC_CONFIG.iceServers as RTCIceServer[] | undefined) ?? null
      // Derived from the servers actually in use, so a failed fetch (→ STUN
      // fallback) reports honestly rather than echoing the server's claim.
      setRelayAvailable(
        (iceServersRef.current ?? []).some((server) =>
          (Array.isArray(server.urls) ? server.urls : [server.urls]).some((url) => /^turns?:/.test(url))),
      )
      localStream.current = await navigator.mediaDevices.getUserMedia({ audio: true })
      localAnalyser.current = attachAnalyser(localStream.current)
      joinedRef.current = true
      setJoined(true)
      setMuted(false)
      setInHuddle(true)
      send({ kind: 'join' }) // existing members respond with offers
    } catch (mediaError) {
      // Was silently swallowed: the user clicked Join and nothing happened.
      setError(describeMediaError(mediaError))
    } finally {
      setConnecting(false)
    }
  }, [send, setInHuddle, attachAnalyser])

  const leave = useCallback(() => {
    if (!joinedRef.current) return
    joinedRef.current = false
    setJoined(false)
    send({ kind: 'leave' })
    for (const peerId of Array.from(peers.current.keys())) closePeer(peerId)
    localStream.current?.getTracks().forEach((track) => track.stop())
    localStream.current = null
    localAnalyser.current = null
    // Close the AudioContext — browsers cap live contexts (~6/page); leaking one
    // per join eventually breaks the speaking-pulse analyser and keeps dead
    // contexts running. close() rejects if already closed → ignore.
    audioCtx.current?.close().catch(() => {})
    audioCtx.current = null
    setInHuddle(false)
    setSpeakingIds(new Set())
    setPeerStates(new Map())
    setPttHeld(false)
    // Volume choices are per-session: a level you set last week is a confusing
    // default, so unlike peer recreation, leaving does clear them.
    peerAudioRef.current.clear()
    setPeerAudioState(new Map())
  }, [send, closePeer, setInHuddle])

  const toggleMute = useCallback(() => {
    setMuted((current) => !current)
  }, [])

  const setPttEnabled = useCallback((on: boolean) => {
    setPttEnabledState(on)
    setPttHeld(false) // never carry a stale hold across a mode change
  }, [])

  const transmitting = joined && micEnabled(muted, pttEnabled, pttHeld)
  const transmittingRef = useRef(transmitting)
  transmittingRef.current = transmitting
  // Mirrors the mic-enabled decision so a mid-call device switch can restore it
  // without making selectInputDevice depend on every PTT keypress.
  const micLiveRef = useRef(false)

  // The ONLY place the local track's enabled flag is set. Every path that can
  // change it — mute, PTT mode, key hold, blur, device switch — resolves
  // through micEnabled, so "am I live?" has exactly one answer.
  useEffect(() => {
    const live = micEnabled(muted, pttEnabled, pttHeld)
    micLiveRef.current = live
    localStream.current?.getAudioTracks().forEach((track) => { track.enabled = live })
  }, [muted, pttEnabled, pttHeld, joined])

  // Push-to-talk key handling, bound only while the mode is on and we're in a
  // huddle — Space behaves normally everywhere else in the builder.
  useEffect(() => {
    if (!joined || !pttEnabled) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPttTrigger(event.key, event.target as HTMLElement | null, event.repeat)) return
      event.preventDefault() // Space would otherwise scroll the page
      setPttHeld(true)
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== ' ') return
      setPttHeld(false)
    }
    // Tabbing away mid-hold must not leave us transmitting into a conversation
    // we've walked away from — keyup never arrives once focus is gone.
    const onBlur = () => setPttHeld(false)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      setPttHeld(false)
    }
  }, [joined, pttEnabled])

  // Speaking pulse: sample all analysers 4×/s; update only on change.
  useEffect(() => {
    if (!joined) return
    const buffer = new Uint8Array(256)
    const timer = window.setInterval(() => {
      const next = new Set<string>()
      // A disabled track emits silence, so this would usually resolve itself —
      // but showing yourself pulsing while not transmitting is the most
      // misleading state the bar can reach, so it's gated explicitly. Read
      // through a ref: depending on `transmitting` would rebuild this interval
      // on every push-to-talk keypress.
      if (localAnalyser.current && transmittingRef.current) {
        localAnalyser.current.getByteTimeDomainData(buffer)
        if (rmsLevel(buffer) > SPEAKING_THRESHOLD) next.add(selfClientId)
      }
      for (const [peerId, entry] of peers.current) {
        if (!entry.analyser) continue
        entry.analyser.getByteTimeDomainData(buffer)
        if (rmsLevel(buffer) > SPEAKING_THRESHOLD) next.add(peerId)
      }
      setSpeakingIds((prev) => (prev.size === next.size && [...next].every((id) => prev.has(id)) ? prev : next))
    }, 250)
    return () => window.clearInterval(timer)
  }, [joined, selfClientId])

  // Device labels are empty until mic permission is granted, so this only runs
  // once joined — and re-runs when hardware changes mid-call.
  useEffect(() => {
    if (!joined) return
    let cancelled = false
    const refresh = async () => {
      try {
        const list = await navigator.mediaDevices.enumerateDevices()
        if (!cancelled) setDevices(partitionDevices(list))
      } catch { /* leave the lists empty; the menu renders nothing */ }
    }
    void refresh()
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh)
    return () => {
      cancelled = true
      navigator.mediaDevices?.removeEventListener?.('devicechange', refresh)
    }
  }, [joined])

  const selectInputDevice = useCallback(async (deviceId: string) => {
    try {
      const next = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } })
      const track = next.getAudioTracks()[0]
      if (!track) return
      // replaceTrack needs no renegotiation, so nobody drops mid-sentence.
      await Promise.all(
        Array.from(peers.current.values()).map(async ({ pc }) => {
          const sender = pc.getSenders().find((s) => s.track?.kind === 'audio')
          if (sender) await sender.replaceTrack(track)
        }),
      )
      localStream.current?.getTracks().forEach((t) => t.stop())
      localStream.current = next
      localAnalyser.current = attachAnalyser(next)
      // Re-apply, or switching mics while muted would quietly unmute you.
      track.enabled = micLiveRef.current
      setInputDeviceId(deviceId)
    } catch (mediaError) {
      setError(describeMediaError(mediaError))
    }
  }, [attachAnalyser])

  const selectOutputDevice = useCallback(async (deviceId: string) => {
    if (!canSelectOutput) return
    setOutputDeviceId(deviceId)
    await Promise.all(
      Array.from(peers.current.values()).map(async (entry) => {
        const sink = entry.audio as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null
        try { await sink?.setSinkId?.(deviceId) } catch { /* device vanished */ }
      }),
    )
  }, [canSelectOutput])

  const clearError = useCallback(() => setError(null), [])

  /** Accessor for the live mic stream (huddle-notes capture records from it).
   *  A function, not the ref itself — the stream is replaced on device switch. */
  const getLocalStream = useCallback(() => localStream.current, [])

  // Leave cleanly on unmount/navigation (ref pattern: the cleanup must run
  // once at unmount, not every time leave's identity changes).
  const leaveRef = useRef(leave)
  leaveRef.current = leave
  useEffect(() => () => { if (joinedRef.current) leaveRef.current() }, [])

  return {
    joined, connecting, muted, speakingIds, error, peerStates, relayAvailable,
    pttEnabled, transmitting, peerAudio,
    devices, inputDeviceId, outputDeviceId, canSelectOutput,
    join, leave, toggleMute, setPttEnabled, setPeerAudio, clearError,
    selectInputDevice, selectOutputDevice, getLocalStream,
  }
}
