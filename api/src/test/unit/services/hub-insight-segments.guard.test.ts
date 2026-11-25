import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KNOWN_ROUTE_SEGMENTS } from '../../../services/hub-link/known-route-segments.js'

// Guard (Hub usage, review L5): screen masking keeps only the static segments of the admin's own
// routes (KNOWN_ROUTE_SEGMENTS) — anything else is reported as `:id`. A route added to the admin
// whose segment is missing from the list would silently show as `/:id`, so this fails first.

const ADMIN = join(import.meta.dirname, '../../../../../admin/src')

function adminSegments(): string[] {
  let src = ''
  for (const f of ['App.tsx', 'lib/hubs.ts']) src += readFileSync(join(ADMIN, f), 'utf8')
  const out = new Set<string>()
  for (const m of src.matchAll(
    /path=['"]([^'"]+)['"]|path: '([^']*)'|base: '([^']*)'|legacy: '([^']*)'/g
  ))
    for (const g of m.slice(1))
      for (const seg of String(g ?? '').split('/')) if (/^[a-z][a-z0-9_-]*$/.test(seg)) out.add(seg)
  return [...out].sort()
}

describe('known route segments', () => {
  it('lists every static segment of the admin routes', () => {
    const known = new Set(KNOWN_ROUTE_SEGMENTS)
    const missing = adminSegments().filter((s) => !known.has(s))
    expect(missing, 'add them to services/hub-link/known-route-segments.ts').toEqual([])
  })

  it('holds only plain lowercase words (never an id, a key or a name)', () => {
    for (const s of KNOWN_ROUTE_SEGMENTS) expect(s).toMatch(/^[a-z][a-z0-9_-]*$/)
    expect([...KNOWN_ROUTE_SEGMENTS].sort()).toEqual([...KNOWN_ROUTE_SEGMENTS])
  })
})
