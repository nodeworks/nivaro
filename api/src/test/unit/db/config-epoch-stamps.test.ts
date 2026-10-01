// #1053 — one stamp per run of configuration writes, carrying the tables and who wrote them.
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/request-trace.js', () => ({
  currentTraceMeta: () => ({
    id: 't1',
    urlHint: '/api/collection-layouts/2/assignments',
    userId: 'U1'
  })
}))

import {
  attachConfigEpoch,
  bumpConfigEpoch,
  type ConfigStamp,
  noteConfigWrite,
  onConfigStamp
} from '../../../db/config-epoch.js'

function fakeKnex() {
  let epoch = 10
  const builder = {
    where: () => builder,
    update: async () => {
      epoch++
      return 1
    },
    insert: async () => 1,
    first: async () => ({ epoch })
  }
  const k = Object.assign(() => builder, {
    raw: (s: string) => s,
    client: { destroy: async () => undefined }
  })
  return k
}

describe('config stamps', () => {
  it('stamps a run of writes once, on its trailing edge, with every table and the writer', async () => {
    vi.useFakeTimers()
    attachConfigEpoch(fakeKnex() as never)
    const stamps: ConfigStamp[] = []
    const off = onConfigStamp((s) => {
      stamps.push(s)
    })
    noteConfigWrite('update [nivaro_layout_field_assignments] set [sort] = @p0 where [id] = @p1')
    noteConfigWrite('update [nivaro_layout_field_assignments] set [sort] = @p0 where [id] = @p1')
    noteConfigWrite('update [nivaro_collection_layouts] set [name] = @p0 where [id] = @p1')
    await vi.advanceTimersByTimeAsync(500)
    expect(stamps).toHaveLength(0) // the leading move clears caches; no stamp yet
    await vi.advanceTimersByTimeAsync(2_500)
    expect(stamps).toHaveLength(1)
    expect(stamps[0]).toMatchObject({
      manual: false,
      statements: 3,
      users: ['U1'],
      paths: ['/api/collection-layouts/2/assignments'],
      tables: [
        { table: 'nivaro_layout_field_assignments', writes: 2 },
        { table: 'nivaro_collection_layouts', writes: 1 }
      ]
    })
    expect(typeof stamps[0].epoch).toBe('number')

    // a cache bust asked for by hand is stamped too
    await bumpConfigEpoch()
    expect(stamps).toHaveLength(2)
    expect(stamps[1]).toMatchObject({ manual: true, tables: [], statements: 0 })
    off()
    vi.useRealTimers()
  })
})
