'use client'

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef } from 'react'
import type { ClipboardEvent, DragEvent, KeyboardEvent } from 'react'
import { cn } from '@/lib/utils'
import { friendlyTokenLabel, parseTokenSegments } from '@/lib/flows/token-text'
import type { TokenLabelContext, TokenSegment } from '@/lib/flows/token-text'
import { resolveTemplateValue, type FlowContext } from '@/features/flows/context'

export type TokenTextEditorHandle = { insertToken: (token: string) => void, focus: () => void }

export type TokenTextEditorProps = {
  value: string
  onChange: (value: string) => void
  labelCtx: TokenLabelContext
  multiline?: boolean
  rows?: number
  placeholder?: string
  className?: string
  invalid?: boolean
  onFocus?: () => void
  ariaLabel?: string
  // When provided, resolve the field's {{tokens}} against last-run data and show
  // the result inline (live preview) — so you see what a chip evaluates to
  // without running the flow.
  previewCtx?: FlowContext
}

const chipClass =
  'inline-flex items-center rounded bg-indigo-50 px-1.5 py-0.5 text-xs font-medium text-indigo-700 border border-indigo-200 dark:border-indigo-500/30 dark:bg-indigo-500/10 dark:text-indigo-300'

const baseClass =
  'w-full rounded-lg border bg-background px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-300 ' +
  'empty:before:pointer-events-none empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)]'

/** Walk the editable DOM back into the canonical `{{token}}` template string. */
export function serializeEditorDom(root: HTMLElement): string {
  const walk = (parent: Node): string => {
    let out = ''
    parent.childNodes.forEach((child, index) => {
      if (child.nodeType === 3) {
        // Browsers write &nbsp; for edge/consecutive spaces; store plain spaces.
        out += (child.textContent ?? '').replace(/\u00a0/g, ' ')
        return
      }
      if (!(child instanceof HTMLElement)) return
      const token = child.getAttribute('data-token')
      if (token !== null) out += `{{${token}}}`
      else if (child.tagName === 'BR') out += '\n'
      else if (child.tagName === 'DIV' || child.tagName === 'P') {
        // A block whose sole child is a <br> is one blank line: emit only the
        // block's own leading \n, not a second one for the inner <br>.
        const onlyBr = child.childNodes.length === 1 && child.firstChild instanceof HTMLElement && child.firstChild.tagName === 'BR'
        out += (index > 0 ? '\n' : '') + (onlyBr ? '' : walk(child))
      } else out += walk(child)
    })
    return out
  }
  return walk(root)
}

function makeChip(path: string, ctx: TokenLabelContext): HTMLSpanElement {
  const chip = document.createElement('span')
  chip.contentEditable = 'false'
  chip.setAttribute('data-token', path)
  chip.className = chipClass
  chip.textContent = friendlyTokenLabel(path, ctx)
  return chip
}

/** Append segments as text nodes, `<br>`s, and chip spans (never innerHTML). */
function appendSegments(parent: HTMLElement | DocumentFragment, segments: TokenSegment[], ctx: TokenLabelContext) {
  for (const segment of segments) {
    if (segment.kind === 'token') {
      parent.appendChild(makeChip(segment.path, ctx))
      continue
    }
    segment.value.split('\n').forEach((line, index) => {
      if (index > 0) parent.appendChild(document.createElement('br'))
      if (line) parent.appendChild(document.createTextNode(line))
    })
  }
}

function placeCaretAfter(node: Node) {
  const selection = window.getSelection()
  if (!selection) return
  const range = document.createRange()
  range.setStartAfter(node)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
}

/** Current selection range when it sits entirely inside the editor, else null. */
function selectionRangeInside(editor: HTMLElement): Range | null {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return null
  const range = selection.getRangeAt(0)
  return editor.contains(range.startContainer) && editor.contains(range.endContainer) ? range : null
}

