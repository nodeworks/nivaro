import { describe, expect, it } from 'vitest'
import { BodyIdMismatchError, takeBodyId } from '../../../services/body-id.js'

describe('takeBodyId (PATCH body repeating the record id, 2026-11-16)', () => {
  it('drops the same id so the UPDATE never sets an identity column', () => {
    const data: Record<string, unknown> = { id: 371515, description: 'x' }
    takeBodyId(data, '371515')
    expect(data).toEqual({ description: 'x' })
  })
  it('matches uuids case-blind', () => {
    const data: Record<string, unknown> = { id: 'abc-DEF', name: 'n' }
    takeBodyId(data, 'ABC-def')
    expect(data).toEqual({ name: 'n' })
  })
  it('drops an empty id', () => {
    const data: Record<string, unknown> = { id: null, name: 'n' }
    takeBodyId(data, 5)
    expect(data).toEqual({ name: 'n' })
  })
  it('refuses a body naming another record', () => {
    expect(() => takeBodyId({ id: 7 }, 8)).toThrow(BodyIdMismatchError)
  })
  it('leaves a body without id alone', () => {
    const data = { name: 'n' }
    takeBodyId(data, 5)
    expect(data).toEqual({ name: 'n' })
  })
})
