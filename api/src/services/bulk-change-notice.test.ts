import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../lib/column-probe.js', () => ({ hasColumn: vi.fn(async () => true) }))

import {
  bulkNoticeMin,
  bulkNoticeText,
  type FlushDeps,
  fieldPhrase,
  flushBulkNotices,
  idsQuery,
  isNoticeBurst,
  noteBulkWrite,
  noticeFields,
  recipientsOf,
  resetBulkNotices,
  whyText
} from './bulk-change-notice.js'

afterEach(() => {
  resetBulkNotices()
  delete process.env.BULK_NOTICE_MIN
})

const BETH = '11111111-1111-1111-1111-111111111111'
const ANN = '22222222-2222-2222-2222-222222222222'
const ROB = '33333333-3333-3333-3333-333333333333'
const GROUP = 'bulk:req-1'

function touch(n: number, fields: string[] = ['amount'], group = GROUP, action = 'update') {
  for (let i = 1; i <= n; i++)
    noteBulkWrite({
      groupKey: group,
      action,
      user: BETH,
      collection: 'workflows',
      item: String(i),
      fields
    })
}

function fakeDeps(over: Partial<FlushDeps> = {}): { deps: FlushDeps; sent: any[] } {
  const sent: any[] = []
  const deps: FlushDeps = {
    creators: async (_c, ids) => new Map(ids.map((id) => [id, ANN])),
    owners: async () => new Map(),
    subscribed: async () => false,
    view: async (_u, _c, ids) => ({ ids, fields: null }),
    fieldLabels: async (_c, f) => f.map((x) => x.charAt(0).toUpperCase() + x.slice(1)),
    actorName: async () => 'Beth Jones',
    word: async () => 'Workflow',
    send: async (userId, n) => {
      sent.push({ userId, ...n })
    },
    ...over
  }
  return { deps, sent }
}

