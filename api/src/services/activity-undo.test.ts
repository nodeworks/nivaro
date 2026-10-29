import { describe, expect, it } from 'vitest'
import {
  applyUndo,
  parseUndoComment,
  previewUndo,
  reversibleAction,
  type UndoActivityRow,
  type UndoDeps,
  UndoError,
  type UndoneMark
} from './activity-undo.js'

const ME = '11111111-1111-1111-1111-111111111111'
const OTHER = '22222222-2222-2222-2222-222222222222'
const T0 = new Date('2026-10-29T12:00:00Z')

interface World {
  activity: Map<number, UndoActivityRow>
  revisions: Map<number, { delta: Record<string, unknown>; before: Record<string, unknown> | null }>
  records: Map<string, Record<string, unknown>>
  hidden: Set<string>
  noUpdate: Set<string>
  locked: Map<string, string>
  notAllowed: Set<string>
  trash: Map<number, number>
  canCreate: boolean
  undoRows: Array<{ id: number; comment: string }>
  updates: Array<{ item: string; data: Record<string, unknown>; reason: string }>
  restored: number[]
  claimed: Set<number>
}

function world(): World {
  return {
    activity: new Map(),
    revisions: new Map(),
    records: new Map(),
    hidden: new Set(),
    noUpdate: new Set(),
    locked: new Map(),
    notAllowed: new Set(),
    trash: new Map(),
    canCreate: true,
    undoRows: [],
    updates: [],
    restored: [],
    claimed: new Set()
  }
}

function deps(w: World, opts: { admin?: boolean; user?: string } = {}): UndoDeps {
  let nextUndo = 9000
  return {
    isAdmin: opts.admin ?? false,
    userId: opts.user ?? ME,
    loadActivity: async (id) => w.activity.get(id) ?? null,
    groupSiblings: async (row) =>
      [...w.activity.values()].filter(
        (a) =>
          a.chain_id === row.chain_id &&
          a.action === 'update' &&
          a.collection === row.collection &&
          a.user === row.user
      ),
    revision: async (row) => w.revisions.get(row.id) ?? null,
    fieldMeta: async () => ({ audit: new Set(['modified_on']), readonly: new Set(['total']) }),
    readCurrent: async (_c, item) => (w.hidden.has(item) ? null : (w.records.get(item) ?? null)),
    canUpdate: async (_c, item) => !w.noUpdate.has(item),
    lockedBy: async (_c, item) => w.locked.get(item) ?? null,
    notAllowed: async (_c, fields) => new Set(fields.filter((f) => w.notAllowed.has(f))),
    undoneIn: async (_c, _since, ids) => {
      const out = new Map<number, UndoneMark>()
      for (const r of w.undoRows) {
        const p = parseUndoComment(r.comment)
        for (const e of p?.entries ?? [])
          if (ids.includes(e)) out.set(e, { activity_id: r.id, at: T0.toISOString(), by: ME })
      }
      return out
    },
    trashFor: async (row) => (w.trash.has(row.id) ? { id: w.trash.get(row.id)! } : null),
    recordExists: async (_c, item) => w.records.has(item),
    canCreate: async () => w.canCreate,
    update: async (_c, item, data, reason) => {
      if (w.noUpdate.has(item)) throw new Error('Forbidden')
      w.updates.push({ item, data, reason })
      w.records.set(item, { ...w.records.get(item), ...data })
    },
    restore: async (trashId) => {
      w.restored.push(trashId)
    },
    logUndo: async (entry) => {
      const id = nextUndo++
      w.undoRows.push({ id, comment: entry.comment })
      return id
    },
    claim: async (id) => {
      if (w.claimed.has(id)) return false
      w.claimed.add(id)
      return true
    },
    release: async (id) => {
      w.claimed.delete(id)
    }
  }
}

function edit(
  w: World,
  id: number,
  item: string,
  delta: Record<string, unknown>,
  before: Record<string, unknown> | null,
  extra: Partial<UndoActivityRow> = {}
) {
  w.activity.set(id, {
    id,
    action: 'update',
    user: ME,
    collection: 'invoices',
    item,
    timestamp: T0,
    chain_id: null,
    ...extra
  })
  w.revisions.set(id, { delta, before })
}

describe('reversibleAction', () => {
  it('offers Undo only for updates and deletes of business records', () => {
    expect(reversibleAction({ action: 'update', collection: 'invoices', item: '1' }).ok).toBe(true)
    expect(reversibleAction({ action: 'delete', collection: 'invoices', item: '1' }).ok).toBe(true)
    expect(reversibleAction({ action: 'transition', collection: 'invoices', item: '1' }).ok).toBe(
      false
    )
    expect(reversibleAction({ action: 'update', collection: 'nivaro_roles', item: 'x' }).ok).toBe(
      false
    )
    expect(reversibleAction({ action: 'undo', collection: 'invoices', item: '1' }).ok).toBe(false)
    expect(reversibleAction({ action: 'update', collection: 'invoices', item: null }).ok).toBe(
      false
    )
  })
})

