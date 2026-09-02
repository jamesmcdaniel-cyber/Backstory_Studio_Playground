'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useReducedMotion } from 'motion/react'
import {
  ArrowLeft,
  ArrowUp,
  BookOpen,
  Bot,
  ChevronRight,
  Clock,
  ExternalLink,
  FileText,
  History,
  Loader2,
  MessageCircleQuestion,
  PenSquare,
  RotateCcw,
  Sparkles,
  Trash2,
  Workflow,
  X,
} from 'lucide-react'
import { indentOnTab } from '@/components/ui/textarea'
import { Markdown } from '@/components/ui/markdown'
import { ConfirmDialog } from '@/components/settings/dialogs'
import { useDismissOnOutsidePointer } from '@/hooks/use-dismiss-on-outside-pointer'
import { shouldOfferLauncher, useAssistantSurfaceVisible } from '@/components/assistant/assistant-surface'
import { surfaceForPath } from '@/lib/librarian/surfaces'
import { relativeTime } from '@/lib/relative-time'
import { cn } from '@/lib/utils'

/**
 * Ask Backstory — the help assistant that follows the user around the product.
 *
 * Mounted once by the app shell (src/components/layout/app-shell.tsx), which
 * itself never remounts, so the conversation SURVIVES navigation: a user can
 * ask "where do I connect Slack?", click the link in the answer, land on
 * Integrations, and ask the follow-up without having lost the thread. That is
 * the whole point of it living in the shell rather than on a page.
 *
 * It answers through /api/librarian — the same brain as the Assistant home,
 * which already retrieves the help centre, the developer docs and the
 * automation library, and already resolves every link it shows back to a URL
 * the server fetched. What this widget adds is the page the question was asked
 * from, so "why did this fail?" has a referent.
 *
 * The conversation itself belongs to the server. This panel holds a thread id
 * and asks for the turns; it never narrates the earlier ones back, because a
 * history the CALLER writes is a history in which the caller can author the
 * assistant's own turns, and the prompt had no way to tell an exchange that
 * happened from one that was invented. The dividend is the part a user can
 * see: a thread outlives a reload, stays reachable from the history list days
 * later, and deleting one deletes rows rather than emptying an array in a
 * single tab.
 */

type Result = {
  /** `doc` is an external article and `page` is a surface of the product itself. */
  type: 'agent' | 'flow' | 'template' | 'run' | 'doc' | 'page'
  id: string
  title: string
  subtitle: string
  href: string
}
type Source = { title: string; url: string; label: string }
type Turn = { question: string; answer: string; results: Result[]; sources: Source[] }
/** A thread as the history list shows it — never its contents. */
type SessionSummary = { id: string; title: string; updatedAt: string; messageCount: number }
/** What a destructive confirmation is being asked about. */
type Pending = { kind: 'one'; id: string; title: string } | { kind: 'all' }

const RESULT_ICON = {
  flow: Workflow,
  agent: Bot,
  template: FileText,
  run: History,
  doc: BookOpen,
  page: ChevronRight,
}

/**
 * The only two things this widget stores: which thread is open, and whether the
 * panel is open. Not the turns — those are the server's, which is what lets
 * "delete" mean the rows are gone rather than that one tab stopped showing them.
 *
 * sessionStorage rather than localStorage, and that reasoning survives
 * persistence unchanged: a help thread is about what the user is doing right
 * now, and reopening the widget tomorrow onto yesterday's half-answer would be
 * clutter, not continuity. Per-tab is still the right scope too — two tabs on
 * two parts of the product are two separate questions, and a pointer shared
 * between them would drag one tab's thread into the other's. Nothing is lost
 * when the pointer is: the conversation is in the history list.
 */
const SESSION_KEY = 'backstory:ask-session'
const OPEN_KEY = 'backstory:ask-open'

/**
 * Where the turns themselves used to be kept, swept on mount.
 *
 * A tab that was open across this change still holds that array, and leaving it
 * behind would leave an unreachable copy of a conversation the user can now
 * delete — which is the one claim this whole change exists to make true.
 */
const LEGACY_THREAD_KEY = 'backstory:ask-thread'

