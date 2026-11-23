import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CREATE_COPY } from './create-api'

// Admin review M-6: SHARED_PLACEMENT was defined in the CREATE_COPY literal and then overwritten
// by an Object.assign with another hint. One definition, the one people saw.
describe('CREATE_COPY', () => {
  it('SHARED_PLACEMENT is defined once and points at Place on shared deployment…', () => {
    const src = readFileSync(join(import.meta.dirname, 'create-api.ts'), 'utf8')
    expect(src.match(/\bSHARED_PLACEMENT:/g)).toHaveLength(1)
    expect(src).not.toMatch(/Object\.assign\(CREATE_COPY/)
    expect(CREATE_COPY.SHARED_PLACEMENT.hint).toMatch(/Place on shared deployment…/)
  })
})
