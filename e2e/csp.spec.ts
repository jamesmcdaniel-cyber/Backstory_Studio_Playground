import { expect, test, type ConsoleMessage, type Page } from '@playwright/test'

/**
 * The strict CSP is load-bearing, not decorative: the Supabase session cookie is
 * readable by scripts (no httpOnly, see src/lib/supabase/config.ts), so
 * script-src is what stands between an XSS and a stolen access + refresh token.
 *
 * A policy that silently blocks Next's own bootstrap looks identical to a
 * working one in unit tests — the page just renders blank. These are the tests
 * that would have caught that, by driving a real browser.
 */

/** CSP violations surface as console errors with a recognisable prefix. */
function cspViolations(page: Page): string[] {
  const violations: string[] = []
  page.on('console', (message: ConsoleMessage) => {
    const text = message.text()
    if (/Content Security Policy|Refused to (load|execute|apply|connect)/i.test(text)) {
      violations.push(text)
    }
  })
  return violations
}

test('the auth gateway renders and hydrates under the enforced policy', async ({ page }) => {
  const violations = cspViolations(page)

  await page.goto('/auth')

  // Hydration is the real assertion: a blocked bootstrap script still paints
  // server-rendered HTML, so "text is visible" alone would pass a broken CSP.
  // An interactive input proves React actually mounted and took over.
  const input = page.getByRole('textbox')
  await expect(input).toBeVisible()
  await input.fill('example.com')
  await expect(input).toHaveValue('example.com')

  expect(violations, `CSP violations:\n${violations.join('\n')}`).toEqual([])
})

test('the policy is nonce-based, per-response, and has no unsafe script sources', async ({ page }) => {
  const first = await page.goto('/auth')
  const policy = first?.headers()['content-security-policy']
  expect(policy, 'no Content-Security-Policy header was sent').toBeTruthy()

  const scriptSrc = policy!.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src'))
  expect(scriptSrc).toBeTruthy()
  expect(scriptSrc).toContain("'strict-dynamic'")
  expect(scriptSrc).toMatch(/'nonce-[A-Za-z0-9+/=]+'/)
  // 'unsafe-inline' would let an injected <script> run and read the session
  // cookie — the exact attack this policy exists to stop.
  expect(scriptSrc).not.toContain("'unsafe-inline'")

  // Clickjacking + injection hardening carried over from the previous static policy.
  expect(policy).toContain("frame-ancestors 'none'")
  expect(policy).toContain("base-uri 'self'")
  expect(policy).toContain("object-src 'none'")

  // A reused nonce is no nonce: an attacker who reads one page's nonce could
  // otherwise inject a script that passes on every subsequent response.
  const second = await page.goto('/privacy')
  const secondPolicy = second?.headers()['content-security-policy']
  expect(secondPolicy).toBeTruthy()
  const nonceOf = (value: string) => /'nonce-([A-Za-z0-9+/=]+)'/.exec(value)?.[1]
  expect(nonceOf(secondPolicy!)).not.toEqual(nonceOf(policy!))
})

test('exactly one CSP header is sent', async ({ page }) => {
  // Two policies are enforced as their INTERSECTION, so a static header left in
  // next.config.js would quietly neuter the nonced one.
  const response = await page.goto('/auth')
  const raw = await response!.headerValue('content-security-policy')
  expect(raw).toBeTruthy()
  expect(raw!.split(',').filter((part) => part.includes('script-src'))).toHaveLength(1)
})
