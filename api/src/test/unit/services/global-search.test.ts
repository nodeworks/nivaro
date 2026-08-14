import { describe, expect, it } from 'vitest'
import { labelFor, scoreRow } from '../../../services/global-search.js'

describe('labelFor', () => {
  it('renders the display template when there is one', () => {
    expect(labelFor({ id: 1, workflow_id: 'PW26-1', name: 'Thing' }, '{{workflow_id}} · {{name}}')).toBe(
      'PW26-1 · Thing'
    )
  })

  it('falls back through the usual naming columns', () => {
    expect(labelFor({ id: 2, title: 'A title' }, null)).toBe('A title')
    expect(labelFor({ id: 3, subject: 'Subject' }, null)).toBe('Subject')
    expect(labelFor({ id: 4, workflow_id: 'CR-9' }, null)).toBe('CR-9')
  })

  it('never renders empty — an unnamed row still identifies itself', () => {
    expect(labelFor({ id: 7 }, null)).toBe('#7')
    expect(labelFor({ id: 8, name: '   ' }, null)).toBe('#8')
  })
})

describe('scoreRow', () => {
  const row = { id: 368808, workflow_id: 'PW26-77260', description: 'Canton grounding' }

  it('puts an exact id first — what someone pasting a reference wants', () => {
    expect(scoreRow(row, 'PW26-77260', '368808')).toEqual({ score: 100, matched: 'id' })
  })

  it('ranks exact label over prefix over contains', () => {
    expect(scoreRow(row, 'PW26-77260', 'PW26-77260').score).toBe(90)
    expect(scoreRow(row, 'PW26-77260', 'PW26').score).toBe(70)
    expect(scoreRow(row, 'PW26-77260', '77260').score).toBe(50)
  })

  it('is case-insensitive', () => {
    expect(scoreRow(row, 'PW26-77260', 'pw26-77260').score).toBe(90)
  })

  it('explains itself when the label does not contain the query', () => {
    const hit = scoreRow(row, 'PW26-77260', 'canton')
    expect(hit.matched).toBe('description')
    expect(hit.score).toBe(30)
  })

  it('scores a row that matches nothing at the floor, so the caller can drop it', () => {
    expect(scoreRow(row, 'PW26-77260', 'zzz').score).toBe(10)
  })
})
