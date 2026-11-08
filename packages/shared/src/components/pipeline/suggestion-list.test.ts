import { describe, expect, it } from 'vitest'
import { suggestionList } from './PipelineEditorView'

// Army 9 b11 N9-2: "it misses Project Type (wants 5)" printed an internal project-type id.
describe('suggestionList', () => {
  it('uses the server words when sent', () => {
    expect(suggestionList(['Project Type Small Electronics'], ['project_type (wants 5)'])).toBe(
      'Project Type Small Electronics'
    )
  })
  it('drops a bare id from the raw strings', () => {
    expect(suggestionList(undefined, ['project_type (wants 5)'])).not.toContain('5')
    expect(suggestionList([], ['zone (wants Zone 3)'])).toBe('zone (wants Zone 3)')
  })
})
