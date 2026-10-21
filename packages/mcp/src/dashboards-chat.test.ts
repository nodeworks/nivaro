import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Command } from '@nivaro/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { CHAT_TOOL_NAMES, TOOL_NAMES } from './index.js'
import { apiError, connect, type Handler, mockClient, textOf } from './test-utils.js'
import { compactFigure, mapLimit, toFilters } from './tools/dashboards.js'

let calls: Command<unknown>[]
let mcp: Client
let answer: Handler

async function setup(chatAccess: 'none' | 'read' | 'post' = 'none') {
  answer = () => ({ data: [] })
  const mock = mockClient((c) => answer(c))
  calls = mock.calls
  mcp = (await connect(mock.client, { chatAccess })).mcp
}

const call = (name: string, args: Record<string, unknown> = {}) =>
  mcp.callTool({ name, arguments: args })

afterEach(async () => {
  await mcp?.close()
})

const board = {
  id: 'D1',
  name: 'Team board',
  user: 'U1',
  is_shared: true,
  role_id: null,
  global_filters: [{ field: 'region', value: 'east' }],
  widgets: [
    {
      id: 'W2',
      dashboard: 'D1',
      type: 'latest',
      title: 'Newest',
      collection: 'orders',
      field: 'name',
      row: 1,
      col: 0
    },
    {
      id: 'W1',
      dashboard: 'D1',
      type: 'count',
      title: 'Open orders',
      collection: 'orders',
      field: null,
      row: 0,
      col: 0
    },
    {
      id: 'W3',
      dashboard: 'D1',
      type: 'sum',
      title: 'Value',
      collection: 'secret',
      field: 'amount',
      row: 0,
      col: 6
    }
  ]
}

