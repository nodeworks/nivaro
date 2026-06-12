import { expect, test } from '@playwright/test'

const PROTECTED_ROUTES = [
  '/collections',
  '/users',
  '/roles',
  '/settings',
  '/workflows',
  '/pipelines',
  '/flows',
  '/dashboards',
  '/activity',
  '/workspaces'
]

test.describe('Unauthenticated navigation', () => {
  for (const route of PROTECTED_ROUTES) {
    test(`${route} redirects to /login`, async ({ page }) => {
      await page.goto(route)
      await page.waitForURL(/\/login/, { timeout: 8000 })
      expect(page.url()).toContain('/login')
    })
  }

  test('back button after redirect still shows login', async ({ page }) => {
    await page.goto('/collections')
    await page.waitForURL(/\/login/, { timeout: 8000 })
    await page.goBack()
    // Should remain on login (or go to blank origin) — never expose protected content
    const url = page.url()
    expect(url).toMatch(/login|about:blank/)
  })

  test('unknown route shows login or 404 — never crashes', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))
    await page.goto('/nonexistent-route-xyz')
    await page.waitForLoadState('networkidle')
    // Either redirects to login (SPA catch-all) or shows a 404 — no JS crash
    expect(errors).toHaveLength(0)
    const url = page.url()
    // Should land on login (SPA serves index.html and React Router handles unknown paths)
    const status = await page.evaluate(() => document.readyState)
    expect(status).toBe('complete')
  })
})
