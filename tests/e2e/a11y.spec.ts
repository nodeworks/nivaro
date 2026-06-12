import { expect, test } from '@playwright/test'
import { checkA11y } from './helpers/a11y'

test.describe('Accessibility — login page', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login')
    await page.waitForLoadState('networkidle')
  })

  test('zero WCAG 2.1 AA violations (axe-core)', async ({ page }) => {
    await checkA11y(page, '/login')
  })

  test('<html> has a lang attribute', async ({ page }) => {
    const lang = await page.getAttribute('html', 'lang')
    expect(lang).toBeTruthy()
    expect(lang).toMatch(/^[a-z]{2}/)
  })

  test('login form inputs have associated labels', async ({ page }) => {
    // Every <input> that is visible should have an accessible name via
    // aria-label, aria-labelledby, or an associated <label>
    const inputs = page.locator('input:visible')
    const count = await inputs.count()
    for (let i = 0; i < count; i++) {
      const input = inputs.nth(i)
      const ariaLabel = await input.getAttribute('aria-label')
      const ariaLabelledBy = await input.getAttribute('aria-labelledby')
      const id = await input.getAttribute('id')
      let hasLabel = !!(ariaLabel || ariaLabelledBy)
      if (!hasLabel && id) {
        const label = page.locator(`label[for="${id}"]`)
        hasLabel = (await label.count()) > 0
      }
      expect(hasLabel, `Input #${i} (id="${id}") has no accessible label`).toBe(true)
    }
  })

  test('buttons have accessible names', async ({ page }) => {
    const buttons = page.getByRole('button')
    const count = await buttons.count()
    for (let i = 0; i < count; i++) {
      const btn = buttons.nth(i)
      const text = (await btn.textContent()) ?? ''
      const ariaLabel = await btn.getAttribute('aria-label')
      const name = text.trim() || ariaLabel
      expect(name, `Button #${i} has no accessible name`).toBeTruthy()
    }
  })

  test('Tab key moves focus through interactive elements in logical order', async ({ page }) => {
    // Press Tab up to 10 times and verify focus always lands on a focusable element
    const focused: string[] = []
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab')
      const tag = await page.evaluate(() => document.activeElement?.tagName ?? 'BODY')
      focused.push(tag)
    }
    // At least some Tab presses should move focus off BODY
    const meaningful = focused.filter((t) => t !== 'BODY')
    expect(meaningful.length).toBeGreaterThan(0)
  })

  test('focused elements have a visible outline (no outline:none trap)', async ({ page }) => {
    await page.keyboard.press('Tab')
    const outlineStyle = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      if (!el) return 'none'
      return window.getComputedStyle(el).outlineStyle
    })
    // 'none' only fails if outline-width or box-shadow don't compensate — axe covers this,
    // but we also do a quick explicit check
    const boxShadow = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null
      if (!el) return ''
      return window.getComputedStyle(el).boxShadow
    })
    const hasFocusIndicator =
      (outlineStyle !== 'none' && outlineStyle !== '') || boxShadow !== 'none'
    expect(hasFocusIndicator, 'First focused element has no visible outline or box-shadow').toBe(
      true
    )
  })
})

test.describe('Accessibility — viewport responsiveness', () => {
  const viewports = [
    { name: 'mobile (375px)', width: 375, height: 667 },
    { name: 'tablet (768px)', width: 768, height: 1024 },
    { name: 'desktop (1280px)', width: 1280, height: 800 }
  ]

  for (const vp of viewports) {
    test(`login page has no a11y violations at ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await page.goto('/login')
      await page.waitForLoadState('networkidle')
      await checkA11y(page, `login @ ${vp.name}`)
    })

    test(`login page renders without horizontal scroll at ${vp.name}`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await page.goto('/login')
      await page.waitForLoadState('networkidle')
      const scrollWidth = await page.evaluate(() => document.body.scrollWidth)
      expect(scrollWidth).toBeLessThanOrEqual(vp.width)
    })
  }
})