describe('dashboard and report tools (#2491)', () => {
  it('list_dashboards lists both boards and reports, filtered by search', async () => {
    await setup()
    answer = (c) =>
      c._path === '/dashboards'
        ? { data: [board, { ...board, id: 'D2', name: 'Other', widgets: [] }] }
        : {
            data: [
              {
                id: 'R1',
                name: 'Team spend',
                description: 'by month',
                is_shared: false,
                role_id: null,
                widget_count: 4
              }
            ]
          }
    const body = textOf(await call('list_dashboards', { search: 'team' }))
    expect(body.dashboards).toEqual([
      { id: 'D1', name: 'Team board', shared: true, widgets: 3, filters: board.global_filters }
    ])
    expect(body.reports).toEqual([
      { id: 'R1', name: 'Team spend', description: 'by month', shared: false, widgets: 4 }
    ])
  })

  it('list_dashboards still answers when one list fails', async () => {
    await setup()
    answer = (c) => {
      if (c._path === '/dashboards') throw apiError(500, { error: 'boom' })
      return { data: [] }
    }
    const res = await call('list_dashboards')
    expect(res.isError).toBeFalsy()
    const body = textOf(res)
    expect(body.dashboards_error).toEqual({ error: 'boom', status: 500 })
    expect(body.reports).toEqual([])
  })

  it('read_dashboard computes each widget through the widget endpoint with the saved filters', async () => {
    await setup()
    answer = (c) => {
      if (c._path === '/dashboards/D1') return { data: board }
      if (c._path === '/dashboards/widgets/W1/data') return { data: { value: 7 } }
      if (c._path === '/dashboards/widgets/W2/data')
        return { data: { rows: [{ id: 1, name: 'x'.repeat(300) }] } }
      throw apiError(403, { error: 'Forbidden' })
    }
    const body = textOf(await call('read_dashboard', { dashboard_id: 'D1' }))
    // Top-left first; the figure comes from the API, never computed here.
    expect(body.widgets.map((w: { id: string }) => w.id)).toEqual(['W1', 'W3', 'W2'])
    expect(body.widgets[0]).toEqual({
      id: 'W1',
      title: 'Open orders',
      type: 'count',
      collection: 'orders',
      figure: { value: 7 }
    })
    // A widget the caller may not see says so instead of failing the board.
    expect(body.widgets[1]).toMatchObject({ id: 'W3', error: 'Forbidden', status: 403 })
    expect(body.widgets[2].figure.rows[0].name).toHaveLength(161)
    const dataCalls = calls.filter((c) => c._path.endsWith('/data'))
    expect(dataCalls).toHaveLength(3)
    for (const c of dataCalls)
      expect(c._params).toEqual({ extra_filters: JSON.stringify(board.global_filters) })
  })

  it('read_dashboard: filters replace the saved bar, [] clears it, widget_ids pick', async () => {
    await setup()
    answer = (c) => (c._path === '/dashboards/D1' ? { data: board } : { data: { value: 1 } })
    const body = textOf(
      await call('read_dashboard', {
        dashboard_id: 'D1',
        widget_ids: ['W3', 'nope'],
        filters: '[]'
      })
    )
    expect(body.widgets.map((w: { id: string }) => w.id)).toEqual(['W3'])
    expect(body.unknown_widget_ids).toEqual(['nope'])
    expect(body.filters).toEqual([])
    expect(calls.at(-1)?._params).toBeUndefined()
    const bad = await call('read_dashboard', { dashboard_id: 'D1', filters: '{oops' })
    expect(bad.isError).toBe(true)
    expect(textOf(bad).code).toBe('BAD_FILTERS')
  })

  it('read_dashboard passes the API refusal through for a board the caller cannot open', async () => {
    await setup()
    answer = () => {
      throw apiError(403, { error: 'Forbidden' })
    }
    const res = await call('read_dashboard', { dashboard_id: 'D9' })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatchObject({ error: 'Forbidden', status: 403 })
  })

  it('run_report resolves each widget as the caller with the asked date range', async () => {
    await setup()
    answer = (c) => {
      if (c._path === '/report-studio/R1')
        return {
          data: {
            id: 'R1',
            name: 'Spend',
            description: null,
            global_filters: { date_range: { preset: 'ytd' } },
            widgets: [
              { id: 'K', type: 'kpi', title: 'Total', collection: 'po', x: 0, y: 0, sort: 0 },
              { id: 'X', type: 'divider', title: '', collection: null, x: 0, y: 1, sort: 1 },
              { id: 'S', type: 'bar', title: 'By month', collection: 'po', x: 0, y: 2, sort: 2 }
            ]
          }
        }
      if (c._path.endsWith('/K/data')) return { data: { value: 10, prev_value: 8, change_pct: 25 } }
      return {
        data: {
          series: Array.from({ length: 60 }, (_, i) => ({ dim: `m${i}`, value: i })),
          spark: [{ dim: 'a', value: 1 }]
        }
      }
    }
    const body = textOf(
      await call('run_report', { report_id: 'R1', date_range: { preset: 'last_3_months' } })
    )
    expect(body.date_range).toEqual({ preset: 'last_3_months' })
    expect(body.widgets.map((w: { id: string }) => w.id)).toEqual(['K', 'S'])
    expect(body.widgets[0].figure).toEqual({ value: 10, prev_value: 8, change_pct: 25 })
    expect(body.widgets[1].figure.series).toHaveLength(50)
    expect(body.widgets[1].figure.series_total).toBe(60)
    expect(body.widgets[1].figure.spark).toBeUndefined()
    const k = calls.find((c) => c._path === '/report-studio/R1/widgets/K/data')
    expect(k?._method).toBe('POST')
    expect(k?._body).toEqual({ date_range: { preset: 'last_3_months' } })
  })

  it('run_report refuses a custom range without both dates', async () => {
    await setup()
    const res = await call('run_report', { report_id: 'R1', date_range: { preset: 'custom' } })
    expect(textOf(res).code).toBe('BAD_DATE_RANGE')
    expect(calls).toHaveLength(0)
  })

  it('helpers: compactFigure, toFilters, mapLimit', async () => {
    expect(compactFigure(null)).toBeNull()
    expect(compactFigure({ narrative: 'n'.repeat(2000) })).toEqual({
      narrative: `${'n'.repeat(1500)}…`
    })
    expect(toFilters([{ field: 'a', value: 1, op: 'gt' }])).toEqual([
      { field: 'a', value: 1, op: 'gt' }
    ])
    expect(() => toFilters([{ field: 'a b', value: 1 }])).toThrow()
    let live = 0
    let peak = 0
    const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      live++
      peak = Math.max(peak, live)
      await new Promise((r) => setTimeout(r, 2))
      live--
      return n * 2
    })
    expect(out).toEqual([2, 4, 6, 8, 10, 12])
    expect(peak).toBe(2)
  })
})

