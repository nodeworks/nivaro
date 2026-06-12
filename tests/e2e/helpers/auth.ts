import type { Page } from '@playwright/test'

/**
 * Nivaro uses Microsoft OIDC in production. In E2E we verify the login page
 * renders correctly and the Microsoft auth button is present — we don't
 * complete the OIDC flow without a real tenant.
 */
export async function expectLoginPage(page: Page) {
  await page.goto('/login')
  await page.waitForSelector(
    '[data-testid="login-button"], button:has-text("Continue with Microsoft"), a:has-text("Microsoft")',
    { timeout: 5000 }
  )
}

/**
 * Assert that a given path redirects to the login page when unauthenticated.
 */
export async function expectRedirectToLogin(page: Page, path: string) {
  await page.goto(path)
  await page.waitForURL(/\/login/, { timeout: 5000 })
}
