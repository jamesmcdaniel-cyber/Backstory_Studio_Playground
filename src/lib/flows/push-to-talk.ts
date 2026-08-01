/** Hold-to-talk key. Verified unbound elsewhere in the flow builder: neither
 *  the page's global handler nor the canvas's uses Space, and there is no
 *  space-to-pan. */
export const PTT_KEY = ' '

/** The slice of an event target this guard needs. */
export type EditableTarget = { tagName?: string; isContentEditable?: boolean }

const EDITABLE_TAGS = ['INPUT', 'TEXTAREA', 'SELECT']

/**
 * Whether a keyboard event should drive push-to-talk. Mirrors the
 * editable-target guard both existing global key handlers use, so typing a
 * space in a step editor, the copilot, or a CodeMirror block (contentEditable)
 * never opens the microphone.
 */
export function isPttTrigger(key: string, target: EditableTarget | null, repeat: boolean): boolean {
  if (key !== PTT_KEY || repeat) return false
  if (!target) return true
  if (target.isContentEditable) return false
  return !EDITABLE_TAGS.includes(target.tagName ?? '')
}

/**
 * The single source of truth for whether the local microphone track is live.
 *
 * Spreading this across the keydown, keyup, blur and mute handlers is how
 * people end up transmitting while believing they are muted — so every one of
 * those paths funnels through here instead.
 */
export function micEnabled(muted: boolean, pttEnabled: boolean, pttHeld: boolean): boolean {
  return pttEnabled ? pttHeld : !muted
}
