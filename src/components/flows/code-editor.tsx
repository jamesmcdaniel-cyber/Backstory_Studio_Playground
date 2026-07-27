'use client'

import { useMemo } from 'react'
import dynamic from 'next/dynamic'
import { javascript } from '@codemirror/lang-javascript'
import { python } from '@codemirror/lang-python'
import { oneDark } from '@codemirror/theme-one-dark'
import { EditorView } from '@codemirror/view'
import { cn } from '@/lib/utils'

// CodeMirror touches the DOM on mount, so it can't render on the server. Load
// the React wrapper client-side only; the fallback mirrors the editor's look so
// the layout doesn't jump when it hydrates.
const CodeMirror = dynamic(() => import('@uiw/react-codemirror'), {
  ssr: false,
  loading: () => (
    <div className="min-h-[260px] rounded-md border border-input bg-slate-950 p-3 font-mono text-[13px] leading-6 text-slate-500">
      Loading editor…
    </div>
  ),
})

type CodeEditorProps = {
  value: string
  language: 'javascript' | 'python'
  onChange: (value: string) => void
  onFocus?: () => void
  onBlur?: () => void
  minHeight?: string
  ariaLabel?: string
  className?: string
}

/** Syntax-highlighted code editor for the Code node. One component, two
 *  languages — the extension set switches on `language`. */
export function CodeEditor({
  value,
  language,
  onChange,
  onFocus,
  onBlur,
  minHeight = '260px',
  ariaLabel,
  className,
}: CodeEditorProps) {
  const extensions = useMemo(
    () => [
      language === 'python' ? python() : javascript(),
      EditorView.lineWrapping,
      EditorView.contentAttributes.of(ariaLabel ? { 'aria-label': ariaLabel } : {}),
    ],
    [language, ariaLabel],
  )

  return (
    <div className={cn('overflow-hidden rounded-md border border-input', className)}>
      <CodeMirror
        value={value}
        theme={oneDark}
        extensions={extensions}
        onChange={onChange}
        onFocus={onFocus}
        onBlur={onBlur}
        minHeight={minHeight}
        basicSetup={{
          lineNumbers: true,
          highlightActiveLine: true,
          highlightActiveLineGutter: true,
          bracketMatching: true,
          closeBrackets: true,
          autocompletion: true,
          indentOnInput: true,
          foldGutter: false,
        }}
        style={{ fontSize: '13px' }}
      />
    </div>
  )
}
