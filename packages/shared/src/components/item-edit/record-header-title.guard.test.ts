import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// 2026-11-16 (Rob): at narrower widths the record id (CM26-73975) vanished from the record
// header while "Changed after approval · 6" and "Help requested by …" kept their room. The id
// never shrinks (only a title wider than the whole row is cut), the chips truncate instead,
// and once the row wraps the title block keeps the back arrow's line.
const src = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8')

const classOf = (code: string, marker: string) => {
  const at = code.indexOf(marker)
  expect(at, `${marker} present`).toBeGreaterThan(-1)
  // The element's attributes: up to the tag's end (`)}\n>` or `'\n>`), a few lines on.
  return code.slice(at, at + 600)
}

describe('record header title', () => {
  const form = src('../ItemEditForm.tsx')

  it('the record id never shrinks beside the chips', () => {
    const h1 = classOf(form, 'data-nvr-record-title')
    expect(h1).toMatch(/\bshrink-0\b/)
    expect(h1).toMatch(/\bmax-w-full\b/)
    expect(h1).not.toMatch(/\bmin-w-0\b/)
  })

  it('the title copy button always shows, in the same box as the pin', () => {
    const copy = classOf(form, 'data-nvr-title-copy\n')
    expect(copy).not.toMatch(/\bopacity-0\b/)
    expect(copy).toMatch(/\bh-6 w-6\b/)
    expect(copy).toMatch(/\btext-slate-400\b/)
  })

  it("the back arrow sits on the id's line, not the middle of the title block", () => {
    const back = classOf(form, 'data-nvr-header-back')
    expect(back).toMatch(/\bself-start\b/)
    expect(back).toMatch(/-mt-1\.5\b/)
  })

  it('the title block grows from its floor once the row wraps', () => {
    const block = classOf(form, 'data-nvr-header-title')
    // Wrapped stage: the rest of the arrow's line, so the actions always drop under the title.
    expect(block).toContain('[[data-nvr-header-wrap]>&]:flex-[1_1_calc(100%-2.75rem)]')
    expect(block).toContain('max-md:flex-1')
  })

  it('the chips beside it truncate rather than overflow the row', () => {
    expect(src('./ChangedAfterApprovalBadge.tsx')).toMatch(/min-w-0 max-w-full shrink-0/)
    expect(src('./ChangedAfterApprovalBadge.tsx')).toContain(
      "<span className='truncate'>Changed after approval</span>"
    )
    expect(src('./RecordHelpChip.tsx')).toContain('max-w-[min(16rem,100%)]')
  })
})
