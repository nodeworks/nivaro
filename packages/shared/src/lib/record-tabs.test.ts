import { describe, expect, it, vi } from 'vitest'
import {
  announceRecordTabs,
  otherTabNote,
  savedFieldNames,
  subscribeRecordTabs
} from './record-tabs'

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

describe('same record in two tabs (rt5 #6)', () => {
  it('a save names the fields it carried — names only, no meta keys', async () => {
    const seen: Array<string[] | null> = []
    const stop = subscribeRecordTabs('u1', 'saved', 'projects', '7', (info) =>
      seen.push(info.fields)
    )
    const other = new BroadcastChannel('nvr-record-tabs:u1')
    other.postMessage({ type: 'saved', tab: 'w2', key: 'projects:7', fields: ['title', 'status'] })
    other.postMessage({ type: 'saved', tab: 'w2', key: 'projects:7' })
    other.postMessage({ type: 'saved', tab: 'w2', key: 'projects:7', fields: ['_meta', 7, '$x'] })
    await tick()
    expect(seen).toEqual([['title', 'status'], null, null])
    other.close()
    stop()
  })

  it("announceRecordTabs posts the save's field names to the other windows", async () => {
    const other = new BroadcastChannel('nvr-record-tabs:u3')
    const got: unknown[] = []
    other.onmessage = (e) => got.push(e.data)
    announceRecordTabs('u3', 'saved', 'projects', '9', ['title', '_comment', 'title', 'amount'])
    announceRecordTabs('u3', 'lock-released', 'projects', '9', ['title'])
    await tick()
    expect(got).toHaveLength(2)
    expect(got[0]).toMatchObject({ type: 'saved', key: 'projects:9', fields: ['title', 'amount'] })
    expect(got[1]).not.toHaveProperty('fields')
    other.close()
  })

  it('savedFieldNames keeps real field names only', () => {
    expect(savedFieldNames(null)).toBeNull()
    expect(savedFieldNames([])).toBeNull()
    expect(savedFieldNames(['a', 'a', '_x', '$state', '', 'b'])).toEqual(['a', 'b'])
    expect(savedFieldNames(Array.from({ length: 300 }, (_, i) => `f${i}`))).toHaveLength(200)
  })

  it('the note is quiet while only the other tab edits, and says so on both when both do', () => {
    expect(otherTabNote({ otherDirty: false, dirty: false })).toBeNull()
    expect(otherTabNote({ otherDirty: false, dirty: true })).toBeNull()
    expect(otherTabNote({ otherDirty: true, dirty: false })).toEqual({
      tone: 'quiet',
      text: 'Also open in another tab — editing there'
    })
    const both = otherTabNote({ otherDirty: true, dirty: true })
    expect(both?.tone).toBe('both')
    expect(both?.text).toMatch(/another tab too/)
  })
})
