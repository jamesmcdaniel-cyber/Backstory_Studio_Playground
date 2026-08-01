'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CollabBus } from '@/lib/flows/use-flow-collab'
import { reduceHuddleSignal, type HuddleSignal } from '@/lib/flows/huddle-signals'
import { rmsLevel, SPEAKING_THRESHOLD } from '@/lib/flows/audio-level'
import { describeMediaError, type MediaErrorInfo } from '@/lib/flows/media-errors'
import { nextPeerAction, recoveryDelayMs } from '@/lib/flows/peer-recovery'

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
  const [speakingIds, setSpeakingIds] = useState<Set<string>>(new Set())
  const [error, setError] = useState<MediaErrorInfo | null>(null)
  const [peerStates, setPeerStates] = useState<Map<string, PeerConnectionState>>(new Map())
  const peers = useRef<Map<string, PeerEntry>>(new Map())
  const localStream = useRef<MediaStream | null>(null)
  const audioCtx = useRef<AudioContext | null>(null)
  const localAnalyser = useRef<AnalyserNode | null>(null)
  const joinedRef = useRef(false)
  // ICE config from the auth-gated endpoint. Fetched on EVERY join (a rare,
  // deliberate gesture) so short-lived credentials cannot go stale in a
  // long-lived tab. Any failure falls back to baked-in STUN.
  const iceServersRef = useRef<RTCIceServer[] | null>(null)

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
        entry.audio = audio
        entry.analyser = attachAnalyser(stream)
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
  }, [send, closePeer, attachAnalyser, setPeerState])

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
  }, [send, closePeer, setInHuddle])

  const toggleMute = useCallback(() => {
    setMuted((current) => {
      const next = !current
      localStream.current?.getAudioTracks().forEach((track) => { track.enabled = !next })
      return next
    })
  }, [])

  // Speaking pulse: sample all analysers 4×/s; update only on change.
  useEffect(() => {
    if (!joined) return
    const buffer = new Uint8Array(256)
    const timer = window.setInterval(() => {
      const next = new Set<string>()
      if (localAnalyser.current) {
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

  const clearError = useCallback(() => setError(null), [])

  // Leave cleanly on unmount/navigation (ref pattern: the cleanup must run
  // once at unmount, not every time leave's identity changes).
  const leaveRef = useRef(leave)
  leaveRef.current = leave
  useEffect(() => () => { if (joinedRef.current) leaveRef.current() }, [])

  return { joined, connecting, muted, speakingIds, error, peerStates, join, leave, toggleMute, clearError }
}
