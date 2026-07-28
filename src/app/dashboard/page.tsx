'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowUp, BookOpen, Bot, ExternalLink, FileText, History, Loader2, Paperclip, PenSquare, Sparkles, Workflow, Wrench } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Markdown } from '@/components/ui/markdown'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'

type LibrarianResult = {
  /** `doc` is a help-centre article (an external link); the rest are workspace items. */
  type: 'agent' | 'flow' | 'template' | 'run' | 'doc'
  id: string
  title: string
  subtitle: string
  href: string
}
/** An external page the answer was written from — always a real, retrieved URL. */
type LibrarianSource = { title: string; url: string; label: string }
type Turn = { question: string; answer: string; results: LibrarianResult[]; sources: LibrarianSource[] }

// Visual-only for now: the persona tunes the hint copy (behavior wiring is a
// deliberate follow-up).
const PERSONAS = [
  { key: 'SALES', hint: 'Deal impact and next actions' },
  { key: 'CSM', hint: 'Retention and account health' },
  { key: 'MARKETING', hint: 'Campaigns and pipeline influence' },
  { key: 'IT', hint: 'Setup, access, and governance' },
] as const

// Openers that show what the Assistant reaches across — the library (templates),
// the connected data (MCP), and the skills layer — rather than five variations
// on "how do I".
const SUGGESTIONS = [
  'Which template generates meeting briefs?',
  'What can I do with Backstory MCP?',
  'Which skills turn account plans into actionable insights?',
]

const RESULT_ICON = { flow: Workflow, agent: Bot, template: FileText, run: History, doc: BookOpen }

function greeting(): string {
  const h = new Date().getHours()
  return h < 12 ? 'GOOD MORNING' : h < 18 ? 'GOOD AFTERNOON' : 'GOOD EVENING'
}

