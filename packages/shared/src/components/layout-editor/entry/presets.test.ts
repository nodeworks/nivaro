import { describe, expect, it } from 'vitest'
import type { PlacementRow } from '../../../lib/layout-ops'
import { capturePreset, partsSet, presetOps, presetPatch, withPresets } from './presets'

const row = (over: Partial<PlacementRow> = {}): PlacementRow => ({
  field: 'title',
  group_key: 'main',
  sort: 0,
  label_override: null,
  is_visible: true,
  default_expanded: true,
  col_span: null,
  overrides: null,
  show_row_revisions: false,
  allow_revision_restore: null,
  lock_conditions: null,
  input_bindings: null,
  widget_id: null,
  show_approval_chain: false,
  ...over
})

describe('placement presets (#2702)', () => {
  it('offers the parts a field has set', () => {
    expect(partsSet(row())).toEqual([])
    expect(
      partsSet(row({ col_span: 6, overrides: { required: true, note: 'Use the PO number' } }))
    ).toEqual(['width', 'required', 'help'])
  })

  it('captures only the ticked parts and never the label', () => {
    const src = row({ col_span: 6, overrides: { label: 'Subject', required: true, note: 'x' } })
    const p = capturePreset('  Narrow required ', src, ['width', 'required'])
    expect(p.name).toBe('Narrow required')
    expect(p.col_span).toBe(6)
    expect(p.overrides).toEqual({ required: true })
    expect(p.parts).toEqual(['width', 'required'])
  })

  it('applies as a patch that keeps what the target already has', () => {
    const p = capturePreset('P', row({ col_span: 6, overrides: { required: true } }), [
      'width',
      'required'
    ])
    const target = row({ field: 'owner', col_span: 12, overrides: { label: 'Owner', note: 'hi' } })
    expect(presetPatch(p, target)).toEqual({
      col_span: 6,
      overrides: { label: 'Owner', note: 'hi', required: true }
    })
  })

  it('removes a setting the preset has unset', () => {
    const p = capturePreset('P', row({ overrides: { placeholder: 'x' } }), ['placeholder'])
    const bare = { ...p, overrides: undefined }
    const target = row({ overrides: { placeholder: 'old', label: 'L' } })
    expect(presetPatch(bare, target)).toEqual({ overrides: { label: 'L' } })
  })

  it('says nothing changes when the target already matches', () => {
    const p = capturePreset('P', row({ col_span: 6 }), ['width'])
    expect(presetPatch(p, row({ col_span: 6 }))).toBeNull()
  })

  it('makes one update_placement op per changed field', () => {
    const p = capturePreset('P', row({ col_span: 4 }), ['width'])
    const { ops, changed } = presetOps(p, [row({ field: 'a' }), row({ field: 'b', col_span: 4 })])
    expect(changed).toBe(1)
    expect(ops).toEqual([
      {
        op: 'update_placement',
        at: { field: 'a', group_key: 'main' },
        patch: { col_span: 4 }
      }
    ])
  })

  it('keeps the list within the limit and clean', () => {
    const p = capturePreset('P', row({ col_span: 4 }), ['width'])
    expect(withPresets({}, [p])?.presets?.[0].name).toBe('P')
    expect(withPresets({}, [])).toBeNull()
  })
})
