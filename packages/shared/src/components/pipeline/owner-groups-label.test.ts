import { describe, expect, it } from 'vitest'
import { ownerGroupsLabel } from './PipelineEditorView'

describe('ownerGroupsLabel', () => {
  it('after the avatars: a "+" count with a thousands separator', () => {
    expect(ownerGroupsLabel(1679, null, true)).toBe('+1,679 more groups')
    expect(ownerGroupsLabel(6, 'Zone', true)).toBe('+6 by Zone')
  })

  it('on its own: no "+" and no "more"', () => {
    expect(ownerGroupsLabel(1679, null, false)).toBe('1,679 owner groups')
    expect(ownerGroupsLabel(1, null, false)).toBe('1 owner group')
    expect(ownerGroupsLabel(1679, 'Zone', false)).toBe('1,679 owner groups by Zone')
  })
})