/** Current selection range if it sits inside the editor, else a caret at the end. */
function editRange(editor: HTMLElement): Range {
  const inside = selectionRangeInside(editor)
  if (inside) return inside
  const range = document.createRange()
  range.selectNodeContents(editor)
  range.collapse(false)
  return range
}

/**
 * A contentEditable field that shows `{{token}}`s as plain-English chips while
 * emitting the unchanged canonical template string through `onChange`.
 */
export const TokenTextEditor = forwardRef<TokenTextEditorHandle, TokenTextEditorProps>(function TokenTextEditor(
  { value, onChange, labelCtx, multiline = false, rows = 3, placeholder, className, invalid, onFocus, ariaLabel, previewCtx },
  ref
) {
  const editorRef = useRef<HTMLDivElement>(null)
  const lastEmittedRef = useRef<string | null>(null)
  // `value` plus the rendered chip labels — a label change (step rename) must
  // also trigger a rebuild even though the stored value is unchanged.
  const renderedKeyRef = useRef<string | null>(null)

  const renderKey = (v: string) =>
    v + '\u0000' + parseTokenSegments(v).map((s) => (s.kind === 'token' ? friendlyTokenLabel(s.path, labelCtx) : '')).join('\u0000')

  const emit = (editor: HTMLElement) => {
    const serialized = serializeEditorDom(editor)
    lastEmittedRef.current = serialized
    renderedKeyRef.current = renderKey(serialized)
    onChange(serialized)
  }

  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const key = renderKey(value)
    if (key === renderedKeyRef.current) return
    // Label-only change while the user is typing: skip so the caret survives.
    if (value === lastEmittedRef.current && document.activeElement === editor) return
    editor.replaceChildren()
    appendSegments(editor, parseTokenSegments(value), labelCtx)
    lastEmittedRef.current = value
    renderedKeyRef.current = key
  })

  useImperativeHandle(ref, () => ({
    focus: () => editorRef.current?.focus(),
    insertToken: (token: string) => {
      const editor = editorRef.current
      if (!editor) return
      // A brace in the path would corrupt the {{token}} round-trip.
      if (token.includes('{') || token.includes('}')) return
      // Capture before focus(): programmatic focus drops a caret at content
      // start, which would otherwise shadow the caret-at-end fallback.
      const wasInside = selectionRangeInside(editor) !== null
      editor.focus()
      const range = editRange(editor)
      if (!wasInside) {
        range.selectNodeContents(editor)
        range.collapse(false)
      }
      range.deleteContents()
      const chip = makeChip(token, labelCtx)
      range.insertNode(chip)
      // A trailing space only when nothing typable follows, so the caret has a home.
      const next = chip.nextSibling
      if (!next || (next instanceof HTMLElement && next.hasAttribute('data-token'))) {
        const space = document.createTextNode(' ')
        chip.after(space)
        placeCaretAfter(space)
      } else {
        placeCaretAfter(chip)
      }
      emit(editor)
    },
  }))

  const handleInput = () => {
    const editor = editorRef.current
    if (!editor) return
    // Deleting everything can leave a stray <br>; clear it so :empty (placeholder) matches.
    if (editor.childNodes.length === 1 && editor.firstChild instanceof HTMLElement && editor.firstChild.tagName === 'BR') editor.replaceChildren()
    emit(editor)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Enter during IME composition commits the candidate, not a line break.
    if (event.nativeEvent.isComposing) return
    if (event.key !== 'Enter') return
    event.preventDefault()
    if (!multiline) return
    const editor = editorRef.current
    if (!editor) return
    const range = editRange(editor)
    range.deleteContents()
    const br = document.createElement('br')
    range.insertNode(br)
    placeCaretAfter(br)
    emit(editor)
  }

  /** Shared paste/drop path: sanitize and insert plain text at the caret. */
  const insertPlainText = (raw: string) => {
    const editor = editorRef.current
    if (!editor) return
    const text = multiline ? raw : raw.replace(/\n+/g, ' ')
    if (!text) return
    const range = editRange(editor)
    range.deleteContents()
    const fragment = document.createDocumentFragment()
    appendSegments(fragment, text.includes('{{') ? parseTokenSegments(text) : [{ kind: 'text', value: text }], labelCtx)
    const last = fragment.lastChild
    range.insertNode(fragment)
    if (last) placeCaretAfter(last)
    emit(editor)
  }

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault()
    insertPlainText(event.clipboardData.getData('text/plain'))
  }

  // Dropped text must not bypass paste sanitization (raw <br>/<div> markup).
  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    insertPlainText(event.dataTransfer.getData('text/plain'))
  }

  /**
   * Dragging a chip-containing selection would natively carry the friendly
   * labels; overwrite the payload with the canonical `{{token}}` text so any
   * drop target gets text that resolves (our own onDrop re-chips it via the
   * `{{` parse path). No preventDefault — the browser must still run its
   * native drag; we only correct the payload. We also declare the drag a COPY:
   * our onDrop preventDefaults, which cancels the native "move" half anyway
   * (the source selection always survives), so duplicate-on-drop is the
   * honest, predictable semantics rather than a sometimes-move.
   */
  const handleDragStart = (event: DragEvent<HTMLDivElement>) => {
    const editor = editorRef.current
    if (!editor) return
    const range = selectionRangeInside(editor)
    if (range && !range.collapsed) {
      const container = document.createElement('div')
      container.appendChild(range.cloneContents())
      event.dataTransfer.setData('text/plain', serializeEditorDom(container))
    } else {
      // Chips are contentEditable=false, so browsers can drag one directly
      // with no selection around it — same label-instead-of-token loss.
      const token = event.target instanceof HTMLElement ? event.target.closest('[data-token]')?.getAttribute('data-token') : null
      if (!token) return
      event.dataTransfer.setData('text/plain', `{{${token}}}`)
    }
    event.dataTransfer.effectAllowed = 'copy'
  }

  /** Copy/cut the canonical `{{token}}` text, not the friendly chip labels. */
  const handleCopyCut = (event: ClipboardEvent<HTMLDivElement>, cut: boolean) => {
    const editor = editorRef.current
    if (!editor) return
    const range = selectionRangeInside(editor)
    if (!range) return
    event.preventDefault()
    const container = document.createElement('div')
    container.appendChild(range.cloneContents())
    event.clipboardData.setData('text/plain', serializeEditorDom(container))
    if (!cut) return
    range.deleteContents()
    handleInput()
  }

  const preview = useMemo(() => {
    if (!previewCtx || !value.includes('{{')) return null
    try {
      const resolved = resolveTemplateValue(value, previewCtx)
      if (resolved === undefined || resolved === '') return null
      const text = typeof resolved === 'string' ? resolved : JSON.stringify(resolved)
      return text.length > 240 ? `${text.slice(0, 240)}…` : text
    } catch {
      return null
    }
  }, [previewCtx, value])

  return (
    <>
      <div
        ref={editorRef}
        contentEditable
        role="textbox"
        tabIndex={0}
        aria-multiline={multiline}
        aria-label={ariaLabel}
        aria-invalid={invalid || undefined}
        data-placeholder={placeholder}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onDrop={handleDrop}
        onDragStart={handleDragStart}
        onCopy={(event) => handleCopyCut(event, false)}
        onCut={(event) => handleCopyCut(event, true)}
        onFocus={onFocus}
        style={multiline ? { minHeight: rows * 20 + 18 } : undefined}
        className={cn(
          baseClass,
          invalid ? 'border-red-400' : 'border-border',
          multiline ? 'whitespace-pre-wrap break-words' : 'overflow-x-auto whitespace-nowrap',
          className
        )}
      />
      {preview !== null && (
        <div className="mt-1 truncate rounded bg-muted/50 px-2 py-1 text-[11px] text-muted-foreground" title={preview}>
          → {preview}
        </div>
      )}
    </>
  )
})
