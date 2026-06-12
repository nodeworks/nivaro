import { test as base, chromium } from '@playwright/test'

const CDP_ENDPOINT = process.env.CDP_ENDPOINT ?? 'http://localhost:9222'

// Replaces the browser fixture with a CDP connection to your existing Chrome.
// Chrome must be running with --remote-debugging-port=9222.
// Since DevTools MCP uses the same port, your current browser session qualifies.
export const test = base.extend<object, { browser: import('@playwright/test').Browser }>({
  browser: [
    async ({}, use) => {
      const browser = await chromium.connectOverCDP(CDP_ENDPOINT)
      await use(browser)
      // Intentionally not closed — it's the user's browser
    },
    { scope: 'worker' }
  ]
})

export { expect } from '@playwright/test'
