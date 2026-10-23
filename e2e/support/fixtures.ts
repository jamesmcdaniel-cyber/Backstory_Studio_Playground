/**
 * The authenticated test fixture.
 *
 * Two jobs, and the second matters as much as the first:
 *
 *  1. Hand every journey a `workspace` describing WHO is signed in — the user
 *     and organization ids the seed helpers need, and whether this identity is
 *     exempt from the free-tier ceilings.
 *
 *  2. Refuse to run silently. The `workspace` fixture is `auto`, so a spec in
 *     an authenticated project cannot accidentally execute against an anonymous
 *     browser: if the auth setup could not sign in, every spec here reports
 *     SKIPPED with the reason the setup recorded, rather than failing with a
 *     redirect to /auth/login (which reads as a product bug) or passing against
 *     an empty page (which reads as nothing at all).
 */
import { readFileSync } from 'node:fs'
import { expect, test as base, type Locator, type Page } from '@playwright/test'
import { AUTH_MARKER, authSkipReason } from './env'
import { deleteFlow } from './api'

export interface Workspace {
  userId: string
  organizationId: string
  /** True when this identity holds `catalogue.review` and so bypasses every free-tier ceiling. */
  canReview: boolean
}

function readMarker(): { authenticated: boolean; reason?: string } & Partial<Workspace> {
  try {
    return JSON.parse(readFileSync(AUTH_MARKER, 'utf8'))
  } catch {
    return {
      authenticated: false,
      reason:
        `${AUTH_MARKER} is missing — the "auth setup" project did not run. ` +
        'Run the authenticated project (npm run test:e2e:auth), not a bare `playwright test <file>`.',
    }
  }
}

/** Flows each page created through {@link createBlankFlow}, deleted when its test ends. */
const createdFlows = new WeakMap<Page, string[]>()

export const test = base.extend<{ workspace: Workspace; flowCleanup: void }>({
  workspace: [
    async ({}, use, testInfo) => {
      const marker = readMarker()
      testInfo.skip(!marker.authenticated, marker.reason ?? authSkipReason() ?? 'no authenticated session')
      await use({
        userId: marker.userId!,
        organizationId: marker.organizationId!,
        canReview: Boolean(marker.canReview),
      })
    },
    { auto: true },
  ],
  // Every flow a journey creates is deleted through the API when the test
  // ends, pass or fail — so CI with only the five required secrets (no
  // database URL) still leaves the workspace as it found it. Deleting a flow
  // cascades its runs, which also hands the daily run allowance back.
  flowCleanup: [
    async ({ page }, use) => {
      await use()
      for (const id of createdFlows.get(page) ?? []) await deleteFlow(page.request, id).catch(() => undefined)
    },
    { auto: true },
  ],
})

export { expect }

/** Prefix on every flow this suite creates, so cleanup can never touch a real one. */
export const E2E_FLOW_PREFIX = 'E2E '

/**
 * Create a blank flow through the UI and return its id.
 *
 * Goes through the real dialog rather than POSTing /api/flows, because "New
 * flow → Blank flow lands you in the builder" is itself part of the build
 * journey and has no other coverage. Specs that only need A flow to exist can
 * still call this — the extra two clicks buy a genuine assertion.
 */
export async function createBlankFlow(page: Page): Promise<string> {
  await page.goto('/flows')
  await page.getByRole('button', { name: 'New flow' }).click()
  // The dialog offers four starting points; "Blank flow" is the only one that
  // creates immediately and navigates.
  await page.getByRole('button', { name: /blank flow/i }).click()
  await page.waitForURL(/\/flows\/[^/?]+/)
  const id = new URL(page.url()).pathname.split('/').pop()!
  expect(id, 'the builder URL carried no flow id').toBeTruthy()
  createdFlows.set(page, [...(createdFlows.get(page) ?? []), id])
  return id
}

/**
 * The builder header's name INPUT (`aria-label="Flow name"`) — not a heading,
 * there is no <h1> for it. Matched as a textbox by exact name because the
 * header's icon button ("Edit flow name, description, and icon") also matches
 * a bare getByLabel('Flow name').
 */
export function flowNameField(page: Page): Locator {
  return page.getByRole('textbox', { name: 'Flow name', exact: true })
}

/**
 * Rename the open flow, so every artifact this suite leaves behind is
 * identifiable and the cleanup prefix actually matches something.
 */
export async function renameFlow(page: Page, name: string): Promise<void> {
  const field = flowNameField(page)
  await field.fill(name)
  await field.blur()
}

/**
 * The builder's desktop action cluster (Save now / Publish / Run / the panel
 * toggles) is `hidden lg:flex`. Below the lg breakpoint those controls do not
 * exist in the accessibility tree at all and every journey here would fail on
 * an invisible button rather than on the behaviour it is testing.
 */
export const DESKTOP_VIEWPORT = { width: 1440, height: 900 }
