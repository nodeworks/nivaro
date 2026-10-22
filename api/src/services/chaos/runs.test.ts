import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setAppRef } from '../io-holder.js'
import {
  _setRunStoreForTests,
  appendRunEvent,
  createRun,
  getRun,
  lastRunPerFault,
  listRunEvents,
  listRuns,
  runStoreMode,
  updateRun
} from './runs.js'

/** A tiny Redis: strings with TTL ignored, lists. */
function fakeRedis() {
  const kv = new Map<string, string>()
  const lists = new Map<string, string[]>()
  return {
    kv,
    lists,
    get: async (k: string) => kv.get(k) ?? null,
    set: async (k: string, v: string) => {
      kv.set(k, v)
    },
    lpush: async (k: string, v: string) => {
      lists.set(k, [v, ...(lists.get(k) ?? [])])
    },
    ltrim: async (k: string, a: number, b: number) => {
      const l = lists.get(k) ?? []
      lists.set(k, l.slice(a, b < 0 ? l.length + b + 1 : b + 1))
    },
    lrange: async (k: string, a: number, b: number) => {
      const l = lists.get(k) ?? []
      return l.slice(a, b < 0 ? l.length + b + 1 : b + 1)
    },
    rpush: async (k: string, v: string) => {
      const l = lists.get(k) ?? []
      l.push(v)
      lists.set(k, l)
      return l.length
    },
    expire: async () => {},
    llen: async (k: string) => (lists.get(k) ?? []).length
  }
}

afterEach(() => {
  _setRunStoreForTests(null)
  setAppRef(null)
})

for (const mode of ['memory', 'redis'] as const) {
  describe(`run store (${mode})`, () => {
    beforeEach(() => {
      _setRunStoreForTests(mode)
      setAppRef(mode === 'redis' ? { redis: fakeRedis() } : null)
    })

    it('reports its mode when the tables are missing', async () => {
      expect(await runStoreMode()).toBe(mode)
    })

    it('creates, reads, patches conditionally and lists newest first', async () => {
      const a = await createRun({ kind: 'drill', label: 'A', fault_key: 'slow', status: 'running' })
      const b = await createRun({
        kind: 'ci',
        label: 'B',
        fault_key: 'slow',
        status: 'completed',
        verdict: 'held'
      })
      expect((await getRun(a.id))?.label).toBe('A')
      expect((await getRun(a.id.toUpperCase()))?.id).toBe(a.id)
      expect(await getRun('missing')).toBeNull()

      expect(await updateRun(a.id, { status: 'stopped' }, { ifStatus: ['completed'] })).toBeNull()
      const patched = await updateRun(
        a.id,
        { status: 'stopped', verdict: 'broke' },
        { ifStatus: ['running'] }
      )
      expect(patched?.status).toBe('stopped')
      expect((await getRun(a.id))?.verdict).toBe('broke')

      const all = await listRuns()
      expect(all.map((r) => r.id)).toEqual([b.id, a.id])
      expect((await listRuns({ status: 'stopped' })).map((r) => r.id)).toEqual([a.id])
      expect((await listRuns({ kind: 'ci' })).map((r) => r.id)).toEqual([b.id])
      expect((await listRuns({ limit: 1 })).length).toBe(1)
      expect((await lastRunPerFault()).get('slow')?.id).toBe(b.id)
    })

    it('appends and pages events per run', async () => {
      const run = await createRun({ kind: 'drill', label: 'E' })
      const e1 = await appendRunEvent(run.id, 'armed', { fault_key: 'slow' })
      const e2 = await appendRunEvent(run.id, 'sample', { p95: 120 }, 'user-1')
      expect(e1?.id).toBe(1)
      expect(e2?.id).toBe(2)
      const all = await listRunEvents(run.id)
      expect(all.map((e) => e.kind)).toEqual(['armed', 'sample'])
      expect(await listRunEvents(run.id, { after: 1 })).toHaveLength(1)
      expect(await listRunEvents(run.id, { kinds: ['sample'] })).toHaveLength(1)
      expect(await listRunEvents('other')).toEqual([])
    })
  })
}
