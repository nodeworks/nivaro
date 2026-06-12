import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'

/**
 * Run axe-core against the current page and throw a descriptive error if any
 * WCAG 2.1 AA violations are found.
 */
export async function checkA11y(page: Page, context?: string) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze()

  if (results.violations.length > 0) {
    const summary = results.violations
      .map(
        (v) =>
          `[${v.impact}] ${v.id}: ${v.description}\n  Elements: ${v.nodes.map((n) => n.target).join(', ')}`
      )
      .join('\n')
    throw new Error(`Accessibility violations${context ? ` on ${context}` : ''}:\n${summary}`)
  }
}
