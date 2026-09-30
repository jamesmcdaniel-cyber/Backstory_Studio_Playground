'use client'

import { useCallback, useEffect, useState } from 'react'
import { CHAT_MODELS, CHAT_SURFACE_DEFAULTS, isChatModel, type ChatSurface } from '@/lib/llm/models'
import { cn } from '@/lib/utils'

const storageKey = (surface: ChatSurface) => `backstory:chat-model:${surface}`

/**
 * The model a person picked for a chat surface, remembered in this browser.
 * Starts on the surface default; a stored value that is no longer on the
 * list (a retired model) falls back to the default rather than being sent.
 */
export function useChatModel(surface: ChatSurface): [string, (model: string) => void] {
  const [model, setModelState] = useState<string>(CHAT_SURFACE_DEFAULTS[surface])
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(storageKey(surface))
      if (isChatModel(stored)) setModelState(stored)
    } catch {
      // Storage can be unavailable (private mode, blocked site data): the default stands.
    }
  }, [surface])
  const setModel = useCallback((next: string) => {
    if (!isChatModel(next)) return
    setModelState(next)
    try {
      window.localStorage.setItem(storageKey(surface), next)
    } catch {
      // Remembering is a convenience; the choice still applies to this session.
    }
  }, [surface])
  return [model, setModel]
}

/** A compact model select for a chat composer. */
export function ModelPicker({ value, onChange, disabled, className }: { value: string; onChange: (model: string) => void; disabled?: boolean; className?: string }) {
  return (
    <select
      aria-label="Model"
      title="Which model answers — faster or more capable"
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      className={cn('h-7 max-w-[11rem] cursor-pointer rounded-md border border-input bg-background px-1.5 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60', className)}
    >
      {CHAT_MODELS.map((model) => (
        <option key={model.id} value={model.id}>
          {model.label} · {model.hint}
        </option>
      ))}
    </select>
  )
}
