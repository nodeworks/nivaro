import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// 2026-11-13: a grid over 150 rows squeezed every column to ~22 px. The "Showing 150 of N
// rows" row used colSpan={99}; under `table-fixed` an overshooting colSpan is not clamped —
// the browser invents the missing columns and they take the width. Full-width rows span
// exactly the header's column count (nestedColSpan / colCount), never a literal.
describe('InlineTableField full-width rows', () => {
  it('never spans a literal column count', () => {
    const src = readFileSync(new URL('./InlineTableField.tsx', import.meta.url), 'utf8')
    expect(src.match(/colSpan=\{\d+\}/g) ?? []).toEqual([])
  })
})
