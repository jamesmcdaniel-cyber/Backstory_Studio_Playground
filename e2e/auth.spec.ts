import { expect, test } from '@playwright/test'

test('protected application pages redirect anonymous users to authentication', async ({ page }) => {
  await page.goto('/flows')
  await expect(page).toHaveURL(/\/auth/)
})

test('enterprise SSO is available from the authentication gateway', async ({ page }) => {
  await page.goto('/auth')
  await expect(page.getByText(/enterprise sso/i)).toBeVisible()
  await expect(page.getByRole('textbox')).toBeVisible()
})
