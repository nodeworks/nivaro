import { beforeEach, describe, expect, it, vi } from 'vitest'

const { calls } = vi.hoisted(() => ({
  calls: { rooms: [] as string[], events: [] as Array<{ event: string; payload: any }>, global: 0 }
}))

vi.mock('../../../services/tenant-rooms.js', () => ({
  tenantScopedRoom: (r: string) => `t:acme:${r}`
}))
vi.mock('../../../services/io-holder.js', () => {
  const chain: any = {
    to(room: string) {
      calls.rooms.push(room)
      return chain
    },
    emit(event: string, payload: unknown) {
      calls.events.push({ event, payload })
    }
  }
  return { getIo: () => ({ ...chain, emit: () => (calls.global += 1) }) }
})

import { emitImportProgress } from '../../../services/live-progress.js'

describe('emitImportProgress', () => {
  beforeEach(() => {
    calls.rooms.length = 0
    calls.events.length = 0
    calls.global = 0
  })

  it('goes to the starter and the tenant admin watch room, never to every socket', () => {
    emitImportProgress('u1', { id: 4, stage: 'importing', row_count: 10 })
    expect(calls.global).toBe(0)
    expect(calls.rooms).toEqual(['t:acme:watch:imports', 'user:u1'])
    expect(calls.events[0]).toEqual({
      event: 'import:progress',
      payload: { id: 4, stage: 'importing', row_count: 10 }
    })
  })

  it('never carries the error text', () => {
    emitImportProgress(null, { id: 4, stage: 'error', error: 'secret table name leaked' })
    expect(calls.rooms).toEqual(['t:acme:watch:imports'])
    expect(calls.events[0].payload).toEqual({ id: 4, stage: 'error', error: true })
  })
})
