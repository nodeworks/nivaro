import { describe, expect, it } from 'vitest'
import { recordHeadingText } from '../ItemEditForm'

describe('recordHeadingText (army 6 M52)', () => {
  it('keeps a template that rendered readable text', () => {
    expect(recordHeadingText(' CR26-81413 ', { id: 360291 }, 'Workflow')).toBe('CR26-81413')
  })
  it('an empty template falls back to the name, never the row id', () => {
    expect(recordHeadingText(' - ', { id: 360291, name: 'Pole swap' }, 'Workflow')).toBe(
      'Pole swap'
    )
  })
  it('no name either: "<Singular> (no number)"', () => {
    expect(recordHeadingText('', { id: 360291 }, 'Workflow')).toBe('Workflow (no number)')
  })
})
