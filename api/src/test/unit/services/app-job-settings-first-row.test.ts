import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hub phase 5 (found by the T13c end-to-end run): an app database installed from empty has no
// nivaro_settings row yet. A pause there used to answer `paused: true` and store nothing, so the
// job kept running in that app. Like the settings save, the first pause creates the row.

const store = vi.hoisted(() => ({ rows: [] as Array<{ id: number; paused_crons: string | null }> }))

vi.mock('../../../db/index.js', () => {
  const table = () => {
    let where: { id?: number } = {}
    const b = {
      orderBy: () => b,
      where: (w: { id: number }) => {
        where = w
        return b
      },
      first: async () => store.rows[0],
      insert: async (row: Record<string, unknown>) => {
        store.rows.push({ id: store.rows.length + 1, paused_crons: null, ...row } as never)
        return [store.rows.length]
      },
      update: async (patch: { paused_crons: string }) => {
        const r = store.rows.find((x) => x.id === where.id)
        if (r) Object.assign(r, patch)
        return r ? 1 : 0
      }
    }
    return b
  }
  const db = () => table()
  return { db, resolveDb: () => db }
})

const { setAppJobPaused, appPausedCrons, forgetAppJobSettings } = await import(
  '../../../services/app-job-settings.js'
)

beforeEach(() => {
  store.rows.length = 0
  forgetAppJobSettings('')
})

describe('pause on an app database with no settings row', () => {
  it('creates the row and keeps the pause', async () => {
    expect(await setAppJobPaused('outbox-worker', true)).toEqual(['outbox-worker'])
    expect(store.rows).toHaveLength(1)
    expect(JSON.parse(String(store.rows[0].paused_crons))).toEqual(['outbox-worker'])
    expect([...(await appPausedCrons())]).toEqual(['outbox-worker'])
  })

  it('a resume with no row creates none', async () => {
    expect(await setAppJobPaused('outbox-worker', false)).toEqual([])
    expect(store.rows).toHaveLength(0)
  })
})
