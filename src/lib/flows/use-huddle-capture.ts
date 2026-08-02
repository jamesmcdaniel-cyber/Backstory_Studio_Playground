'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CollabParticipant } from '@/lib/flows/use-flow-room'
import { liveCaptureSession, shouldSummarize } from '@/lib/flows/huddle-capture-state'

/** Two-minute segments: bounds memory, stays far under the upload cap, and a
 *  crashed tab loses two minutes instead of the whole conversation. */
const SEGMENT_MS = 120_000

export type HuddleNoteRecord = {
  id: string
  sessionId: string
  summary: string
  decisions: string[]
  participants: string[]
  startedAt: string
  createdAt: string
}

/**
 * Huddle-notes capture for THIS client. Records only the local microphone
 * (there is no central audio in a mesh), uploads transcribed segments every
 * two minutes, and — when this client is the last to leave the huddle —
 * triggers the summary that persists the note and deletes the raw segments.
 *
 * Consent model: `enableCapture` mints the session and advertises it over
 * presence; `optOut(true)` stops recording locally, so an opted-out
 * participant's audio never leaves their machine.
 */
export function useHuddleCapture(params: {
  flowId: string
  joined: boolean
  localStream: () => MediaStream | null
  participants: CollabParticipant[]
  selfClientId: string
  setCapture: (capturing: boolean, sessionId: string | null) => void
}) {
  const { flowId, joined, localStream, participants, selfClientId, setCapture } = params
  const [optedOut, setOptedOut] = useState(false)
  const [uploadWarning, setUploadWarning] = useState(false)
  const [summarizing, setSummarizing] = useState(false)
  const [latestNote, setLatestNote] = useState<HuddleNoteRecord | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const segmentStartRef = useRef<string>('')
  const sessionRef = useRef<string | null>(null)
  // Only the participant who ENABLED capture advertises the session id
  // (followers advertise just their own capturing flag) — see
  // huddle-capture-state.ts for why the off-switch depends on this asymmetry.
  const isOwnerRef = useRef(false)

  const others = participants.filter((p) => p.clientId !== selfClientId)
  // The room's live session: someone (maybe us, maybe not) has capture on.
  const roomSession = liveCaptureSession(participants)
  const selfCapturing = Boolean(recorderRef.current)

  const uploadSegment = useCallback(async (blob: Blob, sessionId: string, startedAt: string) => {
    const form = new FormData()
    form.append('audio', blob)
    form.append('sessionId', sessionId)
    form.append('startedAt', startedAt)
    const post = () => fetch(`/api/flows/${flowId}/huddle/segment`, { method: 'POST', body: form })
    try {
      let res = await post()
      if (!res.ok) res = await post() // one retry, then give up visibly
      if (!res.ok) setUploadWarning(true)
    } catch {
      try {
        const res = await post()
        if (!res.ok) setUploadWarning(true)
      } catch {
        setUploadWarning(true)
      }
    }
  }, [flowId])

  const stopRecorder = useCallback(() => {
    const recorder = recorderRef.current
    recorderRef.current = null
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop() } catch { /* already stopped */ }
    }
  }, [])

  const startRecorder = useCallback((sessionId: string) => {
    const stream = localStream()
    if (!stream || recorderRef.current) return
    let recorder: MediaRecorder
    try {
      recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
    } catch {
      try { recorder = new MediaRecorder(stream) } catch { return /* no MediaRecorder → no capture */ }
    }
    segmentStartRef.current = new Date().toISOString()
    recorder.ondataavailable = (event) => {
      const startedAt = segmentStartRef.current
      segmentStartRef.current = new Date().toISOString()
      if (event.data && event.data.size > 0) void uploadSegment(event.data, sessionId, startedAt)
    }
    recorder.start(SEGMENT_MS)
    recorderRef.current = recorder
  }, [localStream, uploadSegment])

  /** Turn note-taking on for the whole huddle (mints and owns the session). */
  const enableCapture = useCallback(() => {
    if (!joined) return
    const sessionId = sessionRef.current ?? crypto.randomUUID()
    sessionRef.current = sessionId
    isOwnerRef.current = true
    setOptedOut(false)
    setCapture(true, sessionId)
    startRecorder(sessionId)
  }, [joined, setCapture, startRecorder])

  /** Turn note-taking off for the whole huddle. Owner-only in the UI; dropping
   *  the advertised session id is what stops every follower's recorder. */
  const disableCapture = useCallback(() => {
    stopRecorder()
    setCapture(false, null)
    sessionRef.current = null
    isOwnerRef.current = false
  }, [stopRecorder, setCapture])

  /** Exclude (or re-include) only THIS participant's voice. */
  const optOut = useCallback((out: boolean) => {
    setOptedOut(out)
    if (out) {
      stopRecorder()
      // An owner keeps advertising the session — opting out of your own voice
      // is not the same as ending note-taking for everyone.
      setCapture(false, isOwnerRef.current ? sessionRef.current : null)
    }
  }, [stopRecorder, setCapture])

  // Follow the room: the owner's session appears → start recording into it
  // (unless opted out); the session vanishes → stop. Followers advertise only
  // their own capturing flag, never the session id.
  useEffect(() => {
    if (!joined) return
    if (roomSession && !optedOut && !recorderRef.current) {
      sessionRef.current = roomSession
      startRecorder(roomSession)
      if (!isOwnerRef.current) setCapture(true, null)
    } else if (!roomSession && !isOwnerRef.current && recorderRef.current) {
      stopRecorder()
      setCapture(false, null)
    }
  }, [joined, roomSession, optedOut, startRecorder, stopRecorder, setCapture])

  const requestSummary = useCallback(async (sessionId: string) => {
    setSummarizing(true)
    try {
      const res = await fetch(`/api/flows/${flowId}/huddle/summary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      const data = await res.json().catch(() => null)
      if (res.ok && data?.note) setLatestNote(data.note as HuddleNoteRecord)
    } catch { /* the retention cron sweeps whatever this leaves behind */
    } finally {
      setSummarizing(false)
    }
  }, [flowId])

  // Leaving the huddle: flush the recorder, and if we're the last one out,
  // trigger the summary. Erring towards calling it is safe — the endpoint is
  // idempotent and its unique constraint settles the two-last-leavers race.
  const prevJoined = useRef(joined)
  useEffect(() => {
    if (prevJoined.current && !joined) {
      const sessionId = sessionRef.current
      stopRecorder()
      setCapture(false, null)
      sessionRef.current = null
      isOwnerRef.current = false
      if (shouldSummarize(sessionId, others)) void requestSummary(sessionId!)
    }
    prevJoined.current = joined
  }, [joined, others, stopRecorder, setCapture, requestSummary])

  return {
    /** Note-taking is live in this huddle (whoever enabled it). */
    captureLive: Boolean(roomSession) || selfCapturing,
    /** This client's own mic is currently recorded. */
    selfCapturing,
    /** Whether we minted the session — the whole-huddle off switch is ours. */
    isOwner: isOwnerRef.current,
    optedOut,
    uploadWarning,
    summarizing,
    latestNote,
    enableCapture,
    disableCapture,
    optOut,
    clearUploadWarning: () => setUploadWarning(false),
  }
}
