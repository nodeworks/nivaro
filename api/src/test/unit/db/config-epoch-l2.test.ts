import { describe, expect, it } from 'vitest'
import {
  attachConfigEpoch,
  CONFIG_EPOCH,
  configEpochForRead,
  configEpochNow,
  isRemoteEpochClear,
  noteConfigWrite,
  onEpoch,
  startEpochWatch,
  stopEpochWatch
} from '../../../db/config-epoch.js'

// #2441 — the epoch a shared cache keys on.

const state = { epoch: 41, reads: 0 }

function fakeKnex() {
  const k = ((_table: string) => ({
    where: () => ({
      update: async () => {
        state.epoch++
        return 1
      },
      first: async () => {
        state.reads++
        return { epoch: state.epoch }
      }
    }),
    insert: async () => [1],
    select: async () => {
      state.reads++
      return [{ name: CONFIG_EPOCH, epoch: state.epoch }]
    }
  })) as unknown as Parameters<typeof attachConfigEpoch>[0]
  ;(k as unknown as { raw: (s: string) => string }).raw = (s) => s
  return k
}

attachConfigEpoch(fakeKnex())

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('configuration epoch for a shared cache', () => {
  it('a fresh process reads the number once, however many ask at once', async () => {
    expect(configEpochNow()).toBeNull()
    const answers = await Promise.all([
      configEpochForRead(),
      configEpochForRead(),
      configEpochForRead()
    ])
    expect(answers).toEqual([41, 41, 41])
    expect(state.reads).toBe(1)
    expect(configEpochNow()).toBe(41)
  })

  it('is unusable while a local configuration write settles, then names the moved number', async () => {
    noteConfigWrite('update [nivaro_fields] set [note] = @p0 where [id] = @p1')
    expect(configEpochNow()).toBeNull()
    expect(await configEpochForRead()).toBeNull()
    // Leading move (42) at once, trailing move (43) when the run of writes ends (2 s).
    await wait(2_300)
    expect(state.epoch).toBe(43)
    expect(configEpochNow()).toBe(43)
  })

  it('flags the clear a handler for ANOTHER process’s move makes', async () => {
    const seen: boolean[] = []
    onEpoch(CONFIG_EPOCH, () => {
      seen.push(isRemoteEpochClear())
    })
    startEpochWatch(40)
    await wait(80)
    state.epoch = 50 // another process moved it
    await wait(150)
    stopEpochWatch()
    expect(seen).toEqual([true])
    expect(isRemoteEpochClear()).toBe(false)
  })
})
