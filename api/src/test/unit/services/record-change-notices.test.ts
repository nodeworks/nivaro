import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/event-journal.js', () => ({
  journaledEmit: vi.fn(async () => ({ seq: 1, path: 'adapter', room: 'r' }))
}))
vi.mock('../../../services/item-events.js', () => ({
  publishItemEvent: vi.fn(),
  publishCollectionTouched: vi.fn()
}))
vi.mock('../../../services/sse-hub.js', () => ({ publishSseEvent: vi.fn() }))
vi.mock('../../../services/traffic-map.js', () => ({ noteWrite: vi.fn() }))
vi.mock('../../../services/collections.js', () => ({ getCollection: vi.fn(async () => undefined) }))

import { broadcastCollectionUpdate } from '../../../services/realtime.js'
import {
  _resetRecordChangeListeners,
  emitRecordChangeNotice,
  forgetRecordChangeListeners,
  onRecordChangeNotice,
  type RecordChangeNotice,
  recordChangeListenerCount,
  setRecordChangeOwnerEnabled
} from '../../../services/record-change-notices.js'

beforeEach(() => _resetRecordChangeListeners())

describe('record change notices (in-process, for caches an extension keeps)', () => {
  it('hands each notice to every listener until it unsubscribes', () => {
    const a: RecordChangeNotice[] = []
    const b: RecordChangeNotice[] = []
    const offA = onRecordChangeNotice((n) => a.push(n))
    onRecordChangeNotice((n) => b.push(n))
    emitRecordChangeNotice({ collection: 'orders', item: 7, action: 'update' })
    offA()
    emitRecordChangeNotice({ collection: 'orders', item: 8 })
    expect(a).toEqual([{ collection: 'orders', item: 7, action: 'update' }])
    expect(b).toHaveLength(2)
    expect(recordChangeListenerCount()).toBe(1)
  })

  it('a listener that throws or rejects never reaches the writer or the other listeners', async () => {
    const seen: unknown[] = []
    onRecordChangeNotice(() => {
      throw new Error('boom')
    })
    onRecordChangeNotice(async () => {
      throw new Error('later')
    })
    onRecordChangeNotice((n) => seen.push(n.item))
    expect(() => emitRecordChangeNotice({ collection: 'orders', item: 1 })).not.toThrow()
    await Promise.resolve()
    expect(seen).toEqual([1])
  })

  it('an owner is paused, resumed and forgotten with its extension', () => {
    const seen: unknown[] = []
    onRecordChangeNotice((n) => seen.push(n.item), 'ext-a')
    onRecordChangeNotice((n) => seen.push(`b${n.item}`), 'ext-b')
    setRecordChangeOwnerEnabled('ext-a', false)
    emitRecordChangeNotice({ collection: 'orders', item: 1 })
    setRecordChangeOwnerEnabled('ext-a', true)
    emitRecordChangeNotice({ collection: 'orders', item: 2 })
    forgetRecordChangeListeners('ext-a')
    emitRecordChangeNotice({ collection: 'orders', item: 3 })
    expect(seen).toEqual(['b1', 2, 'b2', 'b3'])
    expect(recordChangeListenerCount()).toBe(1)
  })

  it('every broadcast of a change is a notice: a write, a record aspect, an announced raw write', () => {
    const seen: RecordChangeNotice[] = []
    onRecordChangeNotice((n) => seen.push(n))
    broadcastCollectionUpdate(undefined, 'orders', 7, {
      action: 'update',
      changed_fields: ['total']
    })
    broadcastCollectionUpdate(undefined, 'orders', '7', { changed_fields: ['$state'] })
    broadcastCollectionUpdate(undefined, 'orders', '*', { source: 'raw', bulk: 250 })
    expect(seen).toEqual([
      { collection: 'orders', item: 7, action: 'update', changed_fields: ['total'] },
      { collection: 'orders', item: '7', changed_fields: ['$state'] },
      { collection: 'orders', item: '*', source: 'raw', bulk: 250 }
    ])
  })

  it('a broadcast with nobody listening builds no notice', () => {
    expect(recordChangeListenerCount()).toBe(0)
    expect(() => broadcastCollectionUpdate(undefined, 'orders', 1)).not.toThrow()
  })
})
