import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The `mail-retry` runner (migration 536) over an in-memory mail log: each due original is
// claimed (UPDATE … WHERE retry_at <= now — one winner), replayed through the Resend path as an
// automatic retry (resent_by null), and moved along the 1/5/15/60-minute schedule or ended.
// sendRawMail is mocked — no mail is sent.

type Row = Record<string, unknown> & { id: number }
const store = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown> & { id: number }>,
  columns: true
}))

vi.mock('../../../db/index.js', () => {
  type Pred = (r: Row) => boolean
  const cmp = (a: unknown, op: string, b: unknown) => {
    const x = a instanceof Date ? a.getTime() : (a as number)
    const y = b instanceof Date ? b.getTime() : (b as number)
    if (op === '<=') return x <= y
    if (op === '=') return x === y
    throw new Error(`op ${op}`)
  }
  const builder = () => {
    const preds: Pred[] = []
    let order: string | null = null
    let lim = Infinity
    const pick = () => {
      let out = store.rows.filter((r) => preds.every((p) => p(r)))
      if (order) {
        const k = order
        out = [...out].sort((a, b) => (cmp(a[k], '<=', b[k]) ? -1 : 1))
      }
      return out.slice(0, lim)
    }
    const q: Record<string, unknown> = {
      where(col: string, opOrVal: unknown, val?: unknown) {
        if (val === undefined) preds.push((r) => r[col] === opOrVal)
        else preds.push((r) => r[col] != null && cmp(r[col], opOrVal as string, val))
        return q
      },
      whereNotNull(col: string) {
        preds.push((r) => r[col] != null)
        return q
      },
      orderBy(col: string) {
        order = col
        return q
      },
      limit(n: number) {
        lim = n
        return q
      },
      select() {
        return Promise.resolve(pick().map((r) => ({ ...r })))
      },
      async first() {
        const r = pick()[0]
        return r ? { ...r } : undefined
      },
      async update(patch: Record<string, unknown>) {
        const hit = pick()
        for (const r of hit) Object.assign(r, patch)
        return hit.length
      }
    }
    return q
  }
  return {
    db: Object.assign(
      vi.fn(() => builder()),
      {
        raw: vi.fn(),
        schema: { hasColumn: vi.fn(async () => store.columns) }
      }
    )
  }
})
vi.mock('../../../services/mail.js', () => ({ sendRawMail: vi.fn() }))
vi.mock('../../../services/mail-resends.js', () => ({ hasResendColumns: vi.fn(async () => true) }))

import { sendRawMail } from '../../../services/mail.js'
import {
  judgeRetryBacklog,
  type RedisLike,
  runMailRetryPass,
  takeSendLock
} from '../../../services/mail-retry.js'
import { resetRetryColumnProbe } from '../../../services/mail-retry-state.js'

const send = vi.mocked(sendRawMail)
const NOW = Date.parse('2026-11-18T20:00:00Z')
const now = () => NOW

const tempErr = () =>
  Object.assign(new Error('421 4.3.2 service not available'), {
    code: 'ECONNECTION',
    responseCode: 421,
    response: '421 4.3.2 service not available'
  })
const permErr = () =>
  Object.assign(new Error('550 5.1.1 no such user'), {
    code: 'EENVELOPE',
    responseCode: 550,
    response: '550 5.1.1 no such user'
  })

function failed(id: number, extra: Partial<Row> = {}): Row {
  return {
    id,
    to: `p${id}@x.com`,
    subject: `Mail ${id}`,
    body: '<html>x</html>',
    template: 'notification',
    collection: 'workflows',
    item: '7',
    status: 'failed',
    resend_of: null,
    resent_by: null,
    retry_at: new Date(NOW - 1000),
    retry_count: 0,
    created_at: new Date(NOW - 61_000),
    ...extra
  }
}
const row = (id: number) => store.rows.find((r) => r.id === id) as Row

beforeEach(() => {
  store.rows = []
  store.columns = true
  delete process.env.MAIL_RETRY
  delete process.env.CLOUD_META_DB_URL
  resetRetryColumnProbe()
  send.mockReset()
  send.mockResolvedValue({ status: 'sent', log_id: 1 })
})
afterEach(() => {
  delete process.env.MAIL_RETRY
})

