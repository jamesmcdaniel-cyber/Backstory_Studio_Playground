'use client'

import { isValidElement, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Recursively extract the plain text of a React node (for copy-to-clipboard). */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children)
  return ''
}

/** Fenced code block with a language tag + copy button, like a chat client. */
function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false)
  const code = isValidElement(children) ? (children.props as { className?: string; children?: ReactNode }) : null
  const language = /language-([\w-]+)/.exec(code?.className ?? '')?.[1] ?? ''
  const text = textOf(children).replace(/\n$/, '')

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="flex items-center justify-between border-b border-border bg-muted/70 px-3 py-1">
        <span className="font-mono text-[11px] lowercase text-muted-foreground">{language || 'text'}</span>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy code"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {copied ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="overflow-x-auto bg-muted/40 p-3 text-xs leading-relaxed [&_code]:border-0 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[inherit]">
        {children}
      </pre>
    </div>
  )
}

/**
 * Renders agent output as chat-grade Markdown — headings, lists, task lists,
 * tables, fenced code with copy, blockquotes and links — matching the polish
 * of a first-party model chat client.
 */
export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn('space-y-3 text-sm leading-relaxed text-foreground', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (props) => <h1 className="mt-5 text-lg font-semibold tracking-tight first:mt-0" {...props} />,
          h2: (props) => <h2 className="mt-5 text-base font-semibold tracking-tight first:mt-0" {...props} />,
          h3: (props) => <h3 className="mt-4 text-sm font-semibold first:mt-0" {...props} />,
          h4: (props) => <h4 className="mt-3 text-sm font-semibold text-muted-foreground first:mt-0" {...props} />,
          p: (props) => <p className="whitespace-pre-wrap" {...props} />,
          strong: (props) => <strong className="font-semibold" {...props} />,
          ul: (props) => <ul className="list-disc space-y-1.5 pl-5 marker:text-muted-foreground [&_ul]:mt-1.5 [&_ol]:mt-1.5" {...props} />,
          ol: (props) => <ol className="list-decimal space-y-1.5 pl-5 marker:text-muted-foreground [&_ul]:mt-1.5 [&_ol]:mt-1.5" {...props} />,
          li: (props) => <li className="pl-0.5 [&>input]:mr-1.5 [&>input]:h-3.5 [&>input]:w-3.5 [&>input]:translate-y-0.5 [&>input]:accent-indigo-600" {...props} />,
          a: (props) => (
            <a className="font-medium text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary" target="_blank" rel="noreferrer" {...props} />
          ),
          code: (props) => <code className="rounded-md border border-border/60 bg-muted px-1.5 py-0.5 font-mono text-[0.85em]" {...props} />,
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          table: (props) => (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full border-collapse text-xs" {...props} />
            </div>
          ),
          thead: (props) => <thead className="bg-muted/70" {...props} />,
          th: (props) => <th className="border-b border-border px-3 py-2 text-left font-semibold" {...props} />,
          td: (props) => <td className="border-b border-border/50 px-3 py-2 align-top [tr:last-child_&]:border-b-0" {...props} />,
          blockquote: (props) => <blockquote className="border-l-2 border-indigo-300 pl-3 text-muted-foreground dark:border-indigo-500/50" {...props} />,
          hr: (props) => <hr className="my-4 border-border" {...props} />,
          img: ({ src, alt }) => safeInlineImageSource(src)
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={src} alt={alt ?? ''} className="max-w-full rounded-lg border border-border" />
            : <a href={typeof src === 'string' ? src : undefined} target="_blank" rel="noreferrer">{alt || 'External image'}</a>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}

/** Remote model-authored images require an explicit click to prevent egress. */
export function safeInlineImageSource(src: string | Blob | undefined): boolean {
  return typeof src === 'string' && (
    (/^\/(?![\\/])/.test(src) && !/[\x00-\x20\x7F]/.test(src)) ||
    /^data:image\/(?:png|jpe?g|gif|webp);/i.test(src) ||
    src.startsWith('blob:')
  )
}
