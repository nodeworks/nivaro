import { describe, expect, it, vi } from 'vitest'

// rt4-notify item 3: queued email digests drop items that were handled before the digest goes out.

const store = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  asked: [] as unknown[]
}))

vi.mock('../../../db/index.js', () => ({
  db: () => {
    const q: any = {
      where: (a: unknown) => {
        store.asked.push(a)
        return q
      },
      whereIn: () => q,
      select: async () => store.rows
    }
    return q
  }
}))

import { handledNotificationIds, splitHandledDeferred } from '../../../services/daily-digest.js'
import { encodeDeferredSnippet } from '../../../services/deferred-snippet.js'

const held = (id: number, n: number | null) => ({
  id,
  snippet: encodeDeferredSnippet('<p>CR26-1 is waiting on you.</p>', {
    collection: 'workflows',
    item: 1,
    notification: n
  })
})

describe('digest re-check', () => {
  it('a held mail whose inbox row was handled is left out; others (and old rows) stay', () => {
    const rows = [held(1, 10), held(2, 11), held(3, null), { id: 4, snippet: 'old plain row' }]
    const { kept, dropped } = splitHandledDeferred(rows, new Set([10]))
    expect(dropped.map((r) => r.id)).toEqual([1])
    expect(kept.map((r) => r.id)).toEqual([2, 3, 4])
  })

  it('every held mail handled = nothing left to send', () => {
    const { kept } = splitHandledDeferred([held(1, 10), held(2, 11)], new Set([10, 11]))
    expect(kept).toEqual([])
  })

  it("reads only the recipient's own rows and counts settled / archived ones as handled", async () => {
    store.rows = [
      {
        id: 10,
        status: 'read',
        detail: JSON.stringify({ resolved: { text: 'Approved by Beth' } })
      },
      { id: 11, status: 'archived', detail: null },
      { id: 12, status: 'inbox', detail: JSON.stringify({ resolve_key: 'step:w:1' }) },
      { id: 13, status: 'read', detail: null }
    ]
    store.asked = []
    const handled = await handledNotificationIds('al', [10, 11, 12, 13, 10])
    expect([...handled].sort()).toEqual([10, 11])
    expect(store.asked).toContainEqual({ recipient: 'al' })
    expect(await handledNotificationIds('al', [])).toEqual(new Set())
  })
})
