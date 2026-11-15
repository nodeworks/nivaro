import { describe, expect, it } from 'vitest'
import { sourceSentence } from './FieldSourceBadge'
import {
  nextLineAfter,
  removedLineText,
  restorableLine,
  unsavedLineChanges,
  unsavedLineText
} from './removed-line'

describe('a line removed under you (rt7 #6)', () => {
  it('keeps only what the person typed and had not saved', () => {
    const stored = { id: 4, order: 9, qty: 2, price: '10.00', note: null, sort: 3 }
    const draft = { id: 4, order: 9, qty: 5, price: '10.00', note: 'rush', sort: 3 }
    expect(unsavedLineChanges(stored, draft, null, new Set(['order']))).toEqual({
      qty: 5,
      note: 'rush'
    })
    // A staged edit counts too; a draft equal to the stored value cancels it.
    expect(unsavedLineChanges(stored, { qty: 2 }, { qty: 7, price: '11.00' })).toEqual({
      price: '11.00'
    })
    expect(unsavedLineChanges(stored, stored, null)).toEqual({})
  })

  it('moves focus to the next line still there, else the one before', () => {
    const order = ['1', '2', '3', '4']
    expect(nextLineAfter(order, new Set(['1', '3', '4']), '2')).toBe('3')
    expect(nextLineAfter(order, new Set(['1', '2', '3']), '4')).toBe('3')
    expect(nextLineAfter(order, new Set(['1']), '3')).toBe('1')
    expect(nextLineAfter(order, new Set([]), '3')).toBeNull()
  })

  it('names who removed it', () => {
    expect(removedLineText({ at: '', who: 'Beth Ames', via: 'user' })).toBe(
      'Beth Ames removed this line'
    )
    expect(removedLineText({ at: '', who: 'procedure reforecast', via: 'procedure' })).toBe(
      'Procedure reforecast removed this line'
    )
    expect(removedLineText({ at: '', who: 'x', via: 'outside' })).toBe(
      'This line was removed outside the app'
    )
    expect(removedLineText({ at: '', who: 'Rob', via: 'user', user_id: 'me' }, 'ME')).toBe(
      'You removed this line in another tab'
    )
    expect(removedLineText(null)).toBe('This line was removed')
  })

  it('restores as a flat new line and copies as text', () => {
    expect(
      restorableLine({ id: 4, vendor: { id: 9, name: 'V' }, tags: [1], qty: 2 }, { qty: 5 })
    ).toEqual({ id: 4, vendor: 9, qty: 5 })
    expect(unsavedLineText({ qty: 5, note: 'rush' }, (f) => f.toUpperCase())).toBe(
      'QTY: 5\nNOTE: rush'
    )
  })
})

describe('value source sentence (rt7 #7)', () => {
  it('reads like a person would say it', () => {
    expect(sourceSentence({ who: 'Beth', via: 'user' })).toBe('Set by Beth')
    expect(
      sourceSentence({
        who: 'svc',
        via: 'integration',
        caller: { name: 'ERP Sync', kind: 'api_key', key: 'k' }
      })
    ).toBe('Set by ERP Sync')
    expect(sourceSentence({ who: 'import (po-lines)', via: 'import' })).toBe(
      'Set by import (po-lines)'
    )
    expect(sourceSentence({ who: 'procedure reforecast', via: 'procedure' })).toBe(
      'Set by procedure reforecast'
    )
    expect(sourceSentence({ who: 'x', via: 'outside' })).toBe('Changed outside the app')
    expect(sourceSentence({ who: 'system', via: 'system' })).toBe('Set by the system')
  })
})
