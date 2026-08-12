'use client'

/**
 * The dialog vocabulary Settings runs on.
 *
 * Settings used to drive its destructive and secret-bearing actions through
 * `window.prompt` / `window.confirm`. Three things were wrong with that beyond
 * the look of it:
 *
 *   - a native prompt is the WRONG carrier for a one-time secret. It is not
 *     selectable on iOS, it cannot be re-opened, and once a user ticks
 *     "prevent this page from creating additional dialogs" the API key or SCIM
 *     token is minted server-side and then simply never shown to anyone.
 *   - `navigator.clipboard` rejects outside a secure context, and the old code
 *     swallowed that rejection — so on plain http the token was copied nowhere
 *     and displayed nowhere.
 *   - a typed confirmation ("type the workspace name") in a native prompt has
 *     no way to show the target value it is comparing against.
 *
 * These give the same actions a real surface: the secret stays on screen until
 * dismissed, selectable, with a copy button that falls back when the async
 * clipboard is unavailable.
 */

import { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/**
 * Copy that also works where `navigator.clipboard` does not: it is undefined on
 * insecure origins and rejects when the permission is denied. Returns whether
 * the text actually landed on the clipboard, so callers can tell the truth
 * rather than claiming a copy that never happened.
 */
export async function copyText(value: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    // Fall through to the selection-based path below.
  }
  try {
    const area = document.createElement('textarea')
    area.value = value
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.top = '0'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const copied = document.execCommand('copy')
    document.body.removeChild(area)
    return copied
  } catch {
    return false
  }
}

/** Copy affordance that confirms in place instead of firing a toast per click. */
export function CopyButton({ value, label = 'Copy', className }: { value: string; label?: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1600)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={className}
      onClick={() => void copyText(value).then(setCopied)}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? 'Copied' : label}
    </Button>
  )
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  destructive = false,
  /** When set, the action stays disabled until the user types this exactly. */
  requireText,
  requireTextLabel,
  busy = false,
  onConfirm,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: React.ReactNode
  confirmLabel?: string
  destructive?: boolean
  requireText?: string
  requireTextLabel?: React.ReactNode
  busy?: boolean
  onConfirm: () => unknown
  /** Extra choices the confirmation itself carries (a modifier toggle, …). */
  children?: React.ReactNode
}) {
  const [typed, setTyped] = useState('')
  // Reopening for a different target must not inherit the previous answer.
  useEffect(() => { if (open) setTyped('') }, [open])
  const satisfied = !requireText || typed.trim() === requireText.trim()

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {requireText && (
          <div className="space-y-1.5">
            <Label htmlFor="confirm-phrase">
              {requireTextLabel ?? <>Type <span className="font-mono text-foreground">{requireText}</span> to confirm</>}
            </Label>
            <Input
              id="confirm-phrase"
              value={typed}
              autoComplete="off"
              onChange={(event) => setTyped(event.target.value)}
              placeholder={requireText}
            />
          </div>
        )}
        {children}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            loading={busy}
            disabled={!satisfied}
            onClick={() => void onConfirm()}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function PromptDialog({
  open,
  onOpenChange,
  title,
  description,
  label,
  placeholder,
  confirmLabel = 'Continue',
  busy = false,
  onSubmit,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: React.ReactNode
  label: string
  placeholder?: string
  confirmLabel?: string
  busy?: boolean
  onSubmit: (value: string) => unknown
  /** Extra fields rendered under the text input (scopes, expiry, …). */
  children?: React.ReactNode
}) {
  const [value, setValue] = useState('')
  useEffect(() => { if (open) setValue('') }, [open])

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
      <DialogContent className="max-w-md">
        <form
          onSubmit={(event) => { event.preventDefault(); if (value.trim()) void onSubmit(value.trim()) }}
          className="space-y-4"
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="prompt-value">{label}</Label>
            <Input
              id="prompt-value"
              value={value}
              autoComplete="off"
              onChange={(event) => setValue(event.target.value)}
              placeholder={placeholder}
            />
          </div>
          {children}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
            <Button type="submit" loading={busy} disabled={!value.trim()}>{confirmLabel}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/**
 * One-time reveal for a value the server will never send again. Deliberately
 * has no "cancel": the only way out is acknowledging you have it.
 */
export function SecretDialog({
  open,
  onOpenChange,
  title,
  description,
  secret,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: React.ReactNode
  secret: string
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {description ?? 'Copy this now — it is stored hashed and cannot be shown again.'}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {/* Selectable and wrapped: a user without clipboard permission can
              still highlight it by hand, which a native prompt did not allow. */}
          <code className="block max-h-40 overflow-auto break-all rounded-lg border bg-muted p-3 font-mono text-xs">
            {secret}
          </code>
          <CopyButton value={secret} label="Copy to clipboard" />
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>I&rsquo;ve saved it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The card chrome every settings block shares. */
export function SettingsRow({
  title,
  description,
  children,
}: {
  title: string
  description?: React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
      <div className="min-w-[14rem] flex-1">
        <div className="text-sm font-medium text-foreground">{title}</div>
        {description && <div className="mt-0.5 text-xs text-muted-foreground">{description}</div>}
      </div>
      {children}
    </div>
  )
}
