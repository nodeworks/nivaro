import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// Every scroll pane of a Hub page is a positioned element (2026-11-25). An `sr-only` label or a
// Radix hidden <select> inside a pane is `position: absolute`; with no positioned ancestor inside
// the pane it anchors to the page outlet instead, stretches the outlet past its height and lets
// the whole Hub page scroll on past its end (Apps → an app → Edit settings left ~360 px of blank
// page below the form). See gotchas "An sr-only (absolute) element inside a scroller".

const ROOT = join(import.meta.dirname)
/** Sheets are `position: fixed` already; adding `relative` there would fight it. */
const SKIP = new Set(['fleet/UptimeSheet.tsx'])

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return files(p)
    return p.endsWith('.tsx') && !p.includes('.test.') ? [p] : []
  })
}

describe('Hub scroll panes are positioned', () => {
  it('every class string with overflow-y-auto also sets a position', () => {
    const bad: string[] = []
    for (const f of files(ROOT)) {
      const rel = relative(ROOT, f)
      if (SKIP.has(rel)) continue
      const text = readFileSync(f, 'utf8')
      for (const m of text.matchAll(/(['"`])([^'"`\n]*\boverflow-y-auto\b[^'"`\n]*)\1/g)) {
        if (!/(^|\s)(relative|absolute|fixed|sticky)(\s|$)/.test(m[2])) bad.push(`${rel}: ${m[2]}`)
      }
    }
    expect(bad).toEqual([])
  })
})
