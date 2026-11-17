// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  HEADER_COPY_BESIDE_MARK,
  HEADER_MARK,
  HEADER_VALUE_AFTER_MARK,
  headerEstimateDenseWidth
} from '../../lib/header-strip'

// 2026-11-16 (Rob, EFP record page in Summary at ~1650 wide): the "changed by" ⓘ on a header
// tile sat on top of the value — "LINX ID NUVCPJ00057ⓘ21", "LINX PAYMENT STATUS Hold Final ⓘ10%".
// The mark was pinned `absolute top-2 right-6` for the STACKED tile (label over value, the label
// reserving pr-6), but the dense chips (label · value on one line) and the "+N more" list rows put
// the value on the mark's line. Now it rides in flow right after the label there.
const src = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8')
const classes = (s: string) => s.split(/\s+/)

describe('header tile "changed by" mark', () => {
  it('is pinned in the top-right corner only on stacked tiles', () => {
    const c = classes(HEADER_MARK)
    expect(c).toContain('absolute')
    expect(c).toContain('right-2')
    // Nothing to show = no box and no gap.
    expect(c).toContain('empty:hidden')
  })

  it('rides in flow after the label in dense chips and list rows, never over text', () => {
    const c = classes(HEADER_MARK)
    for (const fmt of ['data-header-dense', 'data-header-list']) {
      expect(c).toContain(`[[${fmt}]_&]:static`)
      expect(c).toContain(`[[${fmt}]_&]:order-1`)
      expect(c).toContain(`[[${fmt}]_&]:shrink-0`)
      expect(classes(HEADER_VALUE_AFTER_MARK)).toContain(`[[${fmt}]_&]:order-2`)
    }
  })

  it('ItemEditForm uses the shared classes for the mark and the value after it', () => {
    const form = src('../ItemEditForm.tsx')
    const at = form.indexOf('data-header-freshness\n')
    expect(at).toBeGreaterThan(-1)
    const mark = form.slice(at, at + 200)
    expect(mark).toMatch(/className=\{HEADER_MARK\}/)
    expect(mark).not.toMatch(/absolute/)
    // The field tile's value span (the one before the mark) follows it in dense / list.
    const value = form.slice(form.lastIndexOf('data-header-value\n', at), at)
    expect(value).toMatch(/HEADER_VALUE_AFTER_MARK/)
    // The label's stacked-only room for the pinned mark is dropped where the mark is in flow.
    const label = form.slice(form.lastIndexOf('data-header-label', at) - 600, at)
    for (const fmt of ['data-header-dense', 'data-header-list'])
      expect(label).toContain(
        `[[${fmt}]_[data-header-field]:has(>[data-header-freshness]>*)>&]:pr-0`
      )
  })

  // 2026-11-16 (Rob): the ⓘ owns the corner; Copy moves one slot left of it on stacked tiles
  // only, and keeps the corner in dense / list where the mark rides in flow.
  it('Copy sits left of a shown mark on stacked tiles, in the corner elsewhere', () => {
    const c = classes(HEADER_COPY_BESIDE_MARK)
    expect(c).toContain('right-2')
    expect(c).toContain('[[data-header-field]:has(>[data-header-freshness]>*)>&]:right-6')
    for (const fmt of ['data-header-dense', 'data-header-list'])
      expect(c).toContain(
        `[[${fmt}]_[data-header-field]:has(>[data-header-freshness]>*)>&]:right-2`
      )
    const form = src('../ItemEditForm.tsx')
    const at = form.indexOf('data-header-freshness\n')
    const after = form.slice(at, at + 3000)
    expect(after).toMatch(/<Check\s+className=\{cn\(\s*HEADER_COPY_BESIDE_MARK/)
    expect(after).toMatch(/aria-label='Copy value'\s+className=\{cn\(\s+HEADER_COPY_BESIDE_MARK/)
  })

  it('the dense width estimate counts a shown mark', () => {
    const tile = (withMark: boolean) => {
      const el = document.createElement('div')
      el.innerHTML = `<span data-header-label>LinX ID</span><span data-header-value>NUVCPJ0005721</span><span data-header-freshness>${withMark ? '<span>i</span>' : ''}</span>`
      for (const s of el.querySelectorAll<HTMLElement>('[data-header-label], [data-header-value]'))
        Object.defineProperty(s, 'scrollWidth', { value: 50 })
      return el
    }
    expect(headerEstimateDenseWidth(tile(true)) - headerEstimateDenseWidth(tile(false))).toBe(20)
  })
})