export default function AssistantHome() {
  const router = useRouter()
  const [input, setInput] = useState('')
  const [persona, setPersona] = useState<(typeof PERSONAS)[number]['key']>('SALES')
  const [thread, setThread] = useState<Turn[]>([])
  const [busy, setBusy] = useState(false)
  const [hello, setHello] = useState('GOOD MORNING')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const threadEndRef = useRef<HTMLDivElement>(null)
  // Bumped by "New chat" so an in-flight answer from the previous conversation
  // can't land in the fresh one.
  const threadSeq = useRef(0)

  // Compute the time-of-day greeting on the client to avoid an SSR mismatch.
  useEffect(() => setHello(greeting()), [])
  useEffect(() => { threadEndRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [thread, busy])

  // Grows with the content; the CSS min-height keeps the empty composer tall.
  const grow = (el: HTMLTextAreaElement) => { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, 240)}px` }
  const resetComposer = () => { if (textareaRef.current) textareaRef.current.style.height = '' }

  const ask = async (question: string) => {
    const q = question.trim()
    if (!q || busy) return
    const seq = threadSeq.current
    setInput('')
    resetComposer()
    setBusy(true)
    try {
      const res = await fetch('/api/librarian', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      })
      const data = await res.json().catch(() => ({}))
      if (seq !== threadSeq.current) return // the user started a new chat meanwhile
      if (!res.ok) { toast.error(data.error || 'The Assistant couldn’t answer that.'); return }
      setThread((prev) => [...prev, { question: q, answer: data.answer ?? '', results: data.results ?? [], sources: data.sources ?? [] }])
    } catch {
      if (seq === threadSeq.current) toast.error('Could not reach the Assistant.')
    } finally {
      if (seq === threadSeq.current) setBusy(false)
    }
  }

  const startNewChat = () => {
    threadSeq.current++
    setThread([])
    setInput('')
    setBusy(false)
    resetComposer()
    textareaRef.current?.focus()
  }

  const activeHint = PERSONAS.find((p) => p.key === persona)?.hint

  // Before the first question this is a landing surface, so the composer sits in
  // the middle of the screen rather than pinned under the header with the rest
  // of the viewport empty. Once a conversation exists the content has to grow
  // downward, so it goes back to top-aligned.
  const started = thread.length > 0 || busy

  return (
    <div
      className={cn(
        'mx-auto flex w-full max-w-6xl flex-col px-4 pb-24',
        started ? 'pt-10 sm:pt-14' : 'min-h-[68vh] justify-center pt-6',
      )}
    >
      <div className="mb-8 flex items-center justify-between gap-4">
        <p className="font-mono text-xs tracking-[0.2em] text-gray-500">
          <span className="text-horizon-500">{'///'}</span> {hello}
        </p>
        {started && (
          <button
            type="button"
            onClick={startNewChat}
            className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3.5 py-2 font-mono text-xs uppercase tracking-wider text-gray-500 shadow-1 transition-colors hover:border-horizon-200 hover:text-horizon-700"
          >
            <PenSquare className="h-3.5 w-3.5" /> New chat
          </button>
        )}
      </div>

      {/* Composer — prompt, attach + BUILD, send, persona row */}
      <div className="rounded-2xl border border-gray-200 bg-white shadow-2 transition-[border-color,box-shadow,transform] duration-base focus-within:-translate-y-0.5 focus-within:border-horizon-400 focus-within:shadow-4 focus-within:ring-4 focus-within:ring-horizon-500/10">
        <div className="px-6 pt-6">
          <textarea
            ref={textareaRef}
            value={input}
            rows={1}
            onChange={(e) => { setInput(e.target.value); grow(e.target) }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void ask(input) } }}
            placeholder="Ask the Assistant about the library, setup, or a goal…"
            aria-label="Ask the Assistant"
            className="min-h-[3.5rem] w-full resize-none bg-transparent text-xl leading-8 text-gray-900 outline-none placeholder:text-gray-400"
          />
        </div>

        <div className="flex items-center justify-between px-5 py-3.5">
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => toast('Attachments are coming soon.')}
              className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
              aria-label="Attach"
            >
              <Paperclip className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => router.push('/agents?agent=new')}
              className="inline-flex items-center gap-1.5 rounded-lg px-2 py-2 font-mono text-xs uppercase tracking-wider text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
            >
              <Wrench className="h-3.5 w-3.5" /> Build
            </button>
          </div>
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

        <div className="border-t px-5 py-4">
          <div className="mb-2.5 flex items-center justify-between">
            <span className="font-mono text-[11px] uppercase tracking-wider text-gray-500">Tailor output for</span>
            {activeHint && <span className="text-sm text-gray-400">{activeHint}</span>}
          </div>
          <Tabs value={persona} onValueChange={(value) => setPersona(value as (typeof PERSONAS)[number]['key'])}>
            <TabsList className="grid h-auto w-full grid-cols-4">
              {PERSONAS.map((p) => (
                <TabsTrigger
                  key={p.key}
                  value={p.key}
                  className="py-2 font-mono text-xs tracking-wider"
                >
                  {p.key}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      </div>

      {/* Suggestion chips (empty state only). One row on a wide screen, spread
          edge to edge under the composer; they wrap only when it gets narrow. */}
      {!started && (
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
      )}

      {/* Conversation */}
      {started && (
        <div className="mt-8 space-y-8">
          {thread.map((turn, i) => (
            <div key={i} className="space-y-3">
              <p className="text-right text-sm font-medium text-gray-900">{turn.question}</p>
              <div className="rounded-2xl border bg-white p-4 shadow-2 animate-fade-in-up">
                <div className="flex items-center gap-1.5 text-xs font-medium text-horizon-600">
                  <Sparkles className="h-3.5 w-3.5" /> Assistant
                </div>
                <div className="mt-2 text-sm leading-6 text-gray-700">
                  <Markdown>{turn.answer}</Markdown>
                </div>
                {turn.results.length > 0 && (
                  <div className="mt-4 grid gap-2 sm:grid-cols-2">
                    {turn.results.map((r) => {
                      const Icon = RESULT_ICON[r.type]
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
                            <span className="block truncate text-xs text-gray-400">{r.subtitle}</span>
                          </span>
                          {external && <ExternalLink aria-label="Opens in a new tab" className="h-3.5 w-3.5 shrink-0 text-gray-400" />}
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
                    <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-gray-400">Sources</p>
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
                            <span className="ml-1.5 text-[11px] text-gray-400">{s.label}</span>
                            <a
                              href={s.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="block truncate font-mono text-[11px] text-gray-400 transition-colors hover:text-horizon-600"
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
          {busy && (
            <div className="flex items-center gap-2 text-sm text-gray-400">
              <Loader2 className="h-4 w-4 animate-spin" /> Searching your library…
            </div>
          )}
          <div ref={threadEndRef} />
        </div>
      )}
    </div>
  )
}
