import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Every file that writes an issue row must tell the funnel (services/issue-raise.ts): hit counters
// and the tracker rule engine hang off it. A new writer that skips it would be invisible to both.
const ROOT = join(import.meta.dirname, '..')

function sources(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name === 'migrations') continue
      out.push(...sources(p))
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) out.push(p)
  }
  return out
}

const WRITES = [
  /nivaro_issues'\)\s*\.insert/,
  /INSERT\s+INTO\s+nivaro_issues/i,
  /occurrence_count:\s*\w+\.raw\(/
]

describe('issue writers', () => {
  it('every file that inserts into nivaro_issues or bumps occurrence_count imports noteIssueWrite', () => {
    const writers = sources(ROOT).filter((f) => {
      const text = readFileSync(f, 'utf8')
      return WRITES.some((re) => re.test(text))
    })
    expect(writers.length).toBeGreaterThanOrEqual(8)
    const missing = writers
      .filter(
        (f) => !/import[^;]*\bnoteIssueWrite\b[^;]*issue-raise/s.test(readFileSync(f, 'utf8'))
      )
      .map((f) => f.slice(ROOT.length + 1))
    expect(missing, `issue writers that do not call noteIssueWrite: ${missing.join(', ')}`).toEqual(
      []
    )
  })
})
