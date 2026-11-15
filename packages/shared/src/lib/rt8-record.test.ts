import { describe, expect, it } from 'vitest'
import { heldText, heldWhy } from '../components/item-edit/HeldEditsChip'
import {
  fieldStatus,
  formUpdatedText,
  layoutMayChange,
  splitUnsaved
} from '../components/item-edit/layout-switch'
import type { CMSField } from '../components/item-edit/types'
import {
  lineGroupCounts,
  resubmissionSummary,
  resubmissionTitle
} from '../components/panels/ResubmissionDiff'
import { countLabel, countStepOf } from './count-step'
import { compareFileMeta, versionedUrl } from './newer-file'
import { shouldTravel, travelPlan } from './track-travel'

describe('track travel (rt8 #17)', () => {
  const order = ['a', 'b', 'c', 'd', 'e']
  it('draws the crossed segments in order, then lands', () => {
    const p = travelPlan(order, { from: 'b', to: 'd', n: 1 })!
    expect(p.backward).toBe(false)
    expect([...p.segments.entries()]).toEqual([
      [1, 0],
      [2, p.seg]
    ])
    expect(p.arriveIndex).toBe(3)
    expect(p.arriveDelay).toBe(2 * p.seg)
  })
  it('a send back draws right to left', () => {
    const p = travelPlan(order, { from: 'D', to: 'a', n: 1 })!
    expect(p.backward).toBe(true)
    expect([...p.segments.keys()]).toEqual([2, 1, 0])
    expect(p.arriveIndex).toBe(0)
  })
  it('stays under a second for a long hop and skips unknown steps', () => {
    const long = Array.from({ length: 20 }, (_, i) => `s${i}`)
    const p = travelPlan(long, { from: 's0', to: 's19', n: 1 })!
    expect(p.arriveDelay).toBeLessThanOrEqual(19 * 90)
    expect(p.seg).toBeGreaterThanOrEqual(90)
    expect(travelPlan(order, { from: 'x', to: 'b', n: 1 })).toBe(null)
    expect(travelPlan(order, null)).toBe(null)
  })
  it('never for the first paint, an own move, Calm/Off or reduced motion', () => {
    expect(shouldTravel(null, 'b', { own: false, motion: true })).toBe(false)
    expect(shouldTravel('a', 'A', { own: false, motion: true })).toBe(false)
    expect(shouldTravel('a', 'b', { own: true, motion: true })).toBe(false)
    expect(shouldTravel('a', 'b', { own: false, motion: false })).toBe(false)
    expect(shouldTravel('a', 'b', { own: false, motion: true })).toBe(true)
  })
})

describe('folded line count (rt8 #20)', () => {
  it('shows the step only in Normal and only for a real change', () => {
    expect(countStepOf(12, 13, 'normal')).toEqual({ from: 12, to: 13 })
    expect(countStepOf(12, 13, 'calm')).toBe(null)
    expect(countStepOf(12, 12, 'normal')).toBe(null)
    expect(countStepOf(undefined, 3, 'normal')).toBe(null)
  })
  it('says 200+ at the read cap', () => {
    expect(countLabel(13)).toBe('13')
    expect(countLabel(200)).toBe('200+')
  })
})

describe('newer file (rt8 #19)', () => {
  const base = {
    id: 'f',
    filename_download: 'quote.pdf',
    filesize: 10,
    type: 'application/pdf',
    modified_on: '2026-11-01T10:00:00Z'
  }
  it('tells a rename from a replace, and a removal', () => {
    expect(compareFileMeta(base, base)).toEqual({ kind: 'none' })
    const renamed = { ...base, filename_download: 'quote v2.pdf', modified_on: 'later' }
    expect(compareFileMeta(base, renamed)).toMatchObject({
      kind: 'newer',
      renamed: 'quote v2.pdf',
      replaced: false
    })
    const replaced = { ...base, filesize: 12, modified_on: 'later' }
    expect(compareFileMeta(base, replaced)).toMatchObject({ kind: 'newer', replaced: true })
    expect(compareFileMeta(base, null)).toEqual({ kind: 'gone' })
    expect(compareFileMeta(null, base)).toEqual({ kind: 'none' })
  })
  it('cache-busts the newer version', () => {
    expect(versionedUrl('/api/files/f', base)).toBe('/api/files/f?v=2026-11-01T10%3A00%3A00Z')
    expect(versionedUrl('/api/files/f?x=1', base)).toContain('&v=')
    expect(versionedUrl('/api/files/f', null)).toBe('/api/files/f')
  })
})

describe('layout switch (rt8 #18)', () => {
  const f = (field: string, extra: Partial<CMSField> = {}) =>
    ({ field, hidden: false, readonly: false, ...extra }) as CMSField
  it('re-asks only for a rule field (or an unnamed write)', () => {
    const b = (changedFields: string[] | null, aspectsOnly = false) => ({
      changedFields,
      aspectsOnly,
      deleted: false
    })
    expect(layoutMayChange(b(['workflow_type']), ['workflow_type'])).toBe(true)
    expect(layoutMayChange(b(['notes']), ['workflow_type'])).toBe(false)
    expect(layoutMayChange(b(null), ['workflow_type'])).toBe(true)
    expect(layoutMayChange(b(null, true), ['workflow_type'])).toBe(false)
    expect(layoutMayChange(b(['workflow_type']), [])).toBe(false)
  })
  it('keeps unsaved values the new form lets the person edit, holds the rest', () => {
    const fields = [f('amount'), f('notes', { readonly: true }), f('vendor', { hidden: true })]
    expect(fieldStatus(fields, 'gone')).toBe('absent')
    const out = splitUnsaved(
      { amount: 5, notes: 'x', vendor: 3, gone: 'y', same: 1, $state: 'a' },
      { amount: 4, notes: '', vendor: 2, gone: null, same: 1 },
      fields
    )
    expect(out.keep).toEqual(['amount'])
    expect(out.held).toEqual([
      { field: 'notes', status: 'readonly' },
      { field: 'vendor', status: 'hidden' },
      { field: 'gone', status: 'absent' }
    ])
  })
  it('words the note and held values', () => {
    expect(formUpdatedText('Finance review')).toBe('Form updated for Finance review')
    expect(formUpdatedText(null)).toBe('Form updated')
    expect(heldText(null)).toBe('(empty)')
    expect(heldText(true)).toBe('Yes')
    expect(heldWhy('readonly')).toBe('read-only on this form')
  })
})

describe('resubmission strip words (rt8 #12)', () => {
  const sent = (by: string | null, byYou = false) => ({
    sent_back: { by, by_you: byYou, at: '', from_label: null, to_label: null, reason: null }
  })
  it('names who sent it back', () => {
    expect(resubmissionTitle(sent('Beth', true))).toBe('What changed since you sent it back')
    expect(resubmissionTitle(sent('Beth Lee'))).toBe('What changed since Beth Lee sent it back')
    expect(resubmissionTitle(sent(null))).toBe('What changed since it was sent back')
  })
  it('sums fields, lines and files', () => {
    const line = { collection: 'l', field: 'lines', label: 'Lines', items: [] }
    expect(
      resubmissionSummary({
        fields: [{ field: 'a', label: 'A', old: '', new: '1', by: null, at: '' }],
        lines: [{ ...line, added: 1, changed: 1, removed: 0 }],
        files: []
      })
    ).toBe('1 field · 2 lines changed')
    expect(resubmissionSummary({ fields: [], lines: [], files: [] })).toBe('Nothing changed')
    expect(lineGroupCounts({ added: 2, changed: 0, removed: 1 })).toBe('2 added, 1 removed')
  })
})
