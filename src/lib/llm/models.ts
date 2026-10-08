/**
 * The models a person can pick in a chat surface — one list, read by every
 * picker and enforced by every route. Before this there were five hand-kept
 * lists and the server accepted any string; now a model that is not here
 * cannot be requested, and adding one is one line.
 *
 * Client-safe: no server imports, so pickers and routes share it.
 */

export type ChatModel = {
  id: string
  label: string
  /** One word on the trade-off, shown beside the name. */
  hint: string
}

export const CHAT_MODELS: readonly ChatModel[] = [
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', hint: 'Fastest' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', hint: 'Balanced' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', hint: 'Deepest' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1', hint: 'Most capable' },
] as const

/** The surfaces that offer a picker, and the model each starts on. */
export const CHAT_SURFACE_DEFAULTS = {
  copilot: 'claude-sonnet-5-5',
  assistant: 'claude-sonnet-5-5',
  librarian: 'claude-haiku-5-5',
  artifact: 'claude-opus-5-5',
} as const
export type ChatSurface = keyof typeof CHAT_SURFACE_DEFAULTS

export function isChatModel(value: unknown): value is string {
  return typeof value === 'string' && CHAT_MODELS.some((model) => model.id === value)
}

/** The model to use: the requested one when it is on the list, else the surface default. */
export function resolveChatModel(requested: unknown, surface: ChatSurface): string {
  return isChatModel(requested) ? requested : CHAT_SURFACE_DEFAULTS[surface]
}

export function chatModelLabel(id: string | null | undefined): string {
  return CHAT_MODELS.find((model) => model.id === id)?.label ?? id ?? ''
}
