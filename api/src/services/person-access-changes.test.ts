import { describe, expect, it } from 'vitest'
import { describeAccessChange, scopeChangeComment } from './person-access-changes.js'

/** Access changes made TO a person, as lines on their profile's Activity feed. */

const GRANTEE = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const base = {
  id: 1,
  user: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  timestamp: '2026-11-12T15:00:00.000Z',
  collection: 'workflows',
  item: '365984',
  record_label: 'CM26-365984 · Splice, Oak Ave',
  collection_label: 'Workflows'
}
const ctx = { actor: 'Rob Lee', roleNames: new Map<string, string>(), dimensionLabels: new Map() }

describe('describeAccessChange', () => {
  it('says who granted what, and what the grant changed', () => {
    expect(
      describeAccessChange(
        {
          ...base,
          action: 'access-request-grant',
          comment: `for user ${GRANTEE} (Add CHI to their Region filter; Give their role read access to workflows)`
        },
        ctx
      )
    ).toEqual({
      summary: 'Access granted to Workflow CM26-365984 · Splice, Oak Ave by Rob Lee',
      detail: 'Added CHI to their Region filter · Gave their role read access to workflows'
    })
  })

  it('says a partial grant is partial and what still blocks it', () => {
    const d = describeAccessChange(
      {
        ...base,
        action: 'access-request-grant',
        comment: `partial for user ${GRANTEE}: Add CHI to their Region filter — still blocked: A row-level rule hides it.`
      },
      ctx
    )
    expect(d?.summary).toBe(
      'Access partly granted to Workflow CM26-365984 · Splice, Oak Ave by Rob Lee'
    )
    expect(d?.detail).toBe(
      'Added CHI to their Region filter · Still blocked: A row-level rule hides it.'
    )
  })

  it('names a declined request and a collection-wide grant', () => {
    expect(
      describeAccessChange(
        { ...base, action: 'access-request-deny', comment: `for user ${GRANTEE}` },
        ctx
      )?.summary
    ).toBe('Access to Workflow CM26-365984 · Splice, Oak Ave declined by Rob Lee')
    expect(
      describeAccessChange(
        {
          ...base,
          item: null,
          record_label: null,
          action: 'access-request-grant',
          comment: `for user ${GRANTEE}`
        },
        ctx
      )
    ).toEqual({ summary: 'Access granted to Workflows by Rob Lee', detail: null })
  })

  it('never shows a record id when the record has no label', () => {
    const d = describeAccessChange(
      {
        ...base,
        record_label: null,
        action: 'access-request-grant',
        comment: `for user ${GRANTEE}`
      },
      ctx
    )
    expect(d?.summary).toBe('Access granted to a workflow record by Rob Lee')
  })

  it('reads a User Scopes change by its dimension label', () => {
    expect(
      describeAccessChange(
        {
          ...base,
          action: 'update',
          collection: 'nivaro_user_scopes',
          item: `${GRANTEE}:region:restrict`,
          comment: null,
          record_label: null
        },
        { ...ctx, dimensionLabels: new Map([['region', 'Region']]) }
      )
    ).toEqual({ summary: 'Region restriction changed by Rob Lee', detail: null })
  })

  it('names what a User Scopes save added and removed when the save logged it', () => {
    expect(
      describeAccessChange(
        {
          ...base,
          action: 'update',
          collection: 'nivaro_user_scopes',
          item: `${GRANTEE}:region:restrict`,
          comment: 'Added CHI, FLO · Removed BSO',
          record_label: null
        },
        { ...ctx, dimensionLabels: new Map([['region', 'Region']]) }
      )
    ).toEqual({
      summary: 'Region restriction changed by Rob Lee',
      detail: 'Added CHI, FLO · Removed BSO'
    })
  })

  it('words the change a save logs: added and removed values by label', () => {
    expect(
      scopeChangeComment(
        [1, 2],
        [2, 3, 4],
        new Map([
          ['1', 'BSO'],
          ['3', 'CHI']
        ])
      )
    ).toBe('Added CHI, 4 · Removed BSO')
    expect(scopeChangeComment([], [], new Map())).toBe('')
    expect(scopeChangeComment([5], [], new Map([['5', 'Zone 1']]))).toBe(
      'Removed Zone 1 (none left)'
    )
  })

  it('reads role and status changes on the person, and ignores other edits', () => {
    const user = { ...base, collection: 'nivaro_users', item: GRANTEE, record_label: 'Pat Kim' }
    expect(
      describeAccessChange(
        { ...user, action: 'update', comment: null },
        {
          ...ctx,
          delta: { role: 'r-1', status: 'active' },
          roleNames: new Map([['R-1', 'Approver']])
        }
      )
    ).toEqual({ summary: 'Role changed to Approver by Rob Lee', detail: 'Status: active' })
    expect(
      describeAccessChange({ ...user, action: 'update', comment: 'Bulk: role → Viewer' }, ctx)
    ).toEqual({ summary: 'Role changed to Viewer by Rob Lee', detail: null })
    expect(
      describeAccessChange({ ...user, action: 'update', comment: 'authorized: 3 zones' }, ctx)
    ).toEqual({ summary: 'Access authorized by Rob Lee', detail: '3 zones' })
    expect(
      describeAccessChange(
        { ...user, action: 'update', comment: null },
        { ...ctx, delta: { first_name: 'P' } }
      )
    ).toBeNull()
  })
})
