import { beforeEach, describe, expect, it, vi } from 'vitest'

// One in-memory nivaro_users row: just enough of the query builder for the
// preferences read/write the watches service does.
const store = { prefs: {} as Record<string, unknown> }
vi.mock('../../../db/index.js', () => {
  const builder = () => {
    const chain = {
      where: () => chain,
      first: async () => ({ preferences: JSON.stringify(store.prefs) }),
      update: async (patch: { preferences: string }) => {
        store.prefs = JSON.parse(patch.preferences)
      }
    }
    return chain
  }
  return { db: Object.assign(() => builder(), {}) }
})
const notify = vi.fn(async () => ({ id: 1 }))
vi.mock('../../../services/notification-channels.js', () => ({ notifyUser: notify }))

const {
  createWatch,
  checkWatch,
  setWatchEvaluator,
  readWatches,
  updateWatch,
  deleteWatch,
  WatchError
} = await import('../../../services/ai-watches.js')

const user = { id: 'U1', role: 'R1' } as never

describe('watch lifecycle (evaluator stubbed, notifications captured)', () => {
  beforeEach(() => {
    store.prefs = {}
    notify.mockClear()
  })

  it('creates a watch from the first reading and does not alert on it', async () => {
    setWatchEvaluator(async () => 120)
    const w = await createWatch(user, { collection: 'workflows', op: 'count', threshold: 100 })
    expect(w.last_value).toBe(120)
    expect(w.last_alert_at).toBeNull()
    expect(await readWatches('U1')).toHaveLength(1)
    expect(notify).not.toHaveBeenCalled()
  })

  it('refuses a figure that cannot be read (the evaluator is the validator)', async () => {
    setWatchEvaluator(async () => {
      throw new Error('Unknown field: nope')
    })
    await expect(
      createWatch(user, { collection: 'workflows', op: 'sum', field: 'nope', threshold: 1 })
    ).rejects.toThrow(/Unknown field/)
    expect(await readWatches('U1')).toHaveLength(0)
  })

  it('needs a threshold for a threshold watch', async () => {
    setWatchEvaluator(async () => 1)
    await expect(
      createWatch(user, { collection: 'workflows', op: 'count' })
    ).rejects.toBeInstanceOf(WatchError)
  })

  it('notifies the watcher when a later check crosses the threshold, once', async () => {
    setWatchEvaluator(async () => 50)
    const w = await createWatch(user, { collection: 'workflows', op: 'count', threshold: 100 })
    setWatchEvaluator(async () => 150)
    const a = await checkWatch({} as never, user, w.id)
    expect(a.alert).toMatch(/150/)
    expect(notify).toHaveBeenCalledTimes(1)
    await checkWatch({} as never, user, w.id)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('keeps the error on the watch when a check fails', async () => {
    setWatchEvaluator(async () => 1)
    const w = await createWatch(user, { collection: 'workflows', op: 'count', threshold: 100 })
    setWatchEvaluator(async () => {
      throw new Error('No read access')
    })
    const r = await checkWatch(null, user, w.id)
    expect(r.watch.last_error).toBe('No read access')
    expect(r.alert).toBeNull()
  })

  it('changes the threshold, stops and deletes', async () => {
    setWatchEvaluator(async () => 1)
    const w = await createWatch(user, { collection: 'workflows', op: 'count', threshold: 100 })
    const u = await updateWatch('U1', w.id, { threshold: 5, active: false })
    expect(u.threshold).toBe(5)
    expect(u.active).toBe(false)
    await deleteWatch('U1', w.id)
    expect(await readWatches('U1')).toHaveLength(0)
    await expect(deleteWatch('U1', w.id)).rejects.toMatchObject({ statusCode: 404 })
  })
})

describe('a watch whose field the owner cannot read', () => {
  beforeEach(() => {
    store.prefs = {}
    notify.mockClear()
  })

  it('refuses to create it, so no hidden value is returned', async () => {
    const { FieldAccessError } = await import('../../../services/ai-aggregate-guard.js')
    setWatchEvaluator(async () => {
      throw new FieldAccessError('You do not have access to the field "salary" on employees.')
    })
    await expect(
      createWatch(user, { collection: 'employees', op: 'max', field: 'salary', threshold: 1 })
    ).rejects.toThrow(/salary/)
    expect(await readWatches('U1')).toHaveLength(0)
  })

  it('pauses on a later check with the reason and never alerts', async () => {
    const { FieldAccessError } = await import('../../../services/ai-aggregate-guard.js')
    setWatchEvaluator(async () => 5)
    const w = await createWatch(user, {
      collection: 'employees',
      op: 'max',
      field: 'salary',
      threshold: 10
    })
    setWatchEvaluator(async () => {
      throw new FieldAccessError('You do not have access to the field "salary" on employees.')
    })
    const o = await checkWatch(null, user, w.id)
    expect(o.alert).toBeNull()
    expect(o.watch.active).toBe(false)
    expect(o.watch.last_error).toMatch(/access/)
    setWatchEvaluator(null)
  })
})
