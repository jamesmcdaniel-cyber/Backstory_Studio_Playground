/** What to show when getUserMedia rejects. `retryable: false` means a Retry
 *  button would be a lie — see NotAllowedError below. */
export type MediaErrorInfo = { title: string; hint: string; retryable: boolean }

/**
 * Maps a getUserMedia rejection to plain-English guidance. Pure, so every
 * branch is testable without a browser — the hook only decides WHEN to call it.
 */
export function describeMediaError(error: unknown): MediaErrorInfo {
  const name =
    typeof error === 'object' && error !== null && 'name' in error
      ? String((error as { name: unknown }).name)
      : ''

  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      // A hard deny cannot be re-prompted from script — the user must clear it
      // in browser UI. Offering Retry here would silently do nothing.
      return {
        title: 'Microphone access is blocked',
        hint: 'Allow microphone access from the icon in your browser’s address bar, then join again.',
        retryable: false,
      }
    case 'NotFoundError':
    case 'OverconstrainedError':
      return {
        title: 'No microphone found',
        hint: 'Connect a microphone or headset, then try again.',
        retryable: true,
      }
    case 'NotReadableError':
      return {
        title: 'Your microphone is in use',
        hint: 'Another app has the microphone. Close it, then try again.',
        retryable: true,
      }
    default:
      return {
        title: 'Could not start the huddle',
        hint: 'Something went wrong reaching your microphone. Try again.',
        retryable: true,
      }
  }
}
