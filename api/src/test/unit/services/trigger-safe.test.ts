import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  triggerTables: [] as string[],
  reads: 0,
  fail: false,
  mssql: true
}))
vi.mock('../../../db/index.js', () => ({
  isMssql: () => state.mssql,
  db: {
    raw: async () => {
      state.reads++
      if (state.fail) throw new Error('catalog unreadable')
      return state.triggerTables.map((name) => ({ s: 'dbo', name }))
    }
  }
}))
vi.mock('../../../db/tenant-context.js', () => ({ getTenantId: () => null }))

import {
  isTriggerOutputError,
  resetTriggerSafeCache,
  returningOptions,
  TRIGGER_SAFE,
  withTriggerSafeReturning
} from '../../../services/trigger-safe.js'

const err334 = () =>
  Object.assign(
    new Error(
      "The target table 'dbo.t' of the DML statement cannot have any enabled triggers if the statement contains an OUTPUT clause without INTO clause."
    ),
    { number: 334 }
  )

describe('trigger-safe returning', () => {
  beforeEach(() => {
    resetTriggerSafeCache()
    state.triggerTables = []
    state.reads = 0
    state.fail = false
    state.mssql = true
  })

  it('asks for the safe form only on a table with a trigger', async () => {
    state.triggerTables = ['nivaro_workflow_history']
    expect(await returningOptions('nivaro_workflow_history')).toEqual(TRIGGER_SAFE)
    expect(await returningOptions('[dbo].[NIVARO_WORKFLOW_HISTORY]')).toEqual(TRIGGER_SAFE)
    expect(await returningOptions('dbo.nivaro_workflow_history')).toEqual(TRIGGER_SAFE)
    expect(await returningOptions('workflows')).toBeUndefined()
    expect(state.reads).toBe(1)
  })

  it('uses the safe form when the catalog cannot be read, none off MSSQL', async () => {
    state.fail = true
    expect(await returningOptions('workflows')).toEqual(TRIGGER_SAFE)
    state.mssql = false
    expect(await returningOptions('workflows')).toBeUndefined()
  })

  it('a trigger added after the catalog read costs one refused statement, then the safe form', async () => {
    const calls: unknown[] = []
    const out = await withTriggerSafeReturning('workflows', async (opts) => {
      calls.push(opts)
      if (!opts) throw err334()
      return [{ id: 7 }]
    })
    expect(out).toEqual([{ id: 7 }])
    expect(calls).toEqual([undefined, TRIGGER_SAFE])
    // remembered: the next write goes straight to the safe form
    const next: unknown[] = []
    await withTriggerSafeReturning('workflows', async (opts) => {
      next.push(opts)
      return []
    })
    expect(next).toEqual([TRIGGER_SAFE])
  })

  it('never retries any other error, nor a refusal already in the safe form', async () => {
    let n = 0
    await expect(
      withTriggerSafeReturning('workflows', async () => {
        n++
        throw new Error('Violation of PRIMARY KEY constraint')
      })
    ).rejects.toThrow(/PRIMARY KEY/)
    expect(n).toBe(1)
    state.triggerTables = ['t']
    resetTriggerSafeCache()
    n = 0
    await expect(
      withTriggerSafeReturning('t', async () => {
        n++
        throw err334()
      })
    ).rejects.toThrow(/OUTPUT clause/)
    expect(n).toBe(1)
  })

  it('recognises 334 by number, by the driver info and by text', () => {
    expect(isTriggerOutputError(err334())).toBe(true)
    expect(isTriggerOutputError({ originalError: { info: { number: 334 } } })).toBe(true)
    expect(isTriggerOutputError(new Error('Invalid object name'))).toBe(false)
  })
})
