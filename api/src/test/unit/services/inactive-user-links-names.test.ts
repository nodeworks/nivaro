import { describe, expect, it, vi } from 'vitest'

// army6 M55: Inactive people listed anonymised accounts as
// "Redacted Redacted · Redacted_61713E40-…@redact.example.com".

vi.mock('../../../db/index.js', () => ({ db: Object.assign(() => ({}), { raw: () => ({}) }) }))

const { inactivePersonLabel } = await import('../../../services/inactive-user-links.js')

describe('inactivePersonLabel', () => {
  it('names an anonymised account "Former user" with no email', () => {
    expect(
      inactivePersonLabel({
        id: '61713E40-6BE2-4F44-B150-D26B06874919',
        first_name: 'Redacted',
        last_name: 'Redacted',
        email: 'Redacted_61713E40-6BE2-4F44-B150-D26B06874919@redact.example.com'
      })
    ).toEqual({ name: 'Former user', email: null, reason: 'anonymised' })
  })

  it('names a redacted account "Former user" too', () => {
    const r = inactivePersonLabel({
      first_name: 'Ann',
      last_name: 'Lee',
      email: 'a@x',
      is_redacted: 1
    })
    expect(r).toEqual({ name: 'Former user', email: null, reason: 'redacted' })
  })

  it('keeps a suspended person’s real name and email, never the row id', () => {
    expect(
      inactivePersonLabel({ id: 'U-1', first_name: 'Ann', last_name: 'Lee', email: 'a@x' })
    ).toEqual({ name: 'Ann Lee', email: 'a@x', reason: 'suspended' })
    expect(inactivePersonLabel({ id: 'U-1', email: null }).name).toBe('Unnamed person')
  })
})
