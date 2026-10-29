import Knex from 'knex'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

const { pageRoomMembers, parseLimit, parseOffset, wantsPaging, MEMBER_PAGE_MAX } = await import(
  '../../../services/chat-member-page.js'
)

/** A real knex query builder (mssql dialect) whose execution is recorded and answered from `answer`. */
function recordingKnex(answer: (sql: string) => unknown[]) {
  const sent: Array<{ sql: string; bindings: unknown[] }> = []
  const knex = Knex({ client: 'mssql', connection: {} })
  const client = knex.client as unknown as Record<string, unknown>
  client.acquireConnection = async () => ({})
  client.releaseConnection = async () => undefined
  client._query = async (
    _c: unknown,
    obj: { sql: string; bindings: unknown[]; response?: unknown }
  ) => {
    sent.push({ sql: obj.sql, bindings: obj.bindings })
    obj.response = answer(obj.sql)
    return obj
  }
  client.processResponse = (obj: { response: unknown; method?: string }) =>
    obj.method === 'first' ? (obj.response as unknown[])[0] : obj.response
  return { knex, sent }
}

const row = (user: string, first: string, online: number) => ({
  user,
  first_name: first,
  last_name: 'X',
  email: `${first.toLowerCase()}@x.test`,
  title: null,
  joined_at: null,
  online
})

describe('chat member paging (#3082)', () => {
  it('clamps limit/offset', () => {
    expect(parseLimit(undefined)).toBe(50)
    expect(parseLimit('9999')).toBe(MEMBER_PAGE_MAX)
    expect(parseLimit('0')).toBe(50)
    expect(parseLimit('25')).toBe(25)
    expect(parseOffset('-3')).toBe(0)
    expect(parseOffset('40')).toBe(40)
  })

  it('wantsPaging only when a paging param is sent', () => {
    expect(wantsPaging({})).toBe(false)
    expect(wantsPaging({ limit: '10' })).toBe(true)
    expect(wantsPaging({ q: '' })).toBe(true)
  })

  it('returns the page with total, has_more and online flags, online ordering in SQL', async () => {
    const { knex, sent } = recordingKnex((sql) => {
      if (/count/i.test(sql) && /user_presence/.test(sql)) return [{ n: 1 }]
      if (/count/i.test(sql)) return [{ n: 120 }]
      return [row('U1', 'Ann', 1), row('U2', 'Bob', 0)]
    })
    const page = await pageRoomMembers('ch:general', { limit: 2, offset: 0 }, knex)
    expect(page.total).toBe(120)
    expect(page.has_more).toBe(true)
    expect(page.online_total).toBe(1)
    expect(page.rows.map((r) => [r.user, r.online])).toEqual([
      ['U1', true],
      ['U2', false]
    ])
    expect(page.rows[0].name).toBe('Ann X')
    const list = sent.find((s) => /order by/i.test(s.sql))
    expect(list?.sql).toMatch(/order by CASE WHEN p\.last_seen/i)
    expect(list?.sql).toMatch(/DESC/)
    expect(list?.sql).toMatch(/user_presence/)
  })

  it('last page has no more', async () => {
    const { knex } = recordingKnex((sql) =>
      /count/i.test(sql) ? [{ n: 3 }] : [row('U3', 'Cy', 0)]
    )
    const page = await pageRoomMembers('ch:general', { limit: 50, offset: 2 }, knex)
    expect(page.has_more).toBe(false)
  })

  it('search is bound (never inlined), case-insensitive, strips @ and escapes wildcards', async () => {
    const { knex, sent } = recordingKnex((sql) => (/count/i.test(sql) ? [{ n: 0 }] : []))
    await pageRoomMembers('ch:general', { q: "  @O'Brien%_  " }, knex)
    const withSearch = sent.filter((s) => /LIKE/i.test(s.sql))
    expect(withSearch.length).toBeGreaterThan(0)
    for (const s of withSearch) {
      expect(s.sql).not.toContain('Brien')
      expect(s.sql).toMatch(/LOWER\(/)
      expect(s.bindings).toContain("%o'brien\\%\\_%")
      expect(s.bindings).toContain("o'brien\\%\\_%")
    }
  })

  it('no q adds no LIKE clause and suspended people are left out', async () => {
    const { knex, sent } = recordingKnex((sql) => (/count/i.test(sql) ? [{ n: 0 }] : []))
    await pageRoomMembers('ch:general', {}, knex)
    expect(sent.some((s) => /LIKE/i.test(s.sql))).toBe(false)
    expect(sent.every((s) => /suspended/.test(s.bindings.join(',')))).toBe(true)
  })
})