describe('runMailRetryPass', () => {
  it('replays a due original as an automatic retry through the Resend path', async () => {
    store.rows.push(failed(10))
    const r = await runMailRetryPass({ now })
    expect(r).toMatchObject({ due: 1, tried: 1, delivered: 1 })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0]).toMatchObject({
      to: 'p10@x.com',
      html: '<html>x</html>',
      wrap: false,
      skipDigest: true,
      template: 'notification',
      collection: 'workflows',
      item: '7',
      resendOf: 10,
      resentBy: null
    })
    expect(row(10)).toMatchObject({ retry_at: null, retry_count: 1 })
  })

  it('leaves rows that are not due yet alone', async () => {
    store.rows.push(failed(10, { retry_at: new Date(NOW + 30_000) }))
    const r = await runMailRetryPass({ now })
    expect(r.due).toBe(0)
    expect(send).not.toHaveBeenCalled()
  })

  it('two runners at once → one send (the claim)', async () => {
    store.rows.push(failed(10))
    send.mockImplementation(async () => {
      await new Promise((ok) => setTimeout(ok, 5))
      return { status: 'sent', log_id: 2 }
    })
    const [a, b] = await Promise.all([runMailRetryPass({ now }), runMailRetryPass({ now })])
    expect(send).toHaveBeenCalledTimes(1)
    expect(a.tried + b.tried).toBe(1)
    expect(row(10).retry_count).toBe(1)
  })

  it('a temporary failure again moves it to the next step (5 min)', async () => {
    store.rows.push(failed(10))
    send.mockRejectedValue(tempErr())
    const r = await runMailRetryPass({ now })
    expect(r.rescheduled).toBe(1)
    expect(row(10).retry_count).toBe(1)
    expect((row(10).retry_at as Date).getTime()).toBe(NOW + 5 * 60_000)
  })

  it('the fourth retry that fails ends it — final failed, no retry pending', async () => {
    store.rows.push(failed(10, { retry_count: 3 }))
    send.mockRejectedValue(tempErr())
    const r = await runMailRetryPass({ now })
    expect(r.gaveUp).toBe(1)
    expect(row(10)).toMatchObject({ retry_at: null, retry_count: 4 })
  })

  it('a permanent failure on a retry ends it', async () => {
    store.rows.push(failed(10))
    send.mockRejectedValue(permErr())
    const r = await runMailRetryPass({ now })
    expect(r.gaveUp).toBe(1)
    expect(row(10)).toMatchObject({ retry_at: null, retry_count: 1 })
  })

  it('someone resent it by hand → the pending retry is cleared, nothing sent', async () => {
    store.rows.push(failed(10))
    store.rows.push({ id: 11, resend_of: 10, resent_by: 'u-admin', status: 'sent' })
    const r = await runMailRetryPass({ now })
    expect(r.cancelled).toBe(1)
    expect(send).not.toHaveBeenCalled()
    expect(row(10).retry_at).toBeNull()
  })

  it('an earlier AUTOMATIC retry does not count as a manual resend', async () => {
    store.rows.push(failed(10, { retry_count: 1 }))
    store.rows.push({ id: 11, resend_of: 10, resent_by: null, status: 'failed' })
    const r = await runMailRetryPass({ now })
    expect(r.tried).toBe(1)
  })

  it('stops the tick when the first retries fail temporarily again, and pushes the rest out', async () => {
    for (const id of [1, 2, 3, 4, 5])
      store.rows.push(failed(id, { retry_at: new Date(NOW - 10_000 + id) }))
    send.mockRejectedValue(tempErr())
    const r = await runMailRetryPass({ now })
    expect(r.stopped).toBe(true)
    expect(send).toHaveBeenCalledTimes(2)
    expect(r.pushed).toBe(3)
    for (const id of [3, 4, 5]) {
      expect(row(id).retry_count).toBe(0) // no attempt used
      expect((row(id).retry_at as Date).getTime()).toBe(NOW + 2 * 60_000)
    }
  })

  it('does not stop the tick once something was delivered', async () => {
    for (const id of [1, 2, 3])
      store.rows.push(failed(id, { retry_at: new Date(NOW - 10_000 + id) }))
    send
      .mockResolvedValueOnce({ status: 'sent', log_id: 5 })
      .mockRejectedValueOnce(tempErr())
      .mockRejectedValueOnce(tempErr())
    const r = await runMailRetryPass({ now })
    expect(r.stopped).toBe(false)
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('a send lock held by a person’s Resend skips the row this tick', async () => {
    store.rows.push(failed(10))
    const held = new Set<string>()
    const redis = {
      set: vi.fn(async (k: string) => {
        if (held.has(k)) return null
        held.add(k)
        return 'OK'
      }),
      del: vi.fn(async (k: string) => held.delete(k))
    } as unknown as RedisLike
    const release = await takeSendLock(redis, 10)
    expect(release).not.toBeNull()
    const r = await runMailRetryPass({ now, redis })
    expect(send).not.toHaveBeenCalled()
    expect(row(10).retry_at).not.toBeNull()
    expect(r.tried).toBe(0)
    await release?.()
    await runMailRetryPass({ now, redis })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('MAIL_RETRY=off → nothing runs', async () => {
    process.env.MAIL_RETRY = 'off'
    store.rows.push(failed(10))
    expect((await runMailRetryPass({ now })).skipped).toBe('off')
    expect(send).not.toHaveBeenCalled()
  })

  it('cloud mode → nothing runs', async () => {
    process.env.CLOUD_META_DB_URL = 'postgres://meta'
    store.rows.push(failed(10))
    expect((await runMailRetryPass({ now })).skipped).toBe('off')
    delete process.env.CLOUD_META_DB_URL
  })

  it('a database behind migration 536 → nothing runs', async () => {
    store.columns = false
    expect((await runMailRetryPass({ now })).skipped).toBe('no-columns')
  })
})

describe('judgeRetryBacklog (readiness mail-retry)', () => {
  const at = (minsAgo: number) => new Date(NOW - minsAgo * 60_000).toISOString()
  it('skips when retry is off', () => {
    expect(judgeRetryBacklog(null, NOW).status).toBe('skip')
  })
  it('passes when little waits or it is recent', () => {
    expect(judgeRetryBacklog({ pending: 0, due: 0, oldestFailedAt: null }, NOW).status).toBe('pass')
    expect(judgeRetryBacklog({ pending: 50, due: 50, oldestFailedAt: at(10) }, NOW).status).toBe(
      'pass'
    )
    expect(judgeRetryBacklog({ pending: 5, due: 5, oldestFailedAt: at(90) }, NOW).status).toBe(
      'pass'
    )
  })
  it('warns when more than 20 wait and the oldest failed over 30 minutes ago', () => {
    const v = judgeRetryBacklog({ pending: 21, due: 4, oldestFailedAt: at(31) }, NOW)
    expect(v.status).toBe('warn')
    expect(v.detail).toContain('21 failed emails')
  })
})
