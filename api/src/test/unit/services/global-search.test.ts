import { describe, expect, it } from 'vitest'
import { labelFor, scoreRow } from '../../../services/global-search.js'

describe('labelFor', () => {
  it('renders the display template when there is one', () => {
    expect(
      labelFor(
        { id: 1, workflow_id: 'AB26-1', name: 'Thing' },
        '{{workflow_id}} · {{name}}',
        'Workflow'
      )
    ).toBe('AB26-1 · Thing')
  })

  it('falls back through the usual naming columns', () => {
    expect(labelFor({ id: 2, title: 'A title' }, null, 'Workflow')).toBe('A title')
    expect(labelFor({ id: 3, subject: 'Subject' }, null, 'Workflow')).toBe('Subject')
    expect(labelFor({ id: 4, workflow_id: 'CR-9' }, null, 'Workflow')).toBe('CR-9')
  })

  it('never shows the primary key — an unnamed row shows the collection name', () => {
    expect(labelFor({ id: 7 }, null, 'Inventory Request')).toBe('Inventory Request')
    expect(labelFor({ id: 8, name: '   ' }, null, 'Inventory Request')).toBe('Inventory Request')
    // A template that renders only the pk is no label either.
    expect(labelFor({ id: 9 }, '{{id}}', 'Cifa Items')).toBe('Cifa Items')
    expect(labelFor({ id: 9, cifa_number: 'C-9' }, '#{{id}}', 'Cifa Items')).toBe('Cifa Items')
  })
})

describe('scoreRow', () => {
  const row = { id: 368808, workflow_id: 'AB26-77260', description: 'Canton grounding' }

  it('puts an exact id first — what someone pasting a reference wants', () => {
    expect(scoreRow(row, 'AB26-77260', '368808')).toEqual({ score: 100, matched: 'id' })
  })

  it('ranks exact label over prefix over contains', () => {
    expect(scoreRow(row, 'AB26-77260', 'AB26-77260').score).toBe(90)
    expect(scoreRow(row, 'AB26-77260', 'AB26').score).toBe(70)
    expect(scoreRow(row, 'AB26-77260', '77260').score).toBe(50)
  })

  it('is case-insensitive', () => {
    expect(scoreRow(row, 'AB26-77260', 'ab26-77260').score).toBe(90)
  })

  it('explains itself when the label does not contain the query', () => {
    const hit = scoreRow(row, 'AB26-77260', 'canton')
    expect(hit.matched).toBe('description')
    expect(hit.score).toBe(30)
  })

  it('scores a row that matches nothing at the floor, so the caller can drop it', () => {
    expect(scoreRow(row, 'AB26-77260', 'zzz').score).toBe(10)
  })
})
