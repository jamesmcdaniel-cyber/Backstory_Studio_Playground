'use client'

import { useState } from 'react'
import { indentOnTab } from '@/components/ui/textarea'
import { Sparkles } from 'lucide-react'
import { toast } from 'sonner'

/**
 * "Ask AI" for the Code node (n8n parity): describe what the code should do and
 * generate the step body. Grounded in the step's language/mode and a sample of
 * its input; the generated code replaces the editor contents.
 */
export function CodeAssist({
  language,
  mode,
  inputSample,
  onGenerated,
}: {
  language: 'javascript' | 'python'
  mode: 'all' | 'each'
  inputSample?: string
  onGenerated: (code: string) => void
}) {
  const [prompt, setPrompt] = useState('')
  const [loading, setLoading] = useState(false)
  const generate = async () => {
    if (!prompt.trim() || loading) return
    setLoading(true)
    try {
      const res = await fetch('/api/flows/code-assist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ language, mode, prompt: prompt.trim(), inputSample }),
      }).then((r) => r.json())
      if (res?.success && res.code) {
        onGenerated(res.code)
        toast.success('Code generated — review before running.')
        setPrompt('')
      } else {
        toast.error(res?.error || 'Could not generate code.')
      }
    } catch {
      toast.error('Could not generate code.')
    } finally {
      setLoading(false)
    }
  }
  return (
    <details className="rounded-lg border border-indigo-200 bg-indigo-50/50 p-2 dark:border-indigo-500/30 dark:bg-indigo-500/5">
      <summary className="flex cursor-pointer items-center gap-1.5 text-xs font-semibold text-indigo-700 dark:text-indigo-300">
        <Sparkles className="h-3.5 w-3.5" /> Generate with AI
      </summary>
      <div className="mt-2 space-y-2">
        <textarea
          rows={2}
          onKeyDown={indentOnTab}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe what this code should do — e.g. 'return only items where amount > 100, sorted by date'"
          className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-sm outline-none focus:border-indigo-400"
        />
        <button
          type="button"
          onClick={generate}
          disabled={!prompt.trim() || loading}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
        >
          {loading ? 'Generating…' : 'Generate code'}
        </button>
      </div>
    </details>
  )
}
