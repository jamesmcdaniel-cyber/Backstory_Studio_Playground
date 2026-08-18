import { defineConfig, devices } from '@playwright/test'
import { STORAGE_STATE } from './e2e/support/env'

/**
 * Four kinds of run live in one config, separated by project:
 *
 *  - `chromium` / `firefox` / `webkit` — the anonymous suite (CSP, the sign-in
 *    gateway, the public API). Cross-browser, because the CSP tests exist to
 *    catch engine-specific policy handling.
 *  - `auth setup` — mints ONE session and saves it as storage state. A project
 *    rather than a `globalSetup` function so that, when it cannot sign in, it
 *    appears in the report as a named skip with a reason instead of vanishing.
 *  - `authenticated` — the journeys, on Chromium only. A journey suite exists
 *    to catch product regressions, not rendering differences, and running nine
 *    journeys three times would triple the wall clock to re-answer a question
 *    the anonymous projects already ask.
 *  - `authenticated (limits)` — the free-tier ceiling, which SPENDS the test
 *    user's daily allowance and so must run after every other journey. Serial
 *    and last, by declaring the authenticated project as its dependency.
 */

/**
 * The builder's whole desktop action cluster — Save now, Publish, Run, the
 * panel toggles — is `hidden lg:flex`. Below the lg breakpoint those controls
 * are not in the accessibility tree at all, and every journey would fail on a
 * missing button rather than on the behaviour it means to test.
 */
const DESKTOP = { width: 1440, height: 900 }

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['github']] : 'list',
  use: { baseURL: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: process.env.E2E_BASE_URL ? undefined : {
    command: 'NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=e2e-anonymous-key npm run dev',
    url: 'http://127.0.0.1:3000', reuseExistingServer: !process.env.CI, timeout: 120_000,
  },
  projects: [
    // Anonymous. `testIgnore` keeps the authenticated tree out: those specs
    // require storage state these projects deliberately do not have.
    { name: 'chromium', testIgnore: ['journeys/**', 'auth.setup.ts'], use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', testIgnore: ['journeys/**', 'auth.setup.ts'], use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', testIgnore: ['journeys/**', 'auth.setup.ts'], use: { ...devices['Desktop Safari'] } },

    { name: 'auth setup', testMatch: 'auth.setup.ts', use: { ...devices['Desktop Chrome'] } },

    {
      name: 'authenticated',
      testDir: './e2e/journeys',
      testIgnore: ['free-tier-limit.spec.ts'],
      dependencies: ['auth setup'],
      use: { ...devices['Desktop Chrome'], viewport: DESKTOP, storageState: STORAGE_STATE },
    },

    {
      name: 'authenticated (limits)',
      testDir: './e2e/journeys',
      testMatch: 'free-tier-limit.spec.ts',
      // Runs only after every other journey has had its allowance, because
      // this one consumes it.
      dependencies: ['authenticated'],
      fullyParallel: false,
      workers: 1,
      use: { ...devices['Desktop Chrome'], viewport: DESKTOP, storageState: STORAGE_STATE },
    },
  ],
})
