import { describe, expect, it } from 'vitest'

import {
  aliasReadable,
  m2aIdKey,
  m2aItemFields,
  m2aReadCollection,
  parseAllowedList,
  peopleFields,
  peopleReadable
} from '../../../services/m2a-expand.js'

describe('parseAllowedList', () => {
  it('reads a legacy comma list, a JSON array and an array', () => {
    expect(parseAllowedList('additional_emails,directus_users')).toEqual([
      'additional_emails',
      'directus_users'
    ])
    expect(parseAllowedList('["vendors", "nivaro_users"]')).toEqual(['vendors', 'nivaro_users'])
    expect(parseAllowedList(['a', 'b'])).toEqual(['a', 'b'])
    expect(parseAllowedList(null)).toEqual([])
    expect(parseAllowedList('')).toEqual([])
  })
})

describe('m2aReadCollection', () => {
  const allowed = ['additional_emails', 'directus_users']
  it('maps legacy people to nivaro_users', () => {
    expect(m2aReadCollection('directus_users', allowed)).toBe('nivaro_users')
    expect(m2aReadCollection('DIRECTUS_USERS', allowed)).toBe('nivaro_users')
  })
  it('keeps an allowed business collection', () => {
    expect(m2aReadCollection('additional_emails', allowed)).toBe('additional_emails')
  })
  it('refuses a collection the relation does not allow', () => {
    expect(m2aReadCollection('workflows', allowed)).toBeNull()
    expect(m2aReadCollection(null, allowed)).toBeNull()
    expect(m2aReadCollection('', allowed)).toBeNull()
  })
})

describe('m2aItemFields', () => {
  it('reads the whole item for * and item.*', () => {
    expect(m2aItemFields(['*'], 'collection')).toEqual(['*'])
    expect(m2aItemFields(['item.*'], 'collection')).toEqual(['*'])
    expect(m2aItemFields(['item'], 'collection')).toEqual(['*'])
  })
  it('narrows the item to the named fields', () => {
    expect(m2aItemFields(['item.email', 'item.first_name'], 'collection')).toEqual([
      'email',
      'first_name'
    ])
    expect(m2aItemFields(['email', 'collection', 'id'], 'collection')).toEqual(['email'])
  })
  it('skips the item when only link keys are asked', () => {
    expect(m2aItemFields(['id', 'collection', 'item_id'], 'collection')).toEqual([])
  })
})

describe('m2aIdKey', () => {
  it('compares ids case-insensitively', () => {
    expect(m2aIdKey('7a0411f3-c687')).toBe(m2aIdKey('7A0411F3-C687'))
    expect(m2aIdKey(12)).toBe('12')
  })
})

describe('aliasReadable (narrowed policy field list)', () => {
  it('reads a relation only when the field list names it', () => {
    expect(aliasReadable('internal_contact', null)).toBe(true)
    expect(aliasReadable('internal_contact', ['*'])).toBe(true)
    expect(aliasReadable('internal_contact', ['id', 'internal_contact'])).toBe(true)
    expect(aliasReadable('internal_contact', ['id', 'name'])).toBe(false)
    expect(aliasReadable('lines', [])).toBe(false)
  })
})

describe('peopleFields', () => {
  it('never reaches past the directory projection', () => {
    const cols = peopleFields(['static_token', 'phone', 'preferences', 'password_hash', 'email'])
    expect(cols).toEqual(['id', 'email'])
    expect(peopleFields(['*'])).not.toContain('static_token')
    expect(peopleFields(['*'])).not.toContain('preferences')
    expect(peopleFields(['*'])).not.toContain('phone')
    expect(peopleFields(['*'])).toContain('email')
  })
})

describe('peopleReadable (narrowed API key)', () => {
  it('follows the key scopes', () => {
    expect(peopleReadable(undefined)).toBe(true)
    expect(peopleReadable([{ collection: '*', actions: ['*'] }])).toBe(true)
    expect(peopleReadable([{ collection: 'nivaro_users', actions: ['read'] }])).toBe(true)
    expect(peopleReadable([{ collection: 'inventory_request', actions: ['read'] }])).toBe(false)
    expect(peopleReadable([{ collection: 'nivaro_users', actions: ['update'] }])).toBe(false)
    expect(peopleReadable([])).toBe(false)
  })
})
