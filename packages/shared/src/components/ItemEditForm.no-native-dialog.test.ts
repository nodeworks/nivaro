import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// army 10 item 3 (BLOCKER, staging 0.3.84): remove a material line on an IR,
// then BOM Re-Upload — the tab froze for good. The record form asked
// "Unsaved changes will be combined with the re-import staging. Continue?"
// through window.confirm. A native dialog blocks the page's thread; an
// automated tab (Claude in Chrome, Playwright without a dialog handler) and
// some embedded hosts can never answer it, and the pane stays "frozen". The
// review dialog is the confirmation — the form must never open a native one.
describe('the record form opens no native browser dialog', () => {
  it('ItemEditForm has no window.confirm / alert / prompt', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(join(here, 'ItemEditForm.tsx'), 'utf8')
    const hits = src.match(/window\.(confirm|alert|prompt)\(/g) ?? []
    expect(hits).toEqual([])
  })
})
