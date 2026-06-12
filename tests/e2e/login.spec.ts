import { expect, test } from '@playwright/test'
import { checkA11y } from './helpers/a11y'

test.describe('Login page', () => {
  test('redirects unauthenticated visitors to /login', async ({ page }) => {
    await page.goto('/')
    await page.waitForURL(/\/login/, { timeout: 8000 })
    expect(page.url()).toContain('/login')
  })

  test('page title contains Nivaro or Login', async ({ page }) => {
    await page.goto('/login')
    const title = await page.title()
    expect(title.toLowerCase()).toMatch(/nivaro|login/)
  })

  test('Microsoft login button is visible', async ({ page }) => {
    await page.goto('/login')
    const btn = page
      .getByRole('button', { name: /microsoft/i })
      .or(page.getByRole('link', { name: /microsoft/i }))
    await expect(btn.first()).toBeVisible({ timeout: 8000 })
  })

  test('no JavaScript errors on login page', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(err.message))
    await page.goto('/login')
    await page.waitForLoadState('networkidle')
    expect(errors).toHaveLength(0)
  })

  test('login page passes WCAG 2.1 AA accessibility check', async ({ page }) => {
    await page.goto('/login')
    await page.waitForLoadState('networkidle')
    await checkA11y(page, '/login')
  })
})
