import { describe, expect, it } from 'vitest'
import { versionNoteLabel } from './HistoryPanel'
import { humanizeOpError } from './useLayoutDraft'

describe('humanizeOpError', () => {
  it('hides raw keys', () => {
    expect(humanizeOpError('No group "__apply_values__"')).toBe(
      'That section is no longer on this form'
    )
    expect(humanizeOpError('"zone" is not placed in inv_basic')).toBe(
      'That field is no longer where it was'
    )
  })
  it('passes other messages through', () => {
    expect(humanizeOpError('Fields go in the tabs of a container')).toBe(
      'Fields go in the tabs of a container'
    )
  })
})

describe('versionNoteLabel', () => {
  it('says the version is the state before the edit', () => {
    expect(versionNoteLabel('Move field')).toBe('Before: Move field')
    expect(versionNoteLabel('before settings change')).toBe('before settings change')
  })
})
