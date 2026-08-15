/**
 * Next.js server instrumentation — runs once per server boot.
 * Fails fast on missing required env in production, then initializes error
 * tracking. https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { assertServerEnv } = await import('./src/lib/env')
    assertServerEnv()
    // Before anything can encrypt. A non-env provider that cannot be reached
    // throws here on purpose: a server that boots without the key it needs to
    // read its own credentials turns every integration into a silent failure,
    // and refusing to start is the honest signal.
    const { initializeKeyMaterial } = await import('./src/lib/crypto/key-source')
    await initializeKeyMaterial()
    const { initSentry } = await import('./src/lib/observability/sentry')
    await initSentry()
  }
}