describe('pure helpers', () => {
  it('only bulk and import bursts count', () => {
    expect(isNoticeBurst('bulk:abc')).toBe(true)
    expect(isNoticeBurst('import_run:5')).toBe(true)
    expect(isNoticeBurst('import_job:5')).toBe(true)
    expect(isNoticeBurst('import:x')).toBe(true)
    expect(isNoticeBurst('flow_run:1')).toBe(false)
    expect(isNoticeBurst('cron:1')).toBe(false)
    expect(isNoticeBurst('mcp:1')).toBe(false)
    expect(isNoticeBurst(null)).toBe(false)
  })

  it('names the fields that changed, not audit stamps or internals', () => {
    expect(noticeFields(['amount', 'date_updated', 'user_updated', '_x', '$state', 'id'])).toEqual([
      'amount'
    ])
    expect(fieldPhrase(['Amount', 'Status'])).toBe('Amount, Status')
    expect(fieldPhrase(['A', 'B', 'C', 'D', 'E'])).toBe('A, B, C, +2 more')
    expect(fieldPhrase([])).toBe('')
  })

  it('says who, how many and what', () => {
    const t = bulkNoticeText({
      actor: 'Beth',
      count: 12,
      word: 'workflow',
      fieldLabels: ['Amount', 'Status']
    })
    expect(t.subject).toBe('Beth updated 12 of your records (Amount, Status)')
    expect(t.message).toContain('12 of your workflow records')
    expect(t.message).toContain('See what changed')
    expect(bulkNoticeText({ actor: null, count: 1, word: '', fieldLabels: [] }).subject).toBe(
      'Someone updated 1 of your record'
    )
  })

  it('the link carries as many ids as fit, never more than the target allows', () => {
    expect(idsQuery(['1', '2', '3'])).toEqual({ query: 'ids=1,2,3', carried: 3 })
    const many = Array.from(
      { length: 200 },
      (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`
    )
    const q = idsQuery(many)
    expect(q.query.length).toBeLessThanOrEqual(460)
    expect(q.carried).toBeGreaterThan(5)
    expect(q.carried).toBeLessThan(200)
  })

  it('recipients are creators and owners, never the person who did it', () => {
    const r = recipientsOf(
      new Map([
        ['1', ANN],
        ['2', BETH],
        ['3', ANN]
      ]),
      new Map([
        ['1', new Set([ROB, BETH])],
        ['4', new Set([ROB])]
      ]),
      BETH.toUpperCase()
    )
    expect([...r.keys()].sort()).toEqual([ANN, ROB].sort())
    expect([...r.get(ANN)!.ids].sort()).toEqual(['1', '3'])
    expect(r.get(ANN)).toMatchObject({ created: true, owned: false })
    expect([...r.get(ROB)!.ids].sort()).toEqual(['1', '4'])
    expect(r.get(ROB)).toMatchObject({ created: false, owned: true })
    expect(whyText(true, true)).toMatch(/created or own/)
  })

  it('the threshold defaults to 5 and can be set', () => {
    expect(bulkNoticeMin()).toBe(5)
    process.env.BULK_NOTICE_MIN = '2'
    expect(bulkNoticeMin()).toBe(2)
    process.env.BULK_NOTICE_MIN = 'x'
    expect(bulkNoticeMin()).toBe(5)
  })
})

describe('one notice per person per burst', () => {
  it('12 records changed → ONE notice to the creator, listing the fields', async () => {
    touch(12, ['amount', 'status'])
    const { deps, sent } = fakeDeps()
    const n = await flushBulkNotices(GROUP, deps)
    expect(n).toBe(1)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ userId: ANN, collection: 'workflows', senderId: BETH })
    expect(sent[0].subject).toBe('Beth Jones updated 12 of your records (Amount, Status)')
    expect(sent[0].query).toMatch(/^ids=1,2,3/)
    expect(sent[0].why).toMatch(/created/)
  })

  it('below the threshold nothing is sent', async () => {
    touch(4)
    const { deps, sent } = fakeDeps()
    expect(await flushBulkNotices(GROUP, deps)).toBe(0)
    expect(sent).toHaveLength(0)
  })

  it('only a person with enough of THEIR records is told', async () => {
    touch(10)
    const { deps, sent } = fakeDeps({
      creators: async (_c, ids) => new Map(ids.map((id) => [id, Number(id) <= 6 ? ANN : ROB]))
    })
    await flushBulkNotices(GROUP, deps)
    expect(sent.map((s) => s.userId)).toEqual([ANN])
    expect(sent[0].subject).toContain('6 of your records')
  })

  it('records the recipient cannot read are not counted or linked; hidden fields are not named', async () => {
    touch(10, ['amount', 'secret'])
    const { deps, sent } = fakeDeps({
      view: async (_u, _c, ids) => ({ ids: ids.filter((i) => Number(i) <= 7), fields: ['amount'] })
    })
    await flushBulkNotices(GROUP, deps)
    expect(sent[0].subject).toBe('Beth Jones updated 7 of your records (Amount)')
    expect(sent[0].query).not.toContain('10')
    // Too few readable records: silence rather than a notice about nothing they can open.
    touch(10, ['amount'], 'bulk:req-2')
    const b = fakeDeps({ view: async () => ({ ids: ['1', '2'], fields: null }) })
    expect(await flushBulkNotices('bulk:req-2', b.deps)).toBe(0)
  })

  it('someone with a collection-wide subscription is left to it', async () => {
    touch(8)
    const { deps, sent } = fakeDeps({ subscribed: async () => true })
    await flushBulkNotices(GROUP, deps)
    expect(sent).toHaveLength(0)
  })

  it('the person who did it is never told about their own bulk change', async () => {
    touch(8)
    const { deps, sent } = fakeDeps({
      creators: async (_c, ids) => new Map(ids.map((id) => [id, BETH]))
    })
    await flushBulkNotices(GROUP, deps)
    expect(sent).toHaveLength(0)
  })

  it('a bulk move names the step; owners are told too', async () => {
    touch(6, [], 'bulk:req-3', 'pipeline-transition')
    const { deps, sent } = fakeDeps({
      creators: async () => new Map(),
      owners: async (_c, ids) => new Map(ids.map((id) => [id, new Set([ROB])]))
    })
    await flushBulkNotices('bulk:req-3', deps)
    expect(sent).toHaveLength(1)
    expect(sent[0].userId).toBe(ROB)
    expect(sent[0].subject).toBe('Beth Jones updated 6 of your records (Step)')
    expect(sent[0].why).toMatch(/own/)
  })

  it('writes outside a bulk action, creates and deletes are not collected', async () => {
    for (let i = 1; i <= 9; i++) {
      noteBulkWrite({
        groupKey: 'flow_run:1',
        action: 'update',
        user: BETH,
        collection: 'workflows',
        item: String(i)
      })
      noteBulkWrite({
        groupKey: GROUP,
        action: 'create',
        user: BETH,
        collection: 'workflows',
        item: String(i)
      })
      noteBulkWrite({
        groupKey: GROUP,
        action: 'delete',
        user: BETH,
        collection: 'workflows',
        item: String(i)
      })
      noteBulkWrite({
        groupKey: GROUP,
        action: 'update',
        user: BETH,
        collection: 'nivaro_tasks',
        item: String(i)
      })
      noteBulkWrite({
        groupKey: null,
        action: 'update',
        user: BETH,
        collection: 'workflows',
        item: String(i)
      })
    }
    const { deps, sent } = fakeDeps()
    expect(await flushBulkNotices(GROUP, deps)).toBe(0)
    expect(await flushBulkNotices('flow_run:1', deps)).toBe(0)
    expect(sent).toHaveLength(0)
  })

  it('a burst is sent once: the second flush finds nothing', async () => {
    touch(6)
    const { deps, sent } = fakeDeps()
    await flushBulkNotices(GROUP, deps)
    await flushBulkNotices(GROUP, deps)
    expect(sent).toHaveLength(1)
  })

  it('a failing dependency never throws out of the flush', async () => {
    touch(6)
    const { deps } = fakeDeps({
      creators: async () => {
        throw new Error('db down')
      },
      owners: async () => {
        throw new Error('db down')
      }
    })
    await expect(flushBulkNotices(GROUP, deps)).resolves.toBe(0)
  })

  it('goes quiet by itself: the burst flushes after it has been idle', async () => {
    vi.useFakeTimers()
    try {
      touch(6)
      // No deps passed to the timer path — just prove it was scheduled and is dropped on reset.
      expect(vi.getTimerCount()).toBe(1)
      resetBulkNotices()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
