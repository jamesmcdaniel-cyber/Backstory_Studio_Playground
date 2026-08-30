'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useReducedMotion } from 'motion/react'
import { indentOnTab } from '@/components/ui/textarea'
import Link from 'next/link'
import { ArrowUp, BookOpen, Bot, ChevronRight, Clock, ExternalLink, FileText, History, Loader2, PenSquare, RotateCcw, Sparkles, Trash2, Workflow } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/settings/dialogs'
import { Markdown } from '@/components/ui/markdown'
import { Skeleton } from '@/components/ui/skeleton'
import { RecentFlows } from '@/components/dashboard/recent-flows'
import { relativeTime } from '@/lib/relative-time'

/**
 * The Assistant home.
 *
 * The wider of the two tiers over one shared brain — it answers the go-to-market
 * work Backstory automates as well as questions about the product — and it
 * shares more than the brain with the corner widget: both write into the same
 * per-user conversation store, so a thread opened here is readable from the
 * widget and a deletion in either place is a deletion in both.
 *
 * The turns belong to the server. This page sends a thread id and nothing about
 * what was said in it; the alternative it replaced let a caller narrate the
 * conversation back, assistant turns included, with nothing behind the claim.
 */

type LibrarianResult = {
  /**
   * `doc` is a help-centre article (an external link) and `page` is a surface of
   * the product itself; the rest are workspace items.
   */
  type: 'agent' | 'flow' | 'template' | 'run' | 'doc' | 'page'
  id: string
  title: string
  subtitle: string
  href: string
}
/** An external page the answer was written from — always a real, retrieved URL. */
type LibrarianSource = { title: string; url: string; label: string }
type Turn = { question: string; answer: string; results: LibrarianResult[]; sources: LibrarianSource[] }
/** A past thread as the history list shows it — never its contents. */
type SessionSummary = { id: string; title: string; updatedAt: string; messageCount: number }
/** What a destructive confirmation is being asked about. */
type Pending = { kind: 'one'; id: string; title: string } | { kind: 'all'; count: number }

// Openers that show what the Assistant reaches across — the library (templates),
// the connected data (MCP), and the skills layer — rather than five variations
// on "how do I".
const SUGGESTIONS = [
  'Help me create a meeting brief workflow',
  'Show me what I can automate with my integrations',
  'Find the best skill for an account plan',
]

const RESULT_ICON = { flow: Workflow, agent: Bot, template: FileText, run: History, doc: BookOpen, page: ChevronRight }

function greeting(): string {
  const h = new Date().getHours()
  return h < 12 ? 'GOOD MORNING' : h < 18 ? 'GOOD AFTERNOON' : 'GOOD EVENING'
}

/**
 * Stored rows folded back into the exchanges this page draws.
 *
 * Shape-checked rather than trusted, because a malformed row would throw inside
 * the render and lose the whole conversation to save one turn of it. A stray
 * assistant row opens a turn of its own: the thread route returns the LAST
 * hundred messages, so a long conversation can begin on an answer whose
 * question fell off the top, and showing that answer under a blank question is
 * better than dropping something that was said.
 */
function foldTurns(messages: unknown): Turn[] {
  if (!Array.isArray(messages)) return []
  const turns: Turn[] = []
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const row = message as { role?: unknown; content?: unknown; results?: unknown; sources?: unknown }
    if (typeof row.content !== 'string') continue
    const results = Array.isArray(row.results) ? (row.results as LibrarianResult[]) : []
    const sources = Array.isArray(row.sources) ? (row.sources as LibrarianSource[]) : []
    const last = turns[turns.length - 1]
    if (row.role === 'assistant' && last && !last.answer) {
      last.answer = row.content
      last.results = results
      last.sources = sources
    } else if (row.role === 'assistant') {
      turns.push({ question: '', answer: row.content, results, sources })
    } else {
      turns.push({ question: row.content, answer: '', results: [], sources: [] })
    }
  }
  return turns
}

