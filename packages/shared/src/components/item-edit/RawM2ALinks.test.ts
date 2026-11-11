import { describe, expect, it } from 'vitest'
import { m2aKindLabel, m2aLinkText } from './RawM2ALinks'

describe('raw edit M2A links', () => {
  it('names the kind of record a link points at', () => {
    expect(m2aKindLabel('directus_users')).toBe('Person')
    expect(m2aKindLabel('nivaro_users')).toBe('Person')
    expect(m2aKindLabel('additional_emails')).toBe('External email')
    expect(m2aKindLabel('')).toBe('Record')
  })

  it('reads name and email from a person or an external email alike', () => {
    expect(
      m2aLinkText({ first_name: 'B', last_name: 'Stansbury', email: 'bstansbury@dbcomminc.com' })
    ).toEqual({ name: 'B Stansbury', email: 'bstansbury@dbcomminc.com' })
    expect(m2aLinkText({ email: 'x@y.com' })).toEqual({ name: null, email: 'x@y.com' })
    expect(m2aLinkText(null)).toEqual({ name: null, email: null })
  })
})