/**
 * Server rows folded back into the exchanges this panel draws.
 *
 * Shape-checked rather than trusted, for the same reason the sessionStorage
 * read was: a malformed turn would throw inside the render, and half a
 * conversation on screen beats a blank panel.
 *
 * A stray assistant row opens a turn of its own instead of being dropped. The
 * thread route returns the LAST hundred messages, so a long conversation can
 * begin on an answer whose question fell off the top — and a conversation that
 * silently omits what was said is worse than one with a visible gap in it.
 */
function foldTurns(messages: unknown): Turn[] {
  if (!Array.isArray(messages)) return []
  const turns: Turn[] = []
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const row = message as { role?: unknown; content?: unknown; results?: unknown; sources?: unknown }
    if (typeof row.content !== 'string') continue
    const results = Array.isArray(row.results) ? (row.results as Result[]) : []
    const sources = Array.isArray(row.sources) ? (row.sources as Source[]) : []
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

/** Openers that show the three things this widget is for: features, trouble, and where things are. */
const GENERIC_SUGGESTIONS = ['What can I build with Flows?', 'Why did my run fail?', 'Where do I connect Slack?']

export function AskBackstory({ raised = false }: {
  /**
   * Lift the launcher and panel clear of a fullscreen canvas's own bottom-right
   * furniture — today the flow builder's minimap, which sits at bottom-6 right-4
   * and is exactly where this would otherwise land.
   */
  raised?: boolean
}) {
  const pathname = usePathname() ?? ''
  const searchParams = useSearchParams()
  const router = useRouter()
  const reduced = useReducedMotion()
  const [open, setOpen] = useState(false)
  // A page-level assistant (the agents Assistant, the flow builder Copilot)
  // puts its own composer in this corner, and the launcher was sitting on
  // top of its text field. Yield the corner — but only when closed, so an
  // conversation the user is mid-way through is never yanked away.
  const surfaceVisible = useAssistantSurfaceVisible()
  // The thread being continued. null is a conversation that has not been
  // started yet, not an error state — the first answer names the one it opened.
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [thread, setThread] = useState<Turn[]>([])
  const [restore, setRestore] = useState<'idle' | 'loading' | 'failed'>('idle')
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  // A failed question stays on screen with a retry, rather than vanishing into
  // a toast the user has already navigated away from.
  const [failure, setFailure] = useState<{ question: string; message: string } | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [sessionsState, setSessionsState] = useState<'idle' | 'loading' | 'failed'>('idle')
  const [pending, setPending] = useState<Pending | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const launcherRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const threadEndRef = useRef<HTMLDivElement>(null)
  // Bumped whenever the panel changes which conversation it is showing, so an
  // answer or a restore still in flight can't land in the one that replaced it.
  const threadSeq = useRef(0)
  // The pointer read out of storage, held back until the panel is actually
  // opened. The shell mounts this widget on EVERY page, and fetching a
  // conversation nobody has asked to look at would spend a round trip per page
  // load on a panel most of them never open.
  const deferredSession = useRef<string | null>(null)

  // The full location, so an answer about "this flow" knows which page asked.
  const currentPath = useMemo(() => {
    const query = searchParams?.toString()
    return query ? `${pathname}?${query}` : pathname
  }, [pathname, searchParams])
  const surface = useMemo(() => surfaceForPath(currentPath), [currentPath])

  /**
   * Move the pointer, in state and in storage together.
   *
   * Written here rather than from an effect on `sessionId`: an effect would
   * also run on the first commit, where the state is still null and the stored
   * value is the one being restored, and it would clear the pointer a moment
   * before reading it.
   */
  const rememberSession = useCallback((id: string | null) => {
    setSessionId(id)
    try {
      if (id) window.sessionStorage.setItem(SESSION_KEY, id)
      else window.sessionStorage.removeItem(SESSION_KEY)
    } catch {
      /* private mode — the pointer just doesn't survive a reload */
    }
  }, [])

  /**
   * Point the panel at a thread, or at none at all, and load what is in it.
   *
   * Every path through here bumps `threadSeq` first. It guarded "New chat"
   * before there were threads to switch between; switching is the same hazard
   * with a slower request behind it, since the restore that populates the new
   * thread and the answer still owed to the old one are both in flight at once.
   */
  const openSession = useCallback(async (id: string | null) => {
    // Reopening the thread already on screen is a no-op, and must stay one
    // while an answer is in flight. Otherwise the seq bump below orphans the
    // pending request and the refetch that replaces the thread runs BEFORE the
    // route has written the turn — so the question the user is waiting on
    // disappears with nothing to show it was ever asked. Tapping the open
    // thread in the history list is a natural thing to do while waiting.
    if (id !== null && id === sessionId) return
    const seq = ++threadSeq.current
    rememberSession(id)
    setThread([])
    setInput('')
    setBusy(false)
    setFailure(null)
    if (!id) {
      setRestore('idle')
      inputRef.current?.focus()
      return
    }
    setRestore('loading')
    try {
      const response = await fetch(`/api/librarian/sessions/${encodeURIComponent(id)}`, { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      if (seq !== threadSeq.current) return
      if (!response.ok) {
        setRestore('failed')
        return
      }
      // A thread that is gone answers with a null session rather than an error:
      // it may have been deleted from another tab, or on another device, and
      // the id may have been sitting in storage for days. Letting go of the
      // pointer is the whole of the handling — holding it would send the next
      // question to an id the server ignores, which starts a new thread anyway
      // but leaves two ids for one conversation.
      if (!data.session) {
        rememberSession(null)
        setRestore('idle')
        return
      }
      setThread(foldTurns(data.messages))
      setRestore('idle')
    } catch {
      if (seq === threadSeq.current) setRestore('failed')
    }
  }, [rememberSession, sessionId])

  const loadSessions = useCallback(async () => {
    setSessionsState('loading')
    try {
      const response = await fetch('/api/librarian/sessions', { cache: 'no-store' })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        setSessionsState('failed')
        return
      }
      setSessions(Array.isArray(data.sessions) ? (data.sessions as SessionSummary[]) : [])
      setSessionsState('idle')
    } catch {
      setSessionsState('failed')
    }
  }, [])

  // Restore on mount only — after that this component owns the state, and the
  // shell keeps it mounted across navigation.
  useEffect(() => {
    try {
      setOpen(window.sessionStorage.getItem(OPEN_KEY) === '1')
      const stored = window.sessionStorage.getItem(SESSION_KEY)
      window.sessionStorage.removeItem(LEGACY_THREAD_KEY)
      if (stored) {
        // Set straight, not through rememberSession: this value came OUT of
        // storage, so writing it back would be a round of I/O to change nothing.
        setSessionId(stored)
        deferredSession.current = stored
      }
    } catch {
      /* private mode — the widget just starts closed on a new thread */
    }
  }, [])

  // The turns arrive the first time someone opens the panel, which is the first
  // moment there is anyone to show them to.
  useEffect(() => {
    if (!open) return
    const deferred = deferredSession.current
    if (!deferred) return
    deferredSession.current = null
    void openSession(deferred)
  }, [open, openSession])

  useEffect(() => {
    try {
      window.sessionStorage.setItem(OPEN_KEY, open ? '1' : '0')
    } catch {
      /* as above */
    }
  }, [open])

  // Closing the helper puts it back on the conversation. The history list is a
  // detour, not a place to be left standing: reopening the corner of the screen
  // should show what was being asked, not a list the user finished with.
  useEffect(() => {
    if (!open) setHistoryOpen(false)
  }, [open])

  useEffect(() => {
    if (!open || historyOpen) return
    inputRef.current?.focus()
  }, [open, historyOpen])

  useEffect(() => {
    if (!open || historyOpen) return
    threadEndRef.current?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' })
  }, [thread, busy, failure, open, historyOpen, restore, reduced])

  // Escape and outside-pointer close it. The launcher counts as inside so its
  // own click toggles rather than being read as an outside dismissal.
  //
  // Suspended while a confirmation is up: that dialog is portalled to the body,
  // so every pointer press in it — and its own Escape — reads as "outside" from
  // here, and the panel would shut underneath the question it just asked.
  useDismissOnOutsidePointer(open && pending === null, () => setOpen(false), [panelRef, launcherRef])

  const ask = useCallback(async (question: string) => {
    const q = question.trim()
    if (!q || busy) return
    const seq = threadSeq.current
    setInput('')
    setFailure(null)
    setBusy(true)
    try {
      const response = await fetch('/api/librarian', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: q,
          // Which conversation this belongs to, and nothing whatsoever about
          // what was said in it. The server reads the earlier turns off this
          // id; the `history` array that used to travel here is now a 400,
          // because a conversation the caller narrates is one an attacker can
          // put words into the assistant's own mouth in. Omitted entirely on
          // the first question, which is how a new thread is opened.
          ...(sessionId ? { sessionId } : {}),
          path: currentPath,
          // The narrower tier: this is the in-product helper, so it stays on
          // Backstory, this workspace, and why a run failed.
          mode: 'helper',
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (seq !== threadSeq.current) return
      if (!response.ok) {
        setFailure({ question: q, message: data.error || 'Ask Backstory couldn’t answer that.' })
        return
      }
      // The thread this answer landed in — the same one on a follow-up, a fresh
      // one when this question opened the conversation. Kept so the next
      // question continues it and a reload can read it back.
      if (typeof data.sessionId === 'string') rememberSession(data.sessionId)
      setThread((prev) => [...prev, {
        question: q,
        answer: data.answer ?? '',
        results: data.results ?? [],
        sources: data.sources ?? [],
      }])
    } catch {
      if (seq === threadSeq.current) {
        setFailure({ question: q, message: 'Could not reach Ask Backstory. Check your connection and try again.' })
      }
    } finally {
      if (seq === threadSeq.current) setBusy(false)
    }
  }, [busy, currentPath, rememberSession, sessionId])

  const startNewChat = () => {
    setHistoryOpen(false)
    void openSession(null)
  }

  const openHistory = () => {
    setHistoryOpen(true)
    void loadSessions()
  }

  const confirmDelete = async () => {
    if (!pending || deleting) return
    setDeleting(true)
    setDeleteError(null)
    try {
      const response = await fetch(
        pending.kind === 'all' ? '/api/librarian/sessions' : `/api/librarian/sessions/${encodeURIComponent(pending.id)}`,
        { method: 'DELETE' },
      )
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        setDeleteError(data.error || 'Could not delete that conversation. Try again.')
        return
      }
      // The thread on screen may be one of the rows that just went. Dropping it
      // here is not cosmetic: an answer left visible under a conversation the
      // user has just deleted is the deletion failing in the only place they
      // can see it.
      if (pending.kind === 'all' || pending.id === sessionId) void openSession(null)
      setPending(null)
      await loadSessions()
    } catch {
      setDeleteError('Could not reach Backstory. Check your connection and try again.')
    } finally {
      setDeleting(false)
    }
  }

  // The first chip is about wherever the user actually is, so the empty state
  // opens on their situation rather than a generic tour.
  const suggestions = surface
    ? [`What can I do on ${surface.title}?`, ...GENERIC_SUGGESTIONS.slice(1)]
    : GENERIC_SUGGESTIONS
  const showEmptyState = thread.length === 0 && !busy && !failure && restore === 'idle'

  return (
    <>
      {open && (
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="false"
          aria-label="Ask Backstory"
          className={cn(
            // Pinned to the viewport, above page content but below dialogs
            // (z-50) so a modal still covers it.
            'fixed bottom-4 right-4 z-40 flex w-[calc(100vw-2rem)] max-w-[400px] flex-col overflow-hidden rounded-2xl border border-graphite-200 bg-white shadow-4',
            // Tall enough to hold a worked answer, never taller than the phone
            // it is on.
            'h-[min(600px,calc(100dvh-2rem))] sm:h-[min(560px,calc(100dvh-8rem))]',
            raised ? 'sm:bottom-[11rem] sm:h-[min(520px,calc(100dvh-13rem))]' : 'sm:bottom-24',
            !reduced && 'animate-fade-in-up',
          )}
        >
          <header className="flex items-center gap-2 border-b border-graphite-200 px-4 py-3">
            {historyOpen ? (
              <button
                type="button"
                onClick={() => setHistoryOpen(false)}
                className="rounded-md p-1.5 text-fg-muted transition-colors hover:bg-graphite-100 hover:text-graphite-900"
                aria-label="Back to the conversation"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            ) : (
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-horizon-50 text-horizon-600">
                <Sparkles className="h-4 w-4" />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-graphite-900">
                {historyOpen ? 'Your conversations' : 'Ask Backstory'}
              </p>
              <p className="truncate font-mono text-[10px] uppercase tracking-[0.14em] text-fg-muted">
                {historyOpen ? 'Saved to your account' : surface ? surface.title : 'Help & navigation'}
              </p>
            </div>
            {!historyOpen && (
              <>
                <button
                  type="button"
                  onClick={openHistory}
                  className="rounded-md p-1.5 text-fg-muted transition-colors hover:bg-graphite-100 hover:text-graphite-900"
                  aria-label="Your conversations"
                  title="Conversations"
                >
                  <Clock className="h-4 w-4" />
                </button>
                {(thread.length > 0 || sessionId !== null) && (
                  <button
                    type="button"
                    onClick={startNewChat}
                    className="rounded-md p-1.5 text-fg-muted transition-colors hover:bg-graphite-100 hover:text-graphite-900"
                    aria-label="Start a new conversation"
                    title="New chat"
                  >
                    <PenSquare className="h-4 w-4" />
                  </button>
                )}
              </>
            )}
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md p-1.5 text-fg-muted transition-colors hover:bg-graphite-100 hover:text-graphite-900"
              aria-label="Close Ask Backstory"
            >
              <X className="h-4 w-4" />
            </button>
          </header>

          {historyOpen ? (
            // The list the pointer in sessionStorage could never offer: threads
            // this user asked from any tab, on any device, reachable again.
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex-1 overflow-y-auto px-2 py-2">
                {sessionsState === 'loading' && (
                  <p className="flex items-center gap-2 px-2 py-3 text-sm text-fg-muted">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading your conversations…
                  </p>
                )}

                {sessionsState === 'failed' && (
                  <div className="space-y-2 px-2 py-3">
                    <p className="text-[13px] text-graphite-700">Couldn’t load your conversations.</p>
                    <button
                      type="button"
                      onClick={() => void loadSessions()}
                      className="inline-flex items-center gap-1.5 rounded-md border border-graphite-200 bg-white px-2.5 py-1.5 text-[12px] font-medium text-graphite-700 transition-colors hover:bg-graphite-50"
                    >
                      <RotateCcw className="h-3.5 w-3.5" /> Try again
                    </button>
                  </div>
                )}

                {sessionsState === 'idle' && sessions.length === 0 && (
                  <p className="px-2 py-3 text-sm leading-relaxed text-graphite-600">
                    Nothing here yet. Every question you ask is kept, so you can pick a conversation back up later.
                  </p>
                )}

                {sessionsState === 'idle' && sessions.length > 0 && (
                  <ul className="space-y-0.5">
                    {sessions.map((session) => (
                      <li key={session.id} className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            setHistoryOpen(false)
                            void openSession(session.id)
                          }}
                          aria-current={session.id === sessionId ? 'true' : undefined}
                          className={cn(
                            'flex min-w-0 flex-1 flex-col rounded-lg px-2 py-2 text-left transition-colors hover:bg-graphite-100',
                            session.id === sessionId && 'bg-graphite-100',
                          )}
                        >
                          <span className="w-full truncate text-[13px] text-graphite-900">{session.title}</span>
                          <span className="w-full truncate font-mono text-[10px] uppercase tracking-[0.14em] text-fg-muted">
                            {relativeTime(session.updatedAt)} · {session.messageCount} message{session.messageCount === 1 ? '' : 's'}
                          </span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setDeleteError(null)
                            setPending({ kind: 'one', id: session.id, title: session.title })
                          }}
                          // Named, not just iconic: a screen reader on a list of
                          // twelve "Delete" buttons cannot tell which thread it
                          // is about to destroy.
                          aria-label={`Delete conversation: ${session.title}`}
                          className="shrink-0 rounded-md p-1.5 text-fg-muted transition-colors hover:bg-red-50 hover:text-red-700"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {sessionsState === 'idle' && sessions.length > 0 && (
                <div className="border-t border-graphite-200 p-3">
                  <button
                    type="button"
                    onClick={() => {
                      setDeleteError(null)
                      setPending({ kind: 'all' })
                    }}
                    className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-2 text-[13px] font-medium text-red-700 transition-colors hover:bg-red-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" /> Delete all conversations
                  </button>
                </div>
              )}
            </div>
          ) : (
            <>
              <div
                className="flex-1 space-y-4 overflow-y-auto px-4 py-4"
                role="log"
                aria-live="polite"
                aria-relevant="additions"
                aria-busy={busy || restore === 'loading'}
              >
                {restore === 'loading' && (
                  <p className="flex items-center gap-2 text-sm text-fg-muted">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Opening that conversation…
                  </p>
                )}

                {restore === 'failed' && (
                  <div className="space-y-2 rounded-lg border border-graphite-200 bg-graphite-50 p-3">
                    <p className="text-[13px] text-graphite-700">Couldn’t reopen that conversation.</p>
                    <button
                      type="button"
                      onClick={() => void openSession(sessionId)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-graphite-200 bg-white px-2.5 py-1.5 text-[12px] font-medium text-graphite-700 transition-colors hover:bg-graphite-100"
                    >
                      <RotateCcw className="h-3.5 w-3.5" /> Try again
                    </button>
                  </div>
                )}

                {showEmptyState && (
                  <div className="space-y-4">
                    <p className="text-sm leading-relaxed text-graphite-600">
                      Ask about a feature, get unstuck on something that isn’t working, or find the page you need.
                      {surface && <> You’re on <span className="font-medium text-graphite-900">{surface.title}</span>.</>}
                    </p>
                    <div className="flex flex-col gap-2">
                      {suggestions.map((suggestion) => (
                        <button
                          key={suggestion}
                          type="button"
                          onClick={() => void ask(suggestion)}
                          className="rounded-lg border border-graphite-200 bg-white px-3 py-2 text-left text-sm text-graphite-700 shadow-1 transition-colors hover:border-horizon-200 hover:text-horizon-700"
                        >
                          {suggestion}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* A restored turn renders through exactly this — same cards,
                    same citations — because the route hands back the links it
                    resolved when it answered rather than links a later reader
                    would have to guess at. */}
                {thread.map((turn, index) => (
                  <div key={index} className="space-y-3">
                    {turn.question && (
                      <div className="flex justify-end">
                        <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-graphite-100 px-3 py-2 text-sm text-graphite-900">
                          {turn.question}
                        </p>
                      </div>
                    )}
                    <div className="space-y-3">
                      <Markdown className="text-sm leading-relaxed text-graphite-700">{turn.answer}</Markdown>
                      {turn.results.length > 0 && (
                        <div className="space-y-1.5">
                          {turn.results.map((result) => {
                            const Icon = RESULT_ICON[result.type] ?? FileText
                            // A help-centre article leaves the app, so it opens in a
                            // new tab and says so rather than dropping the reader
                            // out of the conversation they are having.
                            const external = result.type === 'doc'
                            return (
                              <Link
                                key={`${result.type}-${result.id}`}
                                href={result.href}
                                {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                                // An in-app link navigates the page behind the
                                // panel and closes it, putting the user on the page
                                // they asked to be taken to with the thread intact
                                // one click away.
                                //
                                // Pushed explicitly rather than left to <Link>'s own
                                // handler: closing the panel unmounts this anchor in
                                // the same click, and the navigation was being lost
                                // with it — verified in a browser, the panel shut
                                // and the route never changed. The href stays for
                                // middle-click, copy-link, and prefetch.
                                onClick={(event) => {
                                  if (external) return
                                  event.preventDefault()
                                  setOpen(false)
                                  router.push(result.href)
                                }}
                                className="flex items-center gap-2.5 rounded-lg border border-graphite-200 bg-white p-2.5 transition-colors hover:border-horizon-300 hover:bg-graphite-50"
                              >
                                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-graphite-100 text-graphite-500">
                                  <Icon className="h-3.5 w-3.5" />
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-[13px] font-medium text-graphite-900">
                                    {result.type === 'page' ? `Go to ${result.title}` : result.title}
                                  </span>
                                  <span className="block truncate text-[11px] text-fg-muted">{result.subtitle}</span>
                                </span>
                                {external && <ExternalLink aria-label="Opens in a new tab" className="h-3.5 w-3.5 shrink-0 text-fg-muted" />}
                              </Link>
                            )
                          })}
                        </div>
                      )}
                      {turn.sources.length > 0 && (
                        <div className="border-t border-graphite-100 pt-2.5">
                          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-fg-muted">Sources</p>
                          <ul className="mt-1.5 space-y-1">
                            {turn.sources.map((source) => (
                              <li key={source.url}>
                                <a
                                  href={source.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="inline-flex items-center gap-1 text-[11px] text-horizon-600 hover:underline"
                                >
                                  {source.title}
                                  <ExternalLink aria-label="Opens in a new tab" className="h-3 w-3 shrink-0" />
                                </a>
                                <span className="ml-1 text-[11px] text-fg-muted">· {source.label}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  </div>
                ))}

                {busy && (
                  <p className="flex items-center gap-2 text-sm text-fg-muted">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Looking it up…
                  </p>
                )}

                {failure && (
                  <div className="space-y-2 rounded-lg border border-red-200 bg-red-50 p-3">
                    <p className="text-[13px] text-red-800">{failure.message}</p>
                    <button
                      type="button"
                      onClick={() => void ask(failure.question)}
                      className="inline-flex items-center gap-1.5 rounded-md border border-red-300 bg-white px-2.5 py-1.5 text-[12px] font-medium text-red-800 transition-colors hover:bg-red-100"
                    >
                      <RotateCcw className="h-3.5 w-3.5" /> Try again
                    </button>
                  </div>
                )}
                <div ref={threadEndRef} />
              </div>

              <div className="border-t border-graphite-200 p-3">
                <div className="flex items-end gap-2 rounded-xl border border-graphite-200 bg-white px-3 py-2 transition-colors focus-within:border-horizon-400 focus-within:ring-2 focus-within:ring-horizon-500/10">
                  <textarea
                    ref={inputRef}
                    rows={1}
                    value={input}
                    onChange={(event) => {
                      setInput(event.target.value)
                      event.target.style.height = 'auto'
                      event.target.style.height = `${Math.min(event.target.scrollHeight, 120)}px`
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault()
                        void ask(input)
                        if (inputRef.current) inputRef.current.style.height = ''
                      } else {
                        indentOnTab(event)
                      }
                    }}
                    placeholder={thread.length ? 'Ask a follow-up…' : 'Ask about Backstory…'}
                    aria-label="Ask Backstory a question"
                    className="max-h-[120px] min-h-[24px] w-full flex-1 resize-none bg-transparent text-sm leading-6 text-graphite-900 outline-none placeholder:text-fg-muted"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      void ask(input)
                      if (inputRef.current) inputRef.current.style.height = ''
                    }}
                    disabled={!input.trim() || busy}
                    aria-label="Send question"
                    className={cn(
                      'flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white transition-colors',
                      input.trim() && !busy ? 'bg-horizon-600 hover:bg-horizon-700' : 'bg-graphite-300',
                    )}
                  >
                    {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowUp className="h-3.5 w-3.5" />}
                  </button>
                </div>
                <p className="mt-2 text-[11px] text-fg-muted">AI-generated from Backstory’s docs and your workspace.</p>
              </div>
            </>
          )}
        </div>
      )}

      {/* Deleting is a server-side delete of rows, so it is confirmed the way
          every other irreversible action in this product is — through the
          shared dialog, which says what goes and cannot be dismissed by a
          stray keypress — rather than by a window.confirm the browser lets a
          user suppress for the rest of the session. */}
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
              {/* Deliberately no number. The list this count came from is capped
                  at 50 by the route, while the delete it triggers is uncapped —
                  so a heavy user was being told a smaller number than what was
                  about to be destroyed. On an irreversible action, a figure that
                  can understate is worse than no figure. */}
              Every saved conversation — asked here and on the Assistant home, including any not shown in this
              list — is deleted everywhere you are signed in, along with every question and answer in it.
              This cannot be undone.
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

      {/* The launcher is hidden while the panel is open on a phone, where the
          panel covers the whole screen and the button would sit on top of it. */}
      {shouldOfferLauncher(surfaceVisible, open) && <button
        ref={launcherRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-label={open ? 'Close Ask Backstory' : 'Ask Backstory'}
        className={cn(
          'fixed right-4 z-40 flex items-center gap-2 rounded-full border border-graphite-200 bg-white py-2.5 pl-3 pr-4 text-sm font-medium text-graphite-900 shadow-3 transition-[transform,box-shadow,border-color] duration-base hover:-translate-y-0.5 hover:border-horizon-300 hover:shadow-4',
          raised ? 'bottom-[8.5rem]' : 'bottom-4',
          open && 'hidden sm:flex',
        )}
      >
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-horizon-50 text-horizon-600">
          {open ? <X className="h-3.5 w-3.5" /> : <MessageCircleQuestion className="h-3.5 w-3.5" />}
        </span>
        {/* The visible word has to be part of the accessible name (WCAG "Label
            in Name"), so the two change together rather than staying "Ask
            Backstory" over a close icon. */}
        <span className="hidden sm:inline">{open ? 'Close' : 'Ask Backstory'}</span>
      </button>}
    </>
  )
}
