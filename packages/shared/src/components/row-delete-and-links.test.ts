import { describe, expect, it } from 'vitest'
import { roleMayDelete } from './CollectionBrowserView'
import { menuRight } from './item-edit/HeaderTools'
import { explainMissing } from './panels/AccessDeniedPanel'
import { activityLinkable } from './profile/PersonActivity'

describe('row menu Delete', () => {
  it('is offered only when the role may delete in the collection', () => {
    const approver = {
      is_admin: false,
      collections: [{ collection: 'workflows', actions: ['read', 'update'] }]
    }
    expect(roleMayDelete(approver, 'workflows')).toBe(false)
    expect(roleMayDelete(undefined, 'workflows')).toBe(false)
    const deleter = {
      is_admin: false,
      collections: [{ collection: 'workflows', actions: ['read', 'delete'] }]
    }
    expect(roleMayDelete(deleter, 'workflows')).toBe(true)
    expect(roleMayDelete(deleter, 'invoices')).toBe(false)
    expect(roleMayDelete({ collections: [{ collection: '*', actions: ['*'] }] }, 'x')).toBe(true)
    expect(roleMayDelete({ is_admin: true }, 'workflows')).toBe(true)
  })
})

describe('header More menu on a phone', () => {
  it('keeps the 240px panel inside the host', () => {
    // Button near the left edge of a 390px sheet: right offset 340 would put
    // the panel's left edge at -190.
    expect(menuRight(340, 390)).toBe(390 - 240 - 8)
    expect(menuRight(20, 1440)).toBe(20)
    expect(menuRight(-5, 1440)).toBe(8)
  })
})

describe('access panel', () => {
  it('reads an explain 404 as "no such record" (either client shape)', () => {
    expect(explainMissing({ status: 404 })).toBe(true)
    expect(explainMissing({ response: { status: 404 } })).toBe(true)
    expect(explainMissing({ status: 403 })).toBe(false)
    expect(explainMissing(null)).toBe(false)
  })
})

describe('people page activity links', () => {
  it('links records, never system objects or deleted rows', () => {
    expect(activityLinkable({ action: 'update', collection: 'workflows', item: '1' })).toBe(true)
    expect(
      activityLinkable({ action: 'run', collection: 'nivaro_custom_queries', item: '64' })
    ).toBe(false)
    expect(
      activityLinkable({ action: 'delete', collection: 'workflows_divisions', item: '473841' })
    ).toBe(false)
    expect(activityLinkable({ action: 'update', collection: null, item: null })).toBe(false)
  })
})
