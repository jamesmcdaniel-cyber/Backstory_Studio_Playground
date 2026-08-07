'use client'

import { useEffect } from 'react'
import { captureError } from '@/lib/observability/sentry'

/**
 * Root error boundary for the App Router. Catches render errors thrown ABOVE the
 * AppShell's React boundaries — including errors in the root layout itself — so
 * the very last resort is a readable message, never a blank document. Next
 * requires global-error to render its own <html>/<body>.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    captureError(error, { source: 'global-error', digest: error.digest })
  }, [error])

  return (
    <html lang="en">
      {/* Inline hexes are required here (no stylesheet loads when the root layout
          fails); the values are the graphite tokens from backstory-design.css. */}
      <body style={{ margin: 0, fontFamily: 'system-ui, sans-serif', background: '#FAFAFA', color: '#171721' }}>
        <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
          <div style={{ maxWidth: 420, textAlign: 'center' }}>
            <h1 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8 }}>Something went wrong</h1>
            <p style={{ fontSize: 14, color: '#8E8E92', marginBottom: 20 }}>
              An unexpected error occurred. It’s been logged — please try again.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button
                onClick={() => reset()}
                style={{ padding: '8px 16px', borderRadius: 8, border: 'none', background: '#171721', color: '#fff', fontSize: 14, cursor: 'pointer' }}
              >
                Try again
              </button>
              <button
                onClick={() => { window.location.href = '/dashboard' }}
                style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid #C7C7C8', background: '#fff', color: '#171721', fontSize: 14, cursor: 'pointer' }}
              >
                Go to dashboard
              </button>
            </div>
          </div>
        </div>
      </body>
    </html>
  )
}