export default function AssistantHome() {
  const reduced = useReducedMotion()
  const [input, setInput] = useState('')
  // The thread being continued. null is a conversation that has not been opened
  // yet, not an error — the first answer names the one it created.
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [thread, setThread] = useState<Turn[]>([])
  const [restore, setRestore] = useState<'idle' | 'loading' | 'failed'>('idle')
  const [busy, setBusy] = useState(false)
  // A failed question stays on screen with a retry, instead of vanishing into a toast.
  const [failure, setFailure] = useState<{ question: string; message: string } | null>(null)
  const [hello, setHello] = useState('GOOD MORNING')
  const [historyOpen, setHistoryOpen] = useState(false)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [sessionsState, setSessionsState] = useState<'idle' | 'loading' | 'failed'>('idle')
  const [pending, setPending] = useState<Pending | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const threadEndRef = useRef<HTMLDivElement>(null)
  const historyRef = useRef<HTMLDivElement>(null)
  // Bumped whenever this page changes which conversation it is showing, so an
  // answer or a restore still in flight can't land in the one that replaced it.
  const threadSeq = useRef(0)

  // Compute the time-of-day greeting on the client to avoid an SSR mismatch.
  useEffect(() => setHello(greeting()), [])
  useEffect(() => { threadEndRef.current?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' }) }, [thread, busy, restore, reduced])

  // Grows with the content; the CSS min-height keeps the empty composer tall.
  const grow = (el: HTMLTextAreaElement) => { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 240)}px` }
  const resetComposer = () => { if (textareaRef.current) textareaRef.current.style.height = '' }

  /**
   * Point the page at a thread, or at none at all, and load what is in it.
   *
   * Unlike the corner widget, this surface deliberately remembers nothing across
   * a reload: the home's job before a question is asked is to be a landing
   * surface — composer in the middle, recent flows underneath — and restoring
   * yesterday's half-answer over that would cost the page its purpose. The
   * conversation is not lost, it is one click away in the history list, which is
   * the whole reason server-side threads are worth having.
   */
  const openSession = useCallback(async (id: string | null) => {
    const seq = ++threadSeq.current
    setSessionId(id)
    setThread([])
    setInput('')
    setBusy(false)
    setFailure(null)
    resetComposer()
    if (!id) {
      setRestore('idle')
      return
    }
    setRestore('loading')
    try {
      const res = await fetch(`/api/librarian/sessions/${encodeURIComponent(id)}`, { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (seq !== threadSeq.current) return
      if (!res.ok) {
        setRestore('failed')
        return
      }
      // A thread that is gone answers with a null session rather than an error —
      // it may have been deleted in the corner widget, or in another tab. The
      // whole handling is to let go of the id, so the next question opens a new
      // thread instead of naming one the server ignores.
      if (!data.session) {
        setSessionId(null)
        setRestore('idle')
        return
      }
      setThread(foldTurns(data.messages))
      setRestore('idle')
    } catch {
      if (seq === threadSeq.current) setRestore('failed')
    }
  }, [])

  const loadSessions = useCallback(async () => {
    setSessionsState('loading')
    try {
      const res = await fetch('/api/librarian/sessions', { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setSessionsState('failed')
        return
      }
      setSessions(Array.isArray(data.sessions) ? (data.sessions as SessionSummary[]) : [])
      setSessionsState('idle')
    } catch {
      setSessionsState('failed')
    }
  }, [])

  // Close the history dropdown on an outside click — but not while a
  // confirmation is up, since that dialog is portalled to the body and every
  // press inside it reads as "outside" from here, which would close the list
  // the user is deleting from.
  useEffect(() => {
    if (!historyOpen || pending) return
    const onPointerDown = (event: PointerEvent) => {
      if (!historyRef.current?.contains(event.target as Node)) setHistoryOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setHistoryOpen(false) }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [historyOpen, pending])

  const ask = async (question: string) => {
    const q = question.trim()
    if (!q || busy) return
    const seq = threadSeq.current
    setInput('')
    resetComposer()
    setFailure(null)
    setBusy(true)
    try {
      const res = await fetch('/api/librarian', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: q,
          // Which conversation this belongs to, and nothing about what was said
          // in it: the server reads the earlier turns off this id. The
          // `history` array that used to travel here is now a 400, because a
          // conversation the caller narrates is one in which the caller writes
          // the assistant's turns. Omitted entirely on a first question, which
          // is how a new thread is opened.
          ...(sessionId ? { sessionId } : {}),
          path: '/dashboard',
          // The wider tier: this surface also answers the go-to-market work
          // Backstory automates, not just questions about the product.
          mode: 'assistant',
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (seq !== threadSeq.current) return // the user started or opened another chat meanwhile
      if (!res.ok) { setFailure({ question: q, message: data.error || 'The Assistant couldn’t answer that.' }); return }
      // The thread this answer landed in — the same one on a follow-up, a fresh
      // one when this question opened the conversation.
      if (typeof data.sessionId === 'string') setSessionId(data.sessionId)
      setThread((prev) => [...prev, { question: q, answer: data.answer ?? '', results: data.results ?? [], sources: data.sources ?? [] }])
    } catch {
      if (seq === threadSeq.current) setFailure({ question: q, message: 'Could not reach the Assistant. Check your connection and try again.' })
    } finally {
      if (seq === threadSeq.current) setBusy(false)
    }
  }

  const startNewChat = () => {
    setHistoryOpen(false)
    void openSession(null)
    textareaRef.current?.focus()
  }

  const confirmDelete = async () => {
    if (!pending || deleting) return
    setDeleting(true)
    setDeleteError(null)
    try {
      const res = await fetch(
        pending.kind === 'all' ? '/api/librarian/sessions' : `/api/librarian/sessions/${encodeURIComponent(pending.id)}`,
        { method: 'DELETE' },
      )
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setDeleteError(data.error || 'Could not delete that conversation. Try again.')
        return
      }
      // The thread on screen may be one of the rows that just went. Clearing it
      // here is not cosmetic: an answer still readable under a conversation the
      // user has just deleted is the deletion failing in the only place they can
      // check it.
      if (pending.kind === 'all' || pending.id === sessionId) void openSession(null)
      setPending(null)
      await loadSessions()
    } catch {
      setDeleteError('Could not reach the Assistant. Check your connection and try again.')
    } finally {
      setDeleting(false)
    }
  }

  // Before the first question this is a landing surface, so the composer sits in
  // the middle of the screen rather than pinned under the header with the rest
  // of the viewport empty. Once a conversation exists the content has to grow
  // downward, so it goes back to top-aligned.
  const started = thread.length > 0 || busy || failure !== null || restore !== 'idle' || sessionId !== null

  return (
    <div
      className={cn(
        // Width + gutters come from the shell's PAGE_CONTAINER; this only sets
        // the vertical rhythm the two states need.
        'relative flex w-full flex-col pb-24',
        started ? 'pt-4 sm:pt-8' : 'min-h-[68dvh] justify-center',
      )}
    >
      <div className="mb-8 flex items-center justify-between gap-4">
        <p className="font-mono text-xs tracking-[0.2em] text-gray-500">
          <span className="text-horizon-500">{'///'}</span> {hello}
        </p>
        {/* Past threads and a fresh one. The history list is what makes the
            server-side store visible: it is the only way back into a
            conversation once this page has returned to its landing state. */}
        <div className="relative flex shrink-0 items-center gap-2" ref={historyRef}>
          <button
            type="button"
            onClick={() => {
              const next = !historyOpen
              setHistoryOpen(next)
              if (next) void loadSessions()
            }}
            aria-expanded={historyOpen}
            className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3.5 py-2 font-mono text-xs uppercase tracking-wider text-gray-500 shadow-1 transition-colors hover:border-horizon-200 hover:text-horizon-700"
          >
            <Clock className="h-3.5 w-3.5" aria-hidden="true" /> History
          </button>
          {started && (
            <button
              type="button"
              onClick={startNewChat}
              className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3.5 py-2 font-mono text-xs uppercase tracking-wider text-gray-500 shadow-1 transition-colors hover:border-horizon-200 hover:text-horizon-700"
            >
              <PenSquare className="h-3.5 w-3.5" aria-hidden="true" /> New chat
            </button>
          )}

          {historyOpen && (
            <div className="absolute right-0 top-full z-30 mt-2 w-[min(22rem,calc(100vw-3rem))] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-4">
              <p className="px-3 pb-1 pt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-fg-muted">
                Your conversations
              </p>

              {sessionsState === 'loading' && (
                <p className="flex items-center gap-2 px-3 pb-3 pt-2 text-sm text-fg-muted">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Loading…
                </p>
              )}

              {sessionsState === 'failed' && (
                <div className="space-y-2 px-3 pb-3 pt-2">
                  <p className="text-sm text-gray-600">Couldn’t load your conversations.</p>
                  <Button size="sm" variant="outline" onClick={() => void loadSessions()}>
                    <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> Try again
                  </Button>
                </div>
              )}

              {sessionsState === 'idle' && sessions.length === 0 && (
                <p className="px-3 pb-3 pt-2 text-sm leading-relaxed text-gray-600">
                  Nothing here yet. Every question you ask — here or from the corner helper — is kept, so you can
                  pick a conversation back up later.
                </p>
              )}

              {sessionsState === 'idle' && sessions.length > 0 && (
                <ul className="max-h-80 overflow-y-auto px-1.5 pb-1.5">
                  {sessions.map((session) => (
                    <li key={session.id} className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => { setHistoryOpen(false); void openSession(session.id) }}
                        aria-current={session.id === sessionId ? 'true' : undefined}
                        className={cn(
                          'flex min-w-0 flex-1 flex-col rounded-lg px-2 py-2 text-left transition-colors hover:bg-gray-100',
                          session.id === sessionId && 'bg-gray-100',
                        )}
                      >
                        <span className="w-full truncate text-sm text-gray-900">{session.title}</span>
                        <span className="w-full truncate font-mono text-[10px] uppercase tracking-[0.14em] text-fg-muted">
                          {relativeTime(session.updatedAt)} · {session.messageCount} message{session.messageCount === 1 ? '' : 's'}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => { setDeleteError(null); setPending({ kind: 'one', id: session.id, title: session.title }) }}
                        // Named, not just iconic: a screen reader on a column of
                        // identical "Delete" buttons cannot tell which
                        // conversation it is about to destroy.
                        aria-label={`Delete conversation: ${session.title}`}
                        className="shrink-0 rounded-md p-1.5 text-fg-muted transition-colors hover:bg-red-50 hover:text-red-700"
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {sessionsState === 'idle' && sessions.length > 0 && (
                <div className="border-t border-gray-100 p-2">
                  <button
                    type="button"
                    onClick={() => { setDeleteError(null); setPending({ kind: 'all', count: sessions.length }) }}
                    className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-2 text-[13px] font-medium text-red-700 transition-colors hover:bg-red-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Delete all conversations
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Composer — prompt, attach, send */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-2 transition-[border-color,box-shadow,transform] duration-base focus-within:-translate-y-0.5 focus-within:border-horizon-400 focus-within:shadow-4 focus-within:ring-4 focus-within:ring-horizon-500/10">
        <div className="px-6 pt-6">
          <textarea
            ref={textareaRef}
            value={input}
            rows={1}
            onChange={(e) => { setInput(e.target.value); grow(e.target) }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(input) } else indentOnTab(e) }}
            placeholder="Ask the Assistant about the library, setup, or a goal…"
            aria-label="Ask the Assistant"
            className="min-h-[3.5rem] w-full resize-none bg-transparent text-xl leading-8 text-gray-900 outline-none placeholder:text-fg-muted"
          />
        </div>

        <div className="flex items-center justify-end px-5 py-3.5">
          <button
            type="button"
            onClick={() => void ask(input)}
            disabled={!input.trim() || busy}
            className={cn(
              'flex h-10 w-10 items-center justify-center rounded-full text-white transition-colors',
              input.trim() && !busy ? 'bg-horizon-600 hover:bg-horizon-700' : 'bg-gray-300',
            )}
            aria-label="Send"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}
          </button>
        </div>

      </div>

      {/* Suggestion chips (empty state only). One row on a wide screen, spread
          edge to edge under the composer; they wrap only when it gets narrow. */}
      {!started && (
        <>
          <div className="mt-5 flex flex-wrap gap-3 lg:flex-nowrap lg:justify-between">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => void ask(s)}
                className="whitespace-nowrap rounded-full border border-gray-200 bg-white px-4 py-2.5 font-mono text-sm text-gray-600 shadow-1 transition-[transform,border-color,box-shadow,color] duration-base hover:-translate-y-0.5 hover:border-horizon-200 hover:text-horizon-700 hover:shadow-2 active:translate-y-0"
              >
                {s}
              </button>
            ))}
          </div>
          {/* Straight back into the canvas of whatever you were last editing —
              the landing state's other job besides answering a question. */}
          <RecentFlows />
        </>
      )}

      {/* Conversation */}
      {started && (
        <div className="mt-8 space-y-8" role="log" aria-live="polite" aria-relevant="additions" aria-busy={busy || restore === 'loading'}>
          {restore === 'loading' && (
            <p className="flex items-center gap-2 text-sm text-fg-muted">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Opening that conversation…
            </p>
          )}
          {restore === 'failed' && (
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <p className="text-sm font-medium text-gray-900">Couldn’t reopen that conversation.</p>
              <Button size="sm" variant="outline" className="mt-3" onClick={() => void openSession(sessionId)}>
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> Try again
              </Button>
            </div>
          )}
          {/* A restored turn renders through exactly this — same cards, same
              citations — because the route hands back the links it resolved
              when it answered rather than links a later reader would guess at. */}
          {thread.map((turn, i) => (
            <div key={i} className="space-y-3">
              {turn.question && <p className="text-right text-sm font-medium text-gray-900">{turn.question}</p>}
              <div className="rounded-xl border bg-white p-4 shadow-2 animate-fade-in-up">
                <div className="flex items-center gap-1.5 text-xs font-medium text-horizon-600">
                  <Sparkles className="h-3.5 w-3.5" /> Assistant
                </div>
                <div className="mt-2 text-sm leading-6 text-gray-700">
                  <Markdown>{turn.answer}</Markdown>
                </div>
                {turn.results.length > 0 && (
                  <div className="mt-4 grid gap-2 sm:grid-cols-2">
                    {turn.results.map((r) => {
                      const Icon = RESULT_ICON[r.type] ?? FileText
                      // Help-centre articles leave the app, so they open in a new
                      // tab and say so rather than dropping the user out of a chat.
                      const external = r.type === 'doc'
                      return (
                        <Link
                          key={`${r.type}-${r.id}`}
                          href={r.href}
                          {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                          className="flex items-center gap-3 rounded-lg border p-3 transition-colors hover:border-horizon-300 hover:bg-gray-50"
                        >
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-gray-100 text-gray-500">
                            <Icon className="h-4 w-4" />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm font-medium text-gray-900">{r.title}</span>
                            <span className="block truncate text-xs text-fg-muted">{r.subtitle}</span>
                          </span>
                          {external && <ExternalLink aria-label="Opens in a new tab" className="h-3.5 w-3.5 shrink-0 text-fg-muted" />}
                        </Link>
                      )
                    })}
                  </div>
                )}
                {/* Where the answer came from. Every URL here was fetched while
                    answering, so it is safe to show in full — the point is that
                    the reader can go and check it. */}
                {turn.sources.length > 0 && (
                  <div className="mt-4 border-t border-gray-100 pt-3">
                    <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-fg-muted">Sources</p>
                    <ol className="mt-2 space-y-2">
                      {turn.sources.map((s, n) => (
                        <li key={`${s.url}-${n}`} className="flex gap-2">
                          <span className="mt-0.5 shrink-0 font-mono text-[11px] text-gray-300">{n + 1}</span>
                          <span className="min-w-0">
                            <a
                              href={s.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs font-medium text-gray-700 underline decoration-gray-300 underline-offset-2 transition-colors hover:text-horizon-700 hover:decoration-horizon-400"
                            >
                              {s.title}
                            </a>
                            <span className="ml-1.5 text-[11px] text-fg-muted">{s.label}</span>
                            <a
                              href={s.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="block truncate font-mono text-[11px] text-fg-muted transition-colors hover:text-horizon-600"
                            >
                              {s.url}
                            </a>
                          </span>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </div>
            </div>
          ))}
          {failure && !busy && (
            <div className="space-y-3 animate-fade-in">
              <p className="text-right text-sm font-medium text-gray-900">{failure.question}</p>
              <div className="rounded-xl border border-red-200 bg-red-50/60 p-4">
                <p className="text-sm font-medium text-red-800">{failure.message}</p>
                <Button size="sm" variant="outline" className="mt-3 bg-white" onClick={() => void ask(failure.question)}>
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> Try again
                </Button>
              </div>
            </div>
          )}
          {busy && (
            // Shaped like the answer card it becomes, so the reply lands without a jump.
            <div className="rounded-xl border bg-white p-4 shadow-2 animate-fade-in-up">
              <div className="flex items-center gap-1.5 text-xs font-medium text-horizon-600">
                <Sparkles className="h-3.5 w-3.5" /> Assistant
              </div>
              <p className="mt-2 text-sm text-fg-muted">Searching your library…</p>
              <div className="mt-3 space-y-2">
                <Skeleton className="h-3.5 w-full rounded" />
                <Skeleton className="h-3.5 w-11/12 rounded" />
                <Skeleton className="h-3.5 w-3/5 rounded" />
              </div>
            </div>
          )}
          <div ref={threadEndRef} />
        </div>
      )}

      {/* Deleting removes rows, everywhere, for good — so it is confirmed the
          way every other irreversible action in this product is, through the
          shared dialog that names what goes, rather than through a
          window.confirm a browser lets the user switch off for the session. */}
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(next) => {
          if (next || deleting) return
          setPending(null)
          setDeleteError(null)
        }}
        title={pending?.kind === 'all' ? 'Delete every conversation?' : 'Delete this conversation?'}
        description={
          pending === null ? null : pending.kind === 'all' ? (
            <>
              All {pending.count} of your saved conversations — asked here and from the corner helper — are deleted
              everywhere you are signed in, along with every question and answer in them. This cannot be undone.
            </>
          ) : (
            <>
              “{pending.title}” and every question and answer in it are deleted everywhere you are signed in.
              This cannot be undone.
            </>
          )
        }
        confirmLabel={pending?.kind === 'all' ? 'Delete all' : 'Delete conversation'}
        destructive
        busy={deleting}
        onConfirm={confirmDelete}
      >
        {deleteError && <p className="text-sm text-red-700">{deleteError}</p>}
      </ConfirmDialog>
    </div>
  )
}
