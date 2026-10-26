import { describe, expect, it } from 'vitest'
import { splitStartNote, splitStartOptions } from './PipelineEditorView'

const states = [
  { key: 'draft', label: 'Draft', is_terminal: false },
  { key: 'finance', label: 'Finance Review', is_terminal: false },
  { key: 'eng', label: 'Engineering Review', is_terminal: false },
  { key: 'done', label: 'Done', is_terminal: true }
]

describe('split "Starts from" picker', () => {
  it('offers non-terminal steps that are not branches', () => {
    expect(splitStartOptions(states, ['finance', 'eng'])).toEqual([
      { value: 'draft', label: 'Draft' }
    ])
    expect(splitStartOptions(states, []).map((o) => o.value)).toEqual(['draft', 'finance', 'eng'])
  })

  it('says who may run the split', () => {
    expect(splitStartNote(null)).toBe('No starting step: only an administrator can run this split.')
    expect(splitStartNote('Draft')).toContain('while the record is in Draft')
  })
})
