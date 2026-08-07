import * as React from "react"

import { cn } from "@/lib/utils"

const INDENT = "  "

/**
 * Tab indents and Shift+Tab outdents inside the field instead of moving focus,
 * so multiline inputs (Copilot chat, instructions, JSON args) can be formatted
 * in place. Modifier chords (⌘/Ctrl/Alt+Tab) and handlers that already called
 * preventDefault keep their behavior. With a multiline selection the whole
 * block is indented/outdented line-wise; edits go through setRangeText so the
 * browser's undo stack survives.
 */
export function indentOnTab(e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) {
  if (e.key !== "Tab" || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
  e.preventDefault()
  const el = e.currentTarget
  const { value } = el
  const start = el.selectionStart ?? value.length
  const end = el.selectionEnd ?? start
  if (!e.shiftKey && start === end) {
    el.setRangeText(INDENT, start, end, "end")
  } else {
    const lineStart = value.lastIndexOf("\n", start - 1) + 1
    const block = value.slice(lineStart, end)
    const replaced = e.shiftKey
      ? block.replace(/(^|\n)(\t| {1,2})/g, "$1")
      : block.replace(/(^|\n)(?=[^\n])/g, `$1${INDENT}`)
    if (replaced === block) return
    const firstOld = block.split("\n", 1)[0]
    const firstNew = replaced.split("\n", 1)[0]
    el.setRangeText(replaced, lineStart, end)
    const newStart = Math.max(lineStart, start + (firstNew.length - firstOld.length))
    el.setSelectionRange(newStart, end + (replaced.length - block.length))
  }
  el.dispatchEvent(new Event("input", { bubbles: true }))
}

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>

const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, onKeyDown, ...props }, ref) => {
    return (
      <textarea
        className={cn(
          "flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background transition-colors duration-fast placeholder:text-muted-foreground hover:border-graphite-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-red-500 aria-[invalid=true]:focus-visible:ring-red-500",
          className
        )}
        ref={ref}
        onKeyDown={(e) => {
          onKeyDown?.(e)
          indentOnTab(e)
        }}
        {...props}
      />
    )
  }
)
Textarea.displayName = "Textarea"

export { Textarea }