describe('chat tools (#2492)', () => {
  it('are never registered without chat access, and notifications hide chat text', async () => {
    await setup('none')
    const names = (await mcp.listTools()).tools.map((t) => t.name)
    for (const n of CHAT_TOOL_NAMES) expect(names).not.toContain(n)
    answer = () => ({
      data: [
        {
          id: 1,
          subject: 'Pat mentioned you',
          message: 'secret plan',
          status: 'inbox',
          collection: '__chat__',
          item: 'global'
        },
        {
          id: 2,
          subject: 'Approve',
          message: 'm',
          status: 'inbox',
          collection: 'orders',
          item: '5'
        }
      ],
      total: 2
    })
    const body = textOf(await call('list_notifications'))
    expect(JSON.stringify(body)).not.toContain('secret plan')
    expect(JSON.stringify(body)).not.toContain('Pat mentioned')
    expect(body.notifications[0]).toMatchObject({ id: 1, unread: true })
    expect(body.notifications[1]).toMatchObject({ id: 2, subject: 'Approve' })
  })

  it('read access lists and reads but cannot post', async () => {
    await setup('read')
    const names = (await mcp.listTools()).tools.map((t) => t.name)
    expect(names).toContain('list_chat_rooms')
    expect(names).toContain('read_chat_messages')
    expect(names).not.toContain('post_chat_message')
    expect(names.sort()).toEqual([...TOOL_NAMES, 'list_chat_rooms', 'read_chat_messages'].sort())
  })

  it('list_chat_rooms and read_chat_messages stay compact', async () => {
    await setup('read')
    answer = (c) => {
      if (c._path === '/chat/rooms')
        return {
          data: [
            {
              room: 'global',
              kind: 'global',
              label: 'General',
              unread: 0,
              muted: false,
              channel: null,
              last_message: null
            },
            {
              room: 'ch:ops',
              kind: 'channel',
              label: 'Ops',
              unread: 3,
              muted: false,
              channel: { topic: 'Deploys' },
              last_message: { id: 9, message: 'shipped', sender_name: 'Pat', date_created: 't' }
            }
          ]
        }
      return {
        data: [
          {
            id: 8,
            room: 'ch:ops',
            message: 'hello',
            sender: 'U2',
            sender_name: 'Pat',
            date_created: 't1',
            attachments: ['f'],
            reactions: [
              { emoji: '👍', user: 'a' },
              { emoji: '👍', user: 'b' }
            ],
            thread: { count: 2 },
            via_app: 'Claude'
          },
          {
            id: 9,
            room: 'ch:ops',
            message: 'gone',
            sender_name: 'Al',
            date_created: 't2',
            deleted_at: 'x',
            attachments: [],
            reactions: []
          }
        ],
        meta: { has_older: true, has_newer: false, anchor: null }
      }
    }
    const rooms = textOf(await call('list_chat_rooms', { unread_only: true }))
    expect(rooms.rooms).toEqual([
      {
        room: 'ch:ops',
        kind: 'channel',
        name: 'Ops',
        unread: 3,
        topic: 'Deploys',
        last_message: { id: 9, sender: 'Pat', at: 't', text: 'shipped' }
      }
    ])
    const msgs = textOf(await call('read_chat_messages', { room: 'ch:ops', limit: 500 }))
    expect(calls.at(-1)).toMatchObject({
      _path: '/chat/messages',
      _params: { room: 'ch:ops', limit: 100 }
    })
    expect(msgs.messages[0]).toEqual({
      id: 8,
      sender: 'Pat',
      at: 't1',
      text: 'hello',
      via_app: 'Claude',
      replies: 2,
      attachments: 1,
      reactions: [{ emoji: '👍', count: 2 }]
    })
    expect(msgs.messages[1]).toMatchObject({ id: 9, text: null, deleted: true })
    expect(msgs.next_before).toBe(8)
  })

  it('post_chat_message rehearses by default and posts with dry_run false', async () => {
    await setup('post')
    answer = (c) =>
      c._method === 'POST'
        ? {
            data: {
              id: 50,
              room: 'global',
              message: 'Hi all',
              sender_name: 'Pat',
              date_created: 't',
              attachments: [],
              reactions: [],
              via_app: 'Claude'
            }
          }
        : { data: [] }
    const dry = textOf(await call('post_chat_message', { room: 'global', message: 'Hi all' }))
    expect(dry.dry_run).toBe(true)
    expect(calls.every((c) => c._method === 'GET')).toBe(true)
    expect(calls.at(-1)).toMatchObject({
      _path: '/chat/messages',
      _params: { room: 'global', limit: 1 }
    })

    const real = textOf(
      await call('post_chat_message', {
        room: 'global',
        message: 'Hi all',
        thread_id: 4,
        client_id: 'retry-key-1',
        dry_run: false
      })
    )
    expect(real).toMatchObject({ posted: true, message: { id: 50, via_app: 'Claude' } })
    expect(calls.at(-1)).toMatchObject({
      _method: 'POST',
      _path: '/chat/messages',
      _body: { room: 'global', message: 'Hi all', parent_id: 4, client_id: 'retry-key-1' }
    })
  })

  it('a room the person cannot open refuses on the rehearsal as on the post', async () => {
    await setup('post')
    answer = () => {
      throw apiError(403, { error: 'That conversation is not available to you' })
    }
    const res = await call('post_chat_message', { room: 'dm:a:b', message: 'x' })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatchObject({ status: 403 })
    const bad = await call('read_chat_messages', { room: '../auth' })
    expect(bad.isError).toBe(true)
  })
})
