# Huddle Notes — Consent, Capture, and Summary (Phase 1)

**Date:** 2026-08-01
**Status:** Approved (design) — pending implementation plan
**Owner:** James McDaniel
**Predecessors:** the huddle TURN/recovery, awareness, and audio-controls specs.

## Problem

People discuss a flow out loud and nothing survives the call. The product
already ingests meeting transcripts from Granola, so transcript-shaped data is
familiar — but a huddle held inside the builder, about the flow on screen,
produces nothing.

## Scope

This is **Phase 1 of two**. It delivers consent, capture, transcription, and a
summary attached to the flow. **Phase 2** — turning the transcript into
reviewable `CopilotOp`s — is a separate spec, because Phase 1 is useful on its
own ("we talked about this flow, here are the notes") and Phase 2 is a thin
layer over the copilot pipeline that already exists.

## Decisions

| Area | Decision | Why |
|---|---|---|
| When | **After the huddle, not live** | Latency stops mattering, so transcription can be batch and high quality; there is a natural review moment; a bad transcript yields a note you ignore, not a live edit to undo. |
| Where audio is captured | **Each client records only its own mic** | The mesh has no SFU, so no central audio exists. Per-client capture also makes speaker attribution free and per-person consent real. |
| Engine | **Server-side transcription (OpenAI `whisper-1`)** | The Web Speech API is Chrome/Edge-only, weaker on domain jargon, and ships audio to Google anyway — so its privacy advantage is illusory. |
| Consent | **Huddle-level opt-in, per-person opt-out, visible indicator** | Someone turns capture on; everyone sees it; anyone can exclude their own voice, and because capture is local that exclusion is real rather than cosmetic. |
| Retention | **Raw segments deleted once summarized; only the summary persists** | The value is the summary. Keeping verbatim recordings of users' colleagues creates a class of problem the feature does not need. |
| Session identity | **Minted by whoever enables capture, published via presence** | Presence already syncs state to late joiners, so a participant arriving mid-huddle picks up the session with no new protocol. |

## Section 1 — Consent and session

Presence (`CollabParticipant`) gains `capturing?: boolean` and
`captureSessionId?: string`. Turning capture on mints a session id
(`crypto.randomUUID()`) and sets both on the enabler's presence; everyone else
reads it from the roster, including people who join later.

While any participant is capturing, every huddle panel shows a persistent
indicator. Each participant has their own switch — default on, one click to
exclude their own voice. A participant who opts out records nothing locally; no
audio leaves their machine.

**Accepted trade:** capture defaults to on for everyone once someone enables it,
with a visible indicator and one-click opt-out (the Zoom/Slack model). The
stricter alternative — each person accepting before their mic is captured — is
more defensible and adds friction to every huddle. Revisit if users object.

## Section 2 — Capture and transcription

`MediaRecorder` on the local stream, emitting a segment **every two minutes**
rather than one blob at the end. Rationale: it bounds memory, stays well under
the existing 10MB upload cap (Opus runs about 180KB/minute, so one blob would
cap out near 50 minutes), and a crashed tab loses two minutes rather than the
whole conversation. A final partial segment flushes when capture stops or the
huddle ends.

`POST /api/flows/[id]/huddle/segment` takes multipart audio plus
`sessionId` and `startedAt`, transcribes it, writes the **text**, and discards
the audio — it is never written to storage. Gated on `flow.read` (anyone who can
be in the huddle can contribute to its notes) and rate-limited per user.

Transcription lives behind an injectable seam so every endpoint test runs
without network access.

## Section 3 — Assembly and summary

`POST /api/flows/[id]/huddle/summary` assembles that session's segments in
timestamp order into a speaker-labelled transcript, calls `generateStructured`
for a summary and decision list, persists a `HuddleNote`, and **deletes the
segments**. Called by the last participant to leave; safe to call twice, because
the second call finds no segments and returns the existing note.

Notes are listed in the Jam dialog, newest first.

## Data model

```
model HuddleSegment {          // transient working state
  id, flowId, organizationId, sessionId, speakerName, text, startedAt, createdAt
  @@index([sessionId, startedAt])
}

model HuddleNote {             // what survives
  id, flowId, organizationId, sessionId @unique, summary, decisions Json,
  participants Json, startedAt, createdAt
}
```

The retention cron sweeps segments older than 24 hours, catching sessions
orphaned by someone closing their laptop mid-huddle.

## Error handling

- One segment failing to transcribe must not lose the huddle: segments are
  independent and the summary is built from whatever arrived.
- If **every** segment failed, the summary endpoint returns a plain "nothing
  was captured" rather than persisting an empty note.
- Upload failures retry once, then drop that segment and warn visibly — silently
  missing two minutes of a conversation is worse than knowing.
- Transcription unavailable (no API key) disables the capture toggle with an
  explanation instead of failing at the end of a call.

## Testing

- **Unit:** transcript assembly (ordering, interleaved speakers, missing
  speaker names, empty input); the summary prompt builder; the consent/session
  reducer.
- **Endpoint:** segment ingest and summary with a stubbed transcriber, including
  the all-segments-failed path and the idempotent second call.
- **Manual, not substitutable:** transcription quality, `MediaRecorder`
  behaviour across browsers, and whether the summary is any good.

## Out of scope

Phase 2 (transcript → reviewable copilot ops); live in-call suggestions;
searchable transcript history; speaker diarization beyond per-client
attribution; SFU migration.
