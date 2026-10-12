import { describe, expect, it, vi } from 'vitest'
import { announceRecordTabs, subscribeRecordTabs } from './record-tabs'

const tick = () => new Promise((r) => setTimeout(r, 30))

describe('record-tabs signals (#2131)', () => {
  it("hears another window's save of the record, never this tab's own", async () => {
    const cb = vi.fn()
    const stop = subscribeRecordTabs('u1', 'saved', 'projects', '7', cb)
    announceRecordTabs('u1', 'saved', 'projects', '7')
    await tick()
    expect(cb).not.toHaveBeenCalled()

    // Another window of the same sign-in (its own channel object).
    const other = new BroadcastChannel('nvr-record-tabs:u1')
    other.postMessage({ type: 'saved', tab: 'another-window', key: 'projects:7' })
    other.postMessage({ type: 'saved', tab: 'another-window', key: 'projects:8' })
    other.postMessage({ type: 'lock-released', tab: 'another-window', key: 'projects:7' })
    await tick()
    expect(cb).toHaveBeenCalledTimes(1)
    other.close()
    stop()
  })

  it('a different sign-in (a View-as tab) is a different channel', async () => {
    const cb = vi.fn()
    const stop = subscribeRecordTabs('u1', 'lock-released', 'projects', '7', cb)
    const viewAs = new BroadcastChannel('nvr-record-tabs:u2')
    viewAs.postMessage({ type: 'lock-released', tab: 'view-as-window', key: 'projects:7' })
    await tick()
    expect(cb).not.toHaveBeenCalled()
    viewAs.close()
    stop()
  })
})
