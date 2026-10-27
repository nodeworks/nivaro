import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// M31 (security audit 2026-10-27): Chromium runs with --no-sandbox (no container sandbox is
// available), so every page the API opens must intercept its requests and refuse everything
// but inline content (data:, blob:, about:blank) and the instance's own origins — a document or
// card can never read the server's disk (file:) or reach the metadata endpoint. Today that is
// htmlToPdfLocal (pdfRequestAllowed, JS off), the help-video cards and the annotation overlays
// (about:blank + data: only). This guard fails when a new `newPage()` appears without it.
//
// The session-replay WebM export is out of scope here by decision (left exactly as it is).

const SRC = fileURLToPath(new URL('../../', import.meta.url))
const EXEMPT = new Set(['services/session-replay-export.ts'])

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'test') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) out.push(p)
  }
  return out
}

const count = (s: string, re: RegExp) => (s.match(re) ?? []).length

describe('Chromium pages intercept every request (M31)', () => {
  const files = walk(SRC)
    .map((p) => ({ rel: relative(SRC, p), text: readFileSync(p, 'utf8') }))
    .filter((f) => /\.newPage\(/.test(f.text) && !EXEMPT.has(f.rel))

  it('finds the known Chromium pages', () => {
    expect(files.map((f) => f.rel).sort()).toEqual(
      expect.arrayContaining([
        'services/help-video-annotations.ts',
        'services/help-video-cards.ts',
        'services/pdf-layout.ts'
      ])
    )
  })

  it('every newPage() turns request interception on and aborts what it refuses', () => {
    for (const f of files) {
      const pages = count(f.text, /\.newPage\(/g)
      const intercepts = count(f.text, /setRequestInterception\(true\)/g)
      expect(intercepts, `${f.rel}: ${pages} newPage() but ${intercepts} interceptions`).toBe(pages)
      expect(f.text, `${f.rel} must abort refused requests`).toMatch(/abort\('blockedbyclient'\)/)
    }
  })

  it('the inline-only pages allow nothing but about:blank and data:', () => {
    for (const rel of ['services/help-video-cards.ts', 'services/help-video-annotations.ts']) {
      const text = files.find((f) => f.rel === rel)?.text ?? ''
      expect(text).toMatch(/url === 'about:blank' \|\| url\.startsWith\('data:'\)/)
    }
  })
})
