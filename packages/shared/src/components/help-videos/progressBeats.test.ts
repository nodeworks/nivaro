import type { NivaroClient } from '@nivaro/sdk'
import { describe, expect, it, vi } from 'vitest'
import { helpVideoApi } from './api'
import { createProgressBeats, type ProgressBody } from './progressBeats'

/** A client whose request() records every command it is given. */
function mockClient(fail = false) {
  const request = vi.fn(async (_cmd: unknown) => {
    if (fail) throw Object.assign(new Error('offline'), { status: 0 })
    return { data: { completed: false } }
  })
  return { client: { request } as unknown as NivaroClient, request }
}
const bodyOf = (call: unknown[]) => (call[0] as { _body: ProgressBody })._body

describe('createProgressBeats', () => {
  it('sends a beat the moment watching starts, before any 10 s tick', async () => {
    const { client, request } = mockClient()
    const beats = createProgressBeats((body) => helpVideoApi(client).progress('v1', body))
    await beats.open(0, 'ver1')
    expect(request).toHaveBeenCalledTimes(1)
    expect((request.mock.calls[0][0] as { _path: string })._path).toBe('/help-videos/v1/progress')
    expect(bodyOf(request.mock.calls[0])).toEqual({
      position_ms: 0,
      watched_ms_delta: 0,
      buckets: '00000000000000000000',
      version_id: 'ver1'
    })
    // a second play (after a pause) does not open again
    await beats.open(3000, 'ver1')
    expect(request).toHaveBeenCalledTimes(1)
  })
  it('sends nothing before watching starts', async () => {
    const { client, request } = mockClient()
    const beats = createProgressBeats((body) => helpVideoApi(client).progress('v1', body))
    await beats.beat(0)
    expect(request).not.toHaveBeenCalled()
  })
  it('reports the sections seen and the watched time since the last beat', async () => {
    const { client, request } = mockClient()
    const beats = createProgressBeats((body) => helpVideoApi(client).progress('v1', body))
    await beats.open(0)
    beats.see(0, 10_000, 0)
    beats.see(600, 10_000, 600)
    beats.see(1200, 10_000, 1200)
    await beats.beat(1200, 'ver1')
    expect(bodyOf(request.mock.calls[1])).toEqual({
      position_ms: 1200,
      watched_ms_delta: 1200,
      buckets: '11100000000000000000',
      version_id: 'ver1'
    })
    await beats.beat(1200, 'ver1')
    expect(bodyOf(request.mock.calls[2]).watched_ms_delta).toBe(0)
  })
  it('keeps watched time from a failed beat for the next one', async () => {
    const calls: ProgressBody[] = []
    let fail = true
    const beats = createProgressBeats(async (body) => {
      calls.push(body)
      if (fail) throw new Error('offline')
    })
    fail = false
    await beats.open(0)
    beats.see(0, 10_000, 0)
    beats.see(800, 10_000, 800)
    fail = true
    await beats.beat(800)
    fail = false
    beats.idle()
    beats.see(900, 10_000, 5000)
    beats.see(1400, 10_000, 5500)
    await beats.beat(1400)
    expect(calls.map((c) => c.watched_ms_delta)).toEqual([0, 800, 1300])
  })
})
