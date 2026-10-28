import { describe, expect, it } from 'vitest'
import { labelColumnsFor } from './label-search-fields-setting'

// The preview line names what a labels-only search matches today: the display
// template's text fields, else the first name-like or *_id text column.
describe('labelColumnsFor', () => {
  const text = ['request_number', 'name', 'project', 'notes']

  it('reads the template’s text fields, in order, once', () => {
    expect(labelColumnsFor('{{request_number}} — {{name}} ({{request_number}})', text)).toEqual([
      'request_number',
      'name'
    ])
  })

  it('a template showing no text field matches nothing', () => {
    expect(labelColumnsFor('{{id}} {{amount}}', text)).toEqual([])
  })

  it('without a template: the first name-like field, else a business id', () => {
    expect(labelColumnsFor(null, text)).toEqual(['name'])
    expect(labelColumnsFor('  ', ['order_id', 'notes'])).toEqual(['order_id'])
    expect(labelColumnsFor(undefined, ['notes'])).toEqual([])
  })
})
