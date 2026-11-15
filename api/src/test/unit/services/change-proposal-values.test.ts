import { describe, expect, it } from 'vitest'
import {
  comparableValue,
  type ProposalFieldContext,
  type ProposalFieldMeta,
  parseProposalChanges,
  proposalKindOf,
  readProposedValue,
  sameProposalValue
} from '../../../services/change-proposal-values.js'

const ctx = (over: Partial<ProposalFieldContext> = {}): ProposalFieldContext => ({
  m2oTarget: null,
  alias: false,
  writable: null,
  readable: null,
  openFields: new Set(),
  isAdmin: false,
  ...over
})
const f = (over: Partial<ProposalFieldMeta> & { field: string }): ProposalFieldMeta => ({
  type: 'string',
  interface: 'input',
  ...over
})

describe('proposalKindOf — which fields a person may propose', () => {
  it('offers a plain field the person could write', () => {
    expect(proposalKindOf(f({ field: 'title' }), ctx())).toBe('text')
    expect(proposalKindOf(f({ field: 'name', type: 'text' }), ctx())).toBe('text')
    expect(
      proposalKindOf(f({ field: 'notes', type: 'text', interface: 'input-multiline' }), ctx())
    ).toBe('textarea')
    // Formatted text would lose its formatting in a plain box.
    expect(proposalKindOf(f({ field: 'body', type: 'text', interface: 'rich_text' }), ctx())).toBe(
      null
    )
    expect(proposalKindOf(f({ field: 'amount', type: 'decimal' }), ctx())).toBe('number')
    expect(proposalKindOf(f({ field: 'ok', type: 'boolean' }), ctx())).toBe('boolean')
    expect(proposalKindOf(f({ field: 'due', type: 'date' }), ctx())).toBe('date')
    expect(proposalKindOf(f({ field: 'at', type: 'dateTime' }), ctx())).toBe('datetime')
  })

  it('never offers a field outside the update or read list', () => {
    expect(proposalKindOf(f({ field: 'amount' }), ctx({ writable: new Set(['title']) }))).toBe(null)
    expect(proposalKindOf(f({ field: 'amount' }), ctx({ readable: new Set(['title']) }))).toBe(null)
    expect(proposalKindOf(f({ field: 'amount' }), ctx({ writable: new Set(['amount']) }))).toBe(
      'text'
    )
  })

  it('never offers read-only, hidden, audit, computed or id fields', () => {
    expect(proposalKindOf(f({ field: 'a', readonly: true }), ctx())).toBe(null)
    expect(proposalKindOf(f({ field: 'a', hidden: true }), ctx())).toBe(null)
    expect(proposalKindOf(f({ field: 'a', special: ['user-created'] }), ctx())).toBe(null)
    expect(proposalKindOf(f({ field: 'a', computed_type: 'write' }), ctx())).toBe(null)
    expect(proposalKindOf(f({ field: 'id' }), ctx())).toBe(null)
  })

  it('admin-only fields only for administrators', () => {
    const meta = f({ field: 'a', options: { admin_only_edit: true } })
    expect(proposalKindOf(meta, ctx())).toBe(null)
    expect(proposalKindOf(meta, ctx({ isAdmin: true }))).toBe('text')
  })

  it('leaves out the lock open fields — those are changed directly', () => {
    expect(
      proposalKindOf(f({ field: 'is_on_hold' }), ctx({ openFields: new Set(['is_on_hold']) }))
    ).toBe(null)
  })

  it('links: plain many-to-one only, never to a system table, never link lists or files', () => {
    expect(
      proposalKindOf(f({ field: 'vendor', type: 'uuid' }), ctx({ m2oTarget: 'vendors' }))
    ).toBe('relation')
    expect(
      proposalKindOf(f({ field: 'owner', type: 'uuid' }), ctx({ m2oTarget: 'nivaro_users' }))
    ).toBe(null)
    expect(proposalKindOf(f({ field: 'zones', type: 'alias' }), ctx({ alias: true }))).toBe(null)
    expect(proposalKindOf(f({ field: 'doc', type: 'uuid', interface: 'file' }), ctx())).toBe(null)
    expect(proposalKindOf(f({ field: 'meta', type: 'json' }), ctx())).toBe(null)
  })

  it('choices win over the column type', () => {
    expect(
      proposalKindOf(f({ field: 's', options: { choices: [{ text: 'A', value: 'a' }] } }), ctx())
    ).toBe('choice')
  })
})

describe('readProposedValue', () => {
  it('reads each kind and refuses junk in plain words', () => {
    const m = f({ field: 'x' })
    expect(readProposedValue('number', '1,250.5', m)).toEqual({ value: 1250.5 })
    expect(readProposedValue('number', 'abc', m)).toEqual({ error: 'must be a number' })
    expect(readProposedValue('boolean', 'true', m)).toEqual({ value: true })
    expect(readProposedValue('date', '2026-11-14T10:00:00Z', m)).toEqual({ value: '2026-11-14' })
    expect(readProposedValue('date', 'soon', m)).toEqual({ error: 'must be a date' })
    expect(readProposedValue('text', '', m)).toEqual({ value: null })
    expect(readProposedValue('relation', { id: 'abc' }, m)).toEqual({ value: 'abc' })
  })
  it('a choice must be one of the choices', () => {
    const m = f({ field: 's', options: { choices: [{ text: 'Open', value: 1 }] } })
    expect(readProposedValue('choice', '1', m)).toEqual({ value: 1 })
    expect(readProposedValue('choice', '2', m)).toEqual({ error: 'must be one of its choices' })
  })
})

describe('sameProposalValue', () => {
  it('compares stored and typed values in one shape', () => {
    expect(sameProposalValue(1250, '1250', 'number')).toBe(true)
    expect(sameProposalValue(new Date('2026-11-14T00:00:00Z'), '2026-11-14', 'date')).toBe(true)
    expect(sameProposalValue(true, 1, 'boolean')).toBe(true)
    expect(sameProposalValue('', null)).toBe(true)
    expect(
      sameProposalValue(
        'ABCDEF01-0000-0000-0000-000000000000',
        'abcdef01-0000-0000-0000-000000000000'
      )
    ).toBe(true)
    expect(sameProposalValue('a', 'b')).toBe(false)
    expect(comparableValue({ id: 7 }, 'relation')).toBe('7')
  })
})

describe('parseProposalChanges', () => {
  it('keeps well-formed rows only', () => {
    expect(
      parseProposalChanges(
        JSON.stringify([{ field: 'a', from: 1, to: 2 }, { field: 'bad name;', to: 1 }, null])
      )
    ).toEqual([{ field: 'a', from: 1, to: 2 }])
    expect(parseProposalChanges('not json')).toEqual([])
  })
})
