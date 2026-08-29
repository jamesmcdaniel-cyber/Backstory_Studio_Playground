'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useReducedMotion } from 'motion/react'
import {
  ArrowUp,
  BookOpen,
  Bot,
  ChevronRight,
  ExternalLink,
  FileText,
  History,
  Loader2,
  MessageCircleQuestion,
  PenSquare,
  RotateCcw,
  Sparkles,
  Workflow,
  X,
} from 'lucide-react'
import { indentOnTab } from '@/components/ui/textarea'
import { Markdown } from '@/components/ui/markdown'
import { useDismissOnOutsidePointer } from '@/hooks/use-dismiss-on-outside-pointer'
import { surfaceForPath } from '@/lib/librarian/surfaces'
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
 * the server fetched. This widget adds the two things a floating helper needs
 * that a landing page does not: the earlier turns (so follow-ups work) and the
 * page the question was asked from (so "why did this fail?" has a referent).
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

const RESULT_ICON = {
  flow: Workflow,
  agent: Bot,
  template: FileText,
  run: History,
  doc: BookOpen,
  page: ChevronRight,
}

/**
 * Where the conversation lives between page loads.
 *
 * sessionStorage, not localStorage: a help thread is about what the user is
 * doing right now, and reopening the widget tomorrow to yesterday's half-answer
 * would be clutter, not continuity. Per-tab is also the right scope — two tabs
 * on two parts of the product are two separate questions.
 */
const THREAD_KEY = 'backstory:ask-thread'
const OPEN_KEY = 'backstory:ask-open'

/** Turns sent back as context. Six is three exchanges — enough for a follow-up chain, bounded for tokens. */
const HISTORY_TURNS = 3

function loadThread(): Turn[] {
  try {
    const raw = window.sessionStorage.getItem(THREAD_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    // Shape-checked rather than trusted: the key is writable by anything else
    // on the origin, and a malformed turn would throw inside the render.
    return parsed.filter((turn): turn is Turn =>
      Boolean(turn) && typeof turn === 'object'
      && typeof (turn as Turn).question === 'string'
      && typeof (turn as Turn).answer === 'string'
      && Array.isArray((turn as Turn).results)
      && Array.isArray((turn as Turn).sources),
    )
  } catch {
    return []
  }
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
  const [thread, setThread] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  // A failed question stays on screen with a retry, rather than vanishing into
  // a toast the user has already navigated away from.
  const [failure, setFailure] = useState<{ question: string; message: string } | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const launcherRef = useRef<HTMLButtonElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const threadEndRef = useRef<HTMLDivElement>(null)
  // Bumped by "New chat" so an in-flight answer can't land in the fresh thread.
  const threadSeq = useRef(0)

  // The full location, so an answer about "this flow" knows which page asked.
  const currentPath = useMemo(() => {
    const query = searchParams?.toString()
    return query ? `${pathname}?${query}` : pathname
  }, [pathname, searchParams])
  const surface = useMemo(() => surfaceForPath(currentPath), [currentPath])

  // Restore on mount only — after that this component owns the state, and the
  // shell keeps it mounted across navigation.
  useEffect(() => {
    setThread(loadThread())
    try {
      setOpen(window.sessionStorage.getItem(OPEN_KEY) === '1')
    } catch {
      /* private mode — the widget just starts closed */
    }
  }, [])

  useEffect(() => {
    try {
      // Only the last few turns are kept: the quota is small and an answer with
      // its sources is not.
      window.sessionStorage.setItem(THREAD_KEY, JSON.stringify(thread.slice(-6)))
    } catch {
      /* over quota or blocked — the in-memory thread still works */
    }
  }, [thread])

  useEffect(() => {
    try {
      window.sessionStorage.setItem(OPEN_KEY, open ? '1' : '0')
    } catch {
      /* as above */
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    inputRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    threadEndRef.current?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' })
  }, [thread, busy, failure, open, reduced])

  // Escape and outside-pointer close it. The launcher counts as inside so its
  // own click toggles rather than being read as an outside dismissal.
  useDismissOnOutsidePointer(open, () => setOpen(false), [panelRef, launcherRef])

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
          // Flattened oldest-first, exactly as the prompt lays it out.
          history: thread.slice(-HISTORY_TURNS).flatMap((turn) => [
            { role: 'user' as const, content: turn.question },
            { role: 'assistant' as const, content: turn.answer },
          ]),
          path: currentPath,
        }),
      })
      const data = await response.json().catch(() => ({}))
      if (seq !== threadSeq.current) return
      if (!response.ok) {
        setFailure({ question: q, message: data.error || 'Ask Backstory couldn’t answer that.' })
        return
      }
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
  }, [busy, currentPath, thread])

  const startNewChat = () => {
    threadSeq.current++
    setThread([])
    setInput('')
    setBusy(false)
    setFailure(null)
    inputRef.current?.focus()
  }

  // The first chip is about wherever the user actually is, so the empty state
  // opens on their situation rather than a generic tour.
  const suggestions = surface
    ? [`What can I do on ${surface.title}?`, ...GENERIC_SUGGESTIONS.slice(1)]
    : GENERIC_SUGGESTIONS

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
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-horizon-50 text-horizon-600">
              <Sparkles className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-graphite-900">Ask Backstory</p>
              <p className="truncate font-mono text-[10px] uppercase tracking-[0.14em] text-fg-muted">
                {surface ? surface.title : 'Help & navigation'}
              </p>
            </div>
            {thread.length > 0 && (
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
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md p-1.5 text-fg-muted transition-colors hover:bg-graphite-100 hover:text-graphite-900"
              aria-label="Close Ask Backstory"
            >
              <X className="h-4 w-4" />
            </button>
          </header>

          <div
            className="flex-1 space-y-4 overflow-y-auto px-4 py-4"
            role="log"
            aria-live="polite"
            aria-relevant="additions"
            aria-busy={busy}
          >
            {thread.length === 0 && !busy && !failure && (
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

            {thread.map((turn, index) => (
              <div key={index} className="space-y-3">
                <div className="flex justify-end">
                  <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-graphite-100 px-3 py-2 text-sm text-graphite-900">
                    {turn.question}
                  </p>
                </div>
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
        </div>
      )}

      {/* The launcher is hidden while the panel is open on a phone, where the
          panel covers the whole screen and the button would sit on top of it. */}
      <button
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
      </button>
    </>
  )
}