describe('field edit undo', () => {
  it('previews then reverts the changed fields through the update path', async () => {
    const w = world()
    w.records.set('7', { id: 7, amount: 900, zone: 'B', modified_on: 'x', total: 5 })
    edit(
      w,
      1,
      '7',
      { amount: 900, zone: 'B', modified_on: 'x', total: 5 },
      { amount: 100, zone: 'A', total: 1 }
    )
    const d = deps(w)
    const preview = await previewUndo(d, 1)
    expect(preview.kind).toBe('update')
    expect(preview.reversible).toBe(true)
    expect(preview.will_change).toBe(1)
    const fields = Object.fromEntries(preview.records[0].fields.map((f) => [f.field, f.status]))
    // audit stamp never shows; a derived field follows the others
    expect(fields).toEqual({ amount: 'revert', total: 'derived', zone: 'revert' })
    expect(w.updates).toHaveLength(0)

    const res = await applyUndo(d, 1)
    expect(res.applied).toBe(true)
    expect(w.updates).toEqual([
      { item: '7', data: { amount: 100, zone: 'A' }, reason: 'Undo of activity #1' }
    ])
    expect(JSON.parse(w.undoRows[0].comment)).toMatchObject({
      undo_of: 1,
      kind: 'update',
      entries: [1]
    })
  })

  it('refuses a second undo of the same entry', async () => {
    const w = world()
    w.records.set('7', { id: 7, amount: 900 })
    edit(w, 1, '7', { amount: 900 }, { amount: 100 })
    const d = deps(w)
    await applyUndo(d, 1)
    const again = await previewUndo(d, 1)
    expect(again.reversible).toBe(false)
    expect(again.already_undone?.activity_id).toBe(9000)
    await expect(applyUndo(d, 1)).rejects.toMatchObject({ statusCode: 409, code: 'ALREADY_UNDONE' })
  })

  it('shows changed-since and reverts only the fields picked', async () => {
    const w = world()
    // amount was edited again by someone else; zone still holds this edit's value
    w.records.set('7', { id: 7, amount: 555, zone: 'B' })
    edit(w, 1, '7', { amount: 900, zone: 'B' }, { amount: 100, zone: 'A' })
    const d = deps(w)
    const p = await previewUndo(d, 1)
    expect(p.records[0].status).toBe('partial')
    expect(p.records[0].fields.find((f) => f.field === 'amount')?.status).toBe('changed_since')
    expect(p.will_change).toBe(0)
    // without a pick, nothing is half-reverted
    const none = await applyUndo(d, 1)
    expect(none.applied).toBe(false)
    expect(w.updates).toHaveLength(0)
    // per-field revert
    const res = await applyUndo(d, 1, { fields: ['zone'] })
    expect(res.applied).toBe(true)
    expect(w.updates[0].data).toEqual({ zone: 'A' })
  })

  it('refuses a record the caller may not change, cannot see, or someone holds', async () => {
    const w = world()
    for (const id of ['1', '2', '3']) w.records.set(id, { id, amount: 9 })
    edit(w, 1, '1', { amount: 9 }, { amount: 1 })
    edit(w, 2, '2', { amount: 9 }, { amount: 1 })
    edit(w, 3, '3', { amount: 9 }, { amount: 1 })
    w.noUpdate.add('1')
    w.hidden.add('2')
    w.locked.set('3', 'Dana is editing this record')
    const d = deps(w)
    expect((await previewUndo(d, 1)).records[0]).toMatchObject({ status: 'refused' })
    expect((await previewUndo(d, 2)).records[0]).toMatchObject({ status: 'gone' })
    expect((await previewUndo(d, 3)).records[0]).toMatchObject({
      status: 'refused',
      reason: 'Dana is editing this record'
    })
    expect((await applyUndo(d, 1)).applied).toBe(false)
    expect(w.updates).toHaveLength(0)
  })

  it('withholds values of fields the caller cannot read and skips fields they cannot set', async () => {
    const w = world()
    w.records.set('7', { id: 7, amount: 9 }) // salary not readable
    edit(w, 1, '7', { amount: 9, salary: 50, zone: 'B' }, { amount: 1, salary: 10, zone: 'A' })
    w.records.set('7', { id: 7, amount: 9, zone: 'B' })
    w.notAllowed.add('zone')
    const p = await previewUndo(deps(w), 1)
    const salary = p.records[0].fields.find((f) => f.field === 'salary')
    expect(salary).toEqual({ field: 'salary', status: 'unreadable' })
    expect(p.records[0].fields.find((f) => f.field === 'zone')?.status).toBe('not_allowed')
    const res = await applyUndo(deps(w), 1)
    expect(w.updates[0].data).toEqual({ amount: 1 })
    expect(res.changed).toBe(1)
  })

  it('only the author or an administrator may undo', async () => {
    const w = world()
    w.records.set('7', { id: 7, amount: 9 })
    edit(w, 1, '7', { amount: 9 }, { amount: 1 })
    await expect(previewUndo(deps(w, { user: OTHER }), 1)).rejects.toBeInstanceOf(UndoError)
    expect((await previewUndo(deps(w, { user: OTHER, admin: true }), 1)).reversible).toBe(true)
  })
})

