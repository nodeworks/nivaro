import { expect, test } from '@playwright/test'
import { checkA11y } from './helpers/a11y'

test.describe('Public routes', () => {
  test('GET /api/health returns 200 with a status field', async ({ request }) => {
    const res = await request.get('http://localhost:3055/api/health')
    expect(res.status()).toBe(200)
    const body = await res.json()
    expect(body).toHaveProperty('status')
  })

  test('root / redirects to login when unauthenticated', async ({ page }) => {
    await page.goto('/')
    await page.waitForURL(/\/login/, { timeout: 8000 })
    expect(page.url()).toContain('/login')
  })

  test('login page has no broken internal links', async ({ page }) => {
    await page.goto('/login')
    await page.waitForLoadState('networkidle')
    // Collect all hrefs on the login page
    const links = await page.$$eval('a[href]', (els) =>
      els
        .map((el) => (el as HTMLAnchorElement).href)
        .filter((h) => h.startsWith('http://localhost'))
    )
    for (const href of links) {
      const res = await page.request.get(href)
      expect(res.status(), `Broken link: ${href}`).not.toBe(404)
    }
  })

  test('login page passes WCAG 2.1 AA', async ({ page }) => {
    await page.goto('/login')
    await page.waitForLoadState('networkidle')
    await checkA11y(page, 'login page')
  })
})
