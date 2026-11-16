import { describe, expect, it } from 'vitest'
import {
  BULK_MAX,
  parseBulkBody,
  parseTicketListQuery,
  ticketOrderClauses,
  WAITING_SQL
} from '../../../services/support-list.js'

const STATUSES = ['open', 'in_progress', 'done', 'cancelled']
const U = '3f1c2a9e-5b6d-4e7f-8a9b-0c1d2e3f4a5b'

describe('parseTicketListQuery', () => {
  it('reads every filter', () => {
    const q = parseTicketListQuery(
      {
        status: 'in_progress',
        assignee: U,
        category: '4',
        priority: 'urgent',
        requester: U,
        q: '  vendor  ',
        sort: 'oldest',
        page: '2',
        limit: '25'
      },
      { desk: true, statuses: STATUSES }
    )
    expect(q).toEqual({
      status: { kind: 'one', status: 'in_progress' },
      assignee: { kind: 'user', id: U.toUpperCase() },
      category: 4,
      priority: 'urgent',
      requester: U.toUpperCase(),
      q: 'vendor',
      sort: 'oldest',
      page: 2,
      limit: 25
    })
  })

  it('defaults: open, attention on the desk, the legacy order elsewhere', () => {
    expect(parseTicketListQuery({}, { desk: true, statuses: STATUSES }).sort).toBe('attention')
    const mine = parseTicketListQuery({}, { desk: false, statuses: STATUSES })
    expect(mine.sort).toBeNull()
    expect(mine.status).toEqual({ kind: 'open' })
    expect(mine.limit).toBe(50)
  })

  it('drops unknown values instead of failing', () => {
    const q = parseTicketListQuery(
      {
        status: 'nonsense',
        assignee: "1' OR 1=1",
        priority: 'critical',
        sort: 'random',
        category: '1e99',
        limit: '9999'
      },
      { desk: true, statuses: STATUSES }
    )
    expect(q.status).toEqual({ kind: 'open' })
    expect(q.assignee).toBeNull()
    expect(q.priority).toBeNull()
    expect(q.sort).toBe('attention')
    expect(q.category).toBe(-1)
    expect(q.limit).toBe(200)
  })

  it('a requester filter only counts on the desk', () => {
    expect(
      parseTicketListQuery({ requester: U }, { desk: false, statuses: STATUSES }).requester
    ).toBeNull()
  })

  it('reads me / unassigned / closed / all', () => {
    const o = { desk: true, statuses: STATUSES }
    expect(parseTicketListQuery({ assignee: 'me' }, o).assignee).toEqual({ kind: 'me' })
    expect(parseTicketListQuery({ assignee: 'unassigned' }, o).assignee).toEqual({
      kind: 'unassigned'
    })
    expect(parseTicketListQuery({ status: 'closed' }, o).status).toEqual({ kind: 'closed' })
    expect(parseTicketListQuery({ status: 'all' }, o).status).toEqual({ kind: 'all' })
  })
})

describe('ticketOrderClauses', () => {
  it('attention: urgent, then unassigned, then longest waiting, then id', () => {
    const c = ticketOrderClauses('attention', { kind: 'open' })
    expect(c[0]).toMatch(/urgent/)
    expect(c[1]).toMatch(/assignee IS NULL THEN 0/)
    expect(c[2]).toBe(`${WAITING_SQL} ASC`)
    expect(c.at(-1)).toBe('t.id ASC')
  })

  it('attention on closed requests: newest closed first', () => {
    expect(ticketOrderClauses('attention', { kind: 'closed' })[0]).toMatch(/completed_at.*DESC/)
  })

  it('every order ends on the id (stable pages)', () => {
    for (const s of ['newest', 'oldest', 'updated', 'priority', null] as const)
      expect(ticketOrderClauses(s, { kind: 'open' }).at(-1)).toMatch(/^t\.id (ASC|DESC)$/)
  })

  it('newest / oldest / updated read the right column', () => {
    expect(ticketOrderClauses('newest', { kind: 'open' })[0]).toBe('t.created_at DESC')
    expect(ticketOrderClauses('oldest', { kind: 'open' })[0]).toBe('t.created_at ASC')
    expect(ticketOrderClauses('updated', { kind: 'open' })[0]).toMatch(/updated_at.*DESC/)
  })

  it('the waiting time ignores the requester’s own replies and never binds a value', () => {
    expect(WAITING_SQL).toMatch(/c\.\[user\] <> t\.created_by/)
    expect(WAITING_SQL).not.toMatch(/\?/)
  })
})

describe('parseBulkBody', () => {
  it('reads ids and the change; me = the caller', () => {
    expect(parseBulkBody({ ids: [3, '4', 3], assignee: 'me', status: 'done' }, 'ME')).toEqual({
      ok: true,
      ids: [3, 4],
      change: { assignee: 'ME', status: 'done' }
    })
  })

  it('null assignee unassigns', () => {
    const r = parseBulkBody({ ids: [1], assignee: null }, 'ME')
    expect(r.ok && r.change).toEqual({ assignee: null })
  })

  it('refuses no ids, too many ids, a bad id and no change', () => {
    expect(parseBulkBody({ ids: [], status: 'done' }, 'ME').ok).toBe(false)
    expect(
      parseBulkBody(
        { ids: Array.from({ length: BULK_MAX + 1 }, (_, i) => i + 1), status: 'done' },
        'ME'
      ).ok
    ).toBe(false)
    expect(parseBulkBody({ ids: [1, '1e99'], status: 'done' }, 'ME').ok).toBe(false)
    expect(parseBulkBody({ ids: [1] }, 'ME').ok).toBe(false)
  })

  it('ignores a title (bulk never renames)', () => {
    expect(parseBulkBody({ ids: [1], title: 'x' }, 'ME').ok).toBe(false)
  })
})