describe('bulk update undo', () => {
  it('reverts every record of the group and reports the skipped ones', async () => {
    const w = world()
    const chain = 'c-1'
    for (let i = 1; i <= 4; i++) {
      w.records.set(String(i), { id: i, zone: 'B' })
      edit(w, i, String(i), { zone: 'B' }, { zone: 'A' }, { chain_id: chain })
    }
    // same request, other fields (a hook cascade) — not part of the bulk change
    w.records.set('5', { id: 5, total: 3, note: 'x' })
    edit(w, 5, '5', { note: 'x' }, { note: 'y' }, { chain_id: chain })
    w.records.set('3', { id: 3, zone: 'C' }) // changed since
    w.noUpdate.add('4')
    const d = deps(w)
    const p = await previewUndo(d, 2)
    expect(p.kind).toBe('bulk_update')
    expect(p.group_size).toBe(4)
    expect(p.will_change).toBe(2)
    expect(p.records.map((r) => r.status)).toEqual([
      'revertible',
      'revertible',
      'changed_since',
      'refused'
    ])

    const res = await applyUndo(d, 2)
    expect(res.changed).toBe(2)
    expect(res.skipped).toBe(2)
    expect(w.updates.map((u) => u.item)).toEqual(['1', '2'])
    expect(JSON.parse(w.undoRows[0].comment)).toMatchObject({
      undo_of: 2,
      kind: 'bulk_update',
      entries: [1, 2]
    })
    // a second run: done members are skipped as undone, the rest are still judged
    const again = await previewUndo(d, 1)
    expect(again.records.filter((r) => r.status === 'undone')).toHaveLength(2)
    expect(again.will_change).toBe(0)
  })

  it('scope entry undoes only the one record', async () => {
    const w = world()
    for (let i = 1; i <= 3; i++) {
      w.records.set(String(i), { id: i, zone: 'B' })
      edit(w, i, String(i), { zone: 'B' }, { zone: 'A' }, { chain_id: 'c' })
    }
    const res = await applyUndo(deps(w), 2, { scope: 'entry' })
    expect(res.kind).toBe('update')
    expect(w.updates.map((u) => u.item)).toEqual(['2'])
  })
})

describe('delete undo (trash restore)', () => {
  function del(w: World) {
    w.activity.set(50, {
      id: 50,
      action: 'delete',
      user: ME,
      collection: 'invoices',
      item: '70',
      timestamp: T0
    })
  }

  it('restores from trash once', async () => {
    const w = world()
    del(w)
    w.trash.set(50, 333)
    const d = deps(w)
    const p = await previewUndo(d, 50)
    expect(p).toMatchObject({ kind: 'delete', reversible: true, will_change: 1 })
    const res = await applyUndo(d, 50)
    expect(res.applied).toBe(true)
    expect(w.restored).toEqual([333])
    expect((await previewUndo(d, 50)).already_undone).toBeTruthy()
  })

  it('is not reversible past trash, when the id is taken, or without create permission', async () => {
    const w = world()
    del(w)
    expect((await previewUndo(deps(w), 50)).reversible).toBe(false)
    w.trash.set(50, 333)
    w.records.set('70', { id: 70 })
    expect((await previewUndo(deps(w), 50)).records[0].status).toBe('refused')
    w.records.delete('70')
    w.canCreate = false
    const p = await previewUndo(deps(w), 50)
    expect(p.reversible).toBe(false)
    expect((await applyUndo(deps(w), 50)).applied).toBe(false)
    expect(w.restored).toEqual([])
  })
})

describe('non-reversible entries', () => {
  it('never offers Undo for a transition or a permission change', async () => {
    const w = world()
    w.activity.set(60, {
      id: 60,
      action: 'transition',
      user: ME,
      collection: 'invoices',
      item: '1',
      timestamp: T0
    })
    w.activity.set(61, {
      id: 61,
      action: 'update',
      user: ME,
      collection: 'nivaro_policies',
      item: '9',
      timestamp: T0
    })
    expect((await previewUndo(deps(w), 60)).reversible).toBe(false)
    expect((await previewUndo(deps(w), 61)).reversible).toBe(false)
    expect((await applyUndo(deps(w), 61)).applied).toBe(false)
  })

  it('refuses while another undo of the entry runs', async () => {
    const w = world()
    w.records.set('7', { id: 7, amount: 9 })
    edit(w, 1, '7', { amount: 9 }, { amount: 1 })
    w.claimed.add(1)
    await expect(applyUndo(deps(w), 1)).rejects.toMatchObject({ statusCode: 409 })
  })
})
