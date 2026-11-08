// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  draftCreatedAs,
  draftHasContent,
  draftPersistDecision,
  keepDraftSavedAt,
  lineBasesForDraft,
  markDraftCreated,
  type StoredDraft
} from './draft-store'

const KEY = 'workflows:new:u1'

afterEach(() => localStorage.clear())

describe('draft created markers', () => {
  it('names the record a draft captured before its create became', () => {
    markDraftCreated(KEY, '372797', new Date('2026-10-24T22:14:20Z'))
    expect(draftCreatedAs(KEY, '2026-10-24T22:14:13Z', new Date('2026-10-24T22:20:00Z'))).toEqual({
      id: '372797',
      at: '2026-10-24T22:14:20.000Z'
    })
  })

  it('leaves a draft captured after the create alone (new work)', () => {
    markDraftCreated(KEY, '372797', new Date('2026-10-24T22:14:20Z'))
    expect(draftCreatedAs(KEY, '2026-10-24T22:15:00Z', new Date('2026-10-24T22:20:00Z'))).toBeNull()
  })

  it('is per draft key, and forgets after a week', () => {
    markDraftCreated(KEY, '1', new Date('2026-10-01T00:00:00Z'))
    expect(draftCreatedAs('workflows:new:u2', '2026-09-30T00:00:00Z')).toBeNull()
    expect(draftCreatedAs(KEY, '2026-09-30T00:00:00Z', new Date('2026-10-09T00:00:00Z'))).toBeNull()
    expect(localStorage.getItem(`nvr:draft-created:${KEY}`)).toBeNull()
  })

  it('keeps an unknown id as "" and ignores junk', () => {
    markDraftCreated(KEY, '', new Date('2026-10-24T22:14:20Z'))
    expect(draftCreatedAs(KEY, '2026-10-24T22:14:00Z', new Date('2026-10-24T22:15:00Z'))?.id).toBe(
      ''
    )
    localStorage.setItem(`nvr:draft-created:${KEY}`, '{nope')
    expect(draftCreatedAs(KEY, '2026-10-24T22:14:00Z')).toBeNull()
    expect(draftCreatedAs(KEY, null)).toBeNull()
  })
})

// army5 b09-N3b: a restored-then-left draft said "from just now" minutes later.
describe('keepDraftSavedAt', () => {
  const d = (saved_at: string, fields: Record<string, unknown>): StoredDraft => ({
    key: 'workflows:1:u1',
    collection: 'workflows',
    item_id: '1',
    user_id: 'u1',
    saved_at,
    fields,
    base: {},
    base_updated_at: null,
    pending_rows: {},
    pending_edits: {},
    pending_deletes: {},
    m2m_links: {},
    m2m_unlinks: {}
  })
  it('the same work keeps its original time', () => {
    const prev = d('2026-11-06T16:46:31Z', { description: 'S3' })
    const next = d('2026-11-06T16:48:20Z', { description: 'S3' })
    expect(keepDraftSavedAt(next, prev).saved_at).toBe('2026-11-06T16:46:31Z')
  })
  it('changed work is stamped anew', () => {
    const prev = d('2026-11-06T16:46:31Z', { description: 'S3' })
    const next = d('2026-11-06T16:48:20Z', { description: 'S4' })
    expect(keepDraftSavedAt(next, prev).saved_at).toBe('2026-11-06T16:48:20Z')
    expect(keepDraftSavedAt(next, null).saved_at).toBe('2026-11-06T16:48:20Z')
  })
})

describe('staged line edits in a draft (army9 b09 MEDIUM: an IR material quantity left as a draft)', () => {
  const edits: StoredDraft['pending_edits'] = {
    'inventory_request_materials.inventory_request': {
      '163120': { quantity: 9 },
      'pending:0': { quantity: 1 }
    },
    'workflow_line_items.workflow': { '475939': { quantity: 8 } }
  }
  it('a draft of line edits alone is content — it is offered back, not dropped', () => {
    const d = {
      key: 'inventory_request:37829:u1',
      collection: 'inventory_request',
      item_id: '37829',
      user_id: 'u1',
      saved_at: '2026-11-07T22:30:23Z',
      fields: {},
      base: {},
      base_updated_at: null,
      pending_rows: {},
      pending_edits: edits,
      pending_deletes: {},
      m2m_links: {},
      m2m_unlinks: {}
    } satisfies StoredDraft
    expect(draftHasContent(d)).toBe(true)
    expect(draftHasContent({ ...d, pending_edits: {} })).toBe(false)
  })
  it('lineBasesForDraft keeps the base each staged line was staged on, by <collection>:<row>', async () => {
    const bases: Record<string, number | null> = {
      'inventory_request_materials:163120': 11486900,
      'workflow_line_items:475939': 11486904
    }
    const asked: string[] = []
    const out = await lineBasesForDraft(edits, (rc, id) => {
      asked.push(`${rc}:${id}`)
      return Promise.resolve(bases[`${rc}:${id}`] ?? null)
    })
    expect(out).toEqual({
      'inventory_request_materials:163120': 11486900,
      'workflow_line_items:475939': 11486904
    })
    // Unsaved (pending) rows have no revision and are never asked about.
    expect(asked).not.toContain('inventory_request_materials:pending:0')
  })
  it('an unknown, failed or zero base is left out (the flush reads one then)', async () => {
    const out = await lineBasesForDraft(edits, (rc) =>
      rc === 'workflow_line_items' ? Promise.reject(new Error('offline')) : undefined
    )
    expect(out).toEqual({})
    expect(await lineBasesForDraft(edits, () => 0)).toEqual({})
    expect(await lineBasesForDraft(null, () => 5)).toEqual({})
  })
})

describe('draftPersistDecision (army9 b09 + Fable review M2)', () => {
  it('a dirty field is stored, whatever else', () => {
    expect(
      draftPersistDecision({ isDirty: true, forReload: false, staged: 0, stagedLines: 0 })
    ).toBe('store')
    expect(
      draftPersistDecision({ isDirty: true, forReload: true, staged: 0, stagedLines: 0 })
    ).toBe('store')
  })
  it('staged lines alone are stored (the IR material quantity left as a draft)', () => {
    expect(
      draftPersistDecision({ isDirty: false, forReload: false, staged: 1, stagedLines: 1 })
    ).toBe('store')
  })
  it('hand-staged links alone are not drafted — but a pushed reload is HELD over them (M2)', () => {
    expect(
      draftPersistDecision({ isDirty: false, forReload: false, staged: 1, stagedLines: 0 })
    ).toBe('drop')
    expect(
      draftPersistDecision({ isDirty: false, forReload: true, staged: 1, stagedLines: 0 })
    ).toBe('hold')
  })
  it('nothing held: dropped, and a reload may go ahead', () => {
    expect(
      draftPersistDecision({ isDirty: false, forReload: false, staged: 0, stagedLines: 0 })
    ).toBe('drop')
    expect(
      draftPersistDecision({ isDirty: false, forReload: true, staged: 0, stagedLines: 0 })
    ).toBe('drop')
  })
})
