'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CollabBus } from '@/lib/flows/use-flow-collab'
import { reduceHuddleSignal, type HuddleSignal } from '@/lib/flows/huddle-signals'
import { rmsLevel, SPEAKING_THRESHOLD } from '@/lib/flows/audio-level'

// STUN-only v1: connects on most home/office networks. A minority behind
// strict/symmetric NATs need a TURN relay — a deliberate follow-up, not v1.
const RTC_CONFIG: RTCConfiguration = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }

type PeerEntry = { pc: RTCPeerConnection; audio: HTMLAudioElement | null; analyser: AnalyserNode | null }

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

  const closePeer = useCallback((peerId: string) => {
    const entry = peers.current.get(peerId)
    if (!entry) return
    peers.current.delete(peerId)
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

  const createPeer = useCallback((peerId: string): RTCPeerConnection => {
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
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) closePeer(peerId)
    }
    peers.current.set(peerId, { pc, audio: null, analyser: null })
    return pc
  }, [send, closePeer, attachAnalyser])

  // Signaling: run the pure policy, then perform the WebRTC side effects.
  useEffect(() => bus.on('huddle', (payload) => {
    const run = async () => {
      const signal = payload as unknown as HuddleSignal
      const instructions = reduceHuddleSignal(selfClientId, joinedRef.current, Array.from(peers.current.keys()), signal)
      for (const instruction of instructions) {
        try {
          if (instruction.action === 'create-offer') {
            const pc = createPeer(instruction.peerId)
            const offer = await pc.createOffer()
            await pc.setLocalDescription(offer)
            send({ kind: 'offer', to: instruction.peerId, sdp: offer })
          } else if (instruction.action === 'apply-offer') {
            const pc = peers.current.get(instruction.peerId)?.pc ?? createPeer(instruction.peerId)
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
    } catch {
      // Mic denied or unavailable — stay out of the huddle.
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

  // Leave cleanly on unmount/navigation (ref pattern: the cleanup must run
  // once at unmount, not every time leave's identity changes).
  const leaveRef = useRef(leave)
  leaveRef.current = leave
  useEffect(() => () => { if (joinedRef.current) leaveRef.current() }, [])

  return { joined, connecting, muted, speakingIds, join, leave, toggleMute }
}
