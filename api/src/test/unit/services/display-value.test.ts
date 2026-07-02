import { describe, expect, it } from 'vitest'
import { extractTemplateFields, resolveDisplayValue } from '../../../services/display-value.js'

describe('resolveDisplayValue', () => {
  it('renders a template with a single placeholder', () => {
    expect(resolveDisplayValue({ title: 'Node Splits' }, '{{title}}')).toBe('Node Splits')
  })

  it('renders a template with multiple placeholders', () => {
    expect(
      resolveDisplayValue({ first_name: 'Ada', last_name: 'Lovelace' }, '{{first_name}} {{last_name}}')
    ).toBe('Ada Lovelace')
  })

  it('resolves a nested placeholder against a nested object', () => {
    expect(resolveDisplayValue({ author: { name: 'Grace' } }, '{{author.name}}')).toBe('Grace')
  })

  it('falls back to first_name/last_name when no template is given', () => {
    expect(resolveDisplayValue({ first_name: 'Ada', last_name: 'Lovelace' }, null)).toBe('Ada Lovelace')
  })

  it('falls back to the LABEL_FALLBACK field list when no template and no name fields', () => {
    expect(resolveDisplayValue({ id: 42, title: 'Q3 Launch' }, null)).toBe('Q3 Launch')
  })

  it('falls back to id when nothing else is available', () => {
    expect(resolveDisplayValue({ id: 42 }, null)).toBe('42')
  })
})

describe('extractTemplateFields', () => {
  it('extracts the top-level field of each placeholder, always including id', () => {
    expect(extractTemplateFields('{{first_name}} {{last_name}}')).toEqual(
      expect.arrayContaining(['id', 'first_name', 'last_name'])
    )
  })

  it('extracts only the top-level segment of a nested placeholder', () => {
    expect(extractTemplateFields('{{author.name}}')).toEqual(expect.arrayContaining(['id', 'author']))
  })

  it('returns just id when there is no template', () => {
    expect(extractTemplateFields(null)).toEqual(['id'])
  })

  it('dedupes a field referenced more than once', () => {
    expect(extractTemplateFields('{{title}} — {{title}}')).toEqual(['id', 'title'])
  })
})
