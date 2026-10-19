import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Command } from '@nivaro/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apiError, connect, type Handler, mockClient, textOf } from './test-utils.js'
import { fileIdsOf, planFileFields } from './tools/record.js'

let calls: Command<unknown>[]
let mcp: Client
let answer: Handler

async function setup(adminTools = false) {
  answer = () => ({ data: [] })
  const mock = mockClient((c) => answer(c))
  calls = mock.calls
  mcp = (await connect(mock.client, { adminTools })).mcp
}

const call = (name: string, args: Record<string, unknown> = {}) =>
  mcp.callTool({ name, arguments: args })

describe('everyday-work tools', () => {
  beforeEach(() => setup())
  afterEach(async () => {
    await mcp.close()
  })

  it('my_work cuts each section and says which were cut', async () => {
    answer = () => ({
      data: {
        owned: [
          {
            collection: 'orders',
            item: '1',
            label: 'O-1',
            state: 'Review',
            url: '/x',
            sla: { status: 'breached', remaining_hours: -2, elapsed_hours: 9 }
          },
          { collection: 'orders', item: '2', label: 'O-2', state: null, sla: null }
        ],
        owned_total: 2,
        tasks: [{ id: 5, title: 'Call', status: 'open', description: 'x'.repeat(400) }],
        team_tasks: [],
        requested: [],
        approvals: [],
        notifications: [{ id: 9, subject: 'Hi', message: 'm', status: 'inbox', timestamp: 't' }],
        counts: { owned: 2, tasks: 1 }
      }
    })
    const body = textOf(await call('my_work', { limit: 1 }))
    expect(calls[0]).toMatchObject({ _method: 'GET', _path: '/my-work' })
    expect(body.owned).toEqual([
      {
        collection: 'orders',
        item: '1',
        label: 'O-1',
        state: 'Review',
        sla: { status: 'breached', remaining_hours: -2 }
      }
    ])
    expect(body.tasks[0].description).toHaveLength(301)
    expect(body.notifications[0]).toMatchObject({ id: 9, subject: 'Hi', unread: true })
    expect(body.truncated).toEqual(['owned'])
    expect(body.counts).toEqual({ owned: 2, tasks: 1 })
  })

  it('list_queues keeps id, name and source collections', async () => {
    answer = () => ({
      data: [
        {
          id: 'q-1',
          name: 'Approvals',
          description: null,
          is_shared: true,
          claims_enabled: false,
          display_config: { views: ['table'] },
          source_collections: ['orders']
        }
      ]
    })
    const body = textOf(await call('list_queues'))
    expect(calls[0]).toMatchObject({ _method: 'GET', _path: '/queues' })
    expect(body).toEqual([
      {
        id: 'q-1',
        name: 'Approvals',
        description: null,
        shared: true,
        claims_enabled: false,
        source_collections: ['orders']
      }
    ])
  })

  it('read_queue always pages and shapes items', async () => {
    answer = () => ({
      data: [
        {
          collection: 'orders',
          item_id: '7',
          label: 'O-7',
          state: 'Open',
          state_color: '#fff',
          owners: [{ id: 'u', email: 'a@b.c', first_name: 'Ann', last_name: 'Lee' }],
          sla_status: 'warning',
          at_risk: false,
          aging_hours: 30,
          claimed_by: null,
          extra: { note: 'y'.repeat(300) },
          url: '/u'
        }
      ],
      stats: { total: 60 },
      total: 60,
      truncated: false
    })
    const body = textOf(
      await call('read_queue', { queue_id: 'q-1', scope: 'mine', limit: 500, page: 2 })
    )
    expect(calls[0]).toMatchObject({
      _method: 'GET',
      _path: '/queues/q-1/items',
      _params: { scope: 'mine', page: 2, limit: 100 }
    })
    expect(body.items[0]).toMatchObject({
      collection: 'orders',
      id: '7',
      owners: ['Ann Lee'],
      sla_status: 'warning'
    })
    expect(body.items[0].extra.note).toHaveLength(201)
    expect(body).toMatchObject({ total: 60, page: 2, limit: 100, truncated: false })
  })

  it('read_queue refuses an id that could leave the path', async () => {
    const res = await call('read_queue', { queue_id: '../auth' })
    expect(res.isError).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('list_tasks reads mine by default and a record when named', async () => {
    answer = () => ({ data: [{ id: 1, title: 'a', status: 'open', assignee_name: 'Ann' }] })
    const mine = textOf(await call('list_tasks'))
    expect(calls[0]).toMatchObject({ _method: 'GET', _path: '/tasks/mine' })
    expect(mine).toEqual({
      tasks: [{ id: 1, title: 'a', status: 'open', assignee_name: 'Ann' }],
      total: 1,
      offset: 0,
      truncated: false
    })
    await call('list_tasks', { collection: 'orders', id: 4, status: 'done' })
    expect(calls[1]).toMatchObject({
      _path: '/tasks',
      _params: { collection: 'orders', item: '4', status: 'done' }
    })
    await call('list_tasks', { status: 'done' })
    expect(calls[2]).toMatchObject({ _path: '/tasks', _params: { assignee: 'me', status: 'done' } })
    const bad = await call('list_tasks', { collection: 'orders' })
    expect(bad.isError).toBe(true)
    expect(calls).toHaveLength(3)
  })

  it('create_task posts the task and reports a delegation', async () => {
    answer = () => ({ data: { id: 3, title: 'Sign', status: 'open', delegated_from: 'u-9' } })
    const body = textOf(
      await call('create_task', {
        collection: 'orders',
        id: 12,
        title: 'Sign',
        assignee: 'u-2',
        due_date: '2026-11-01',
        priority: 'urgent'
      })
    )
    expect(calls[0]).toMatchObject({
      _method: 'POST',
      _path: '/tasks',
      _body: {
        collection: 'orders',
        item: '12',
        title: 'Sign',
        assignee: 'u-2',
        due_date: '2026-11-01',
        priority: 'urgent'
      }
    })
    expect(body).toMatchObject({ id: 3, delegated_from: 'u-9' })
  })

  it('complete_task posts to the task and surfaces a 409', async () => {
    answer = () => {
      throw apiError(409, { error: 'Task is already done' })
    }
    const res = await call('complete_task', { task_id: 3 })
    expect(calls[0]).toMatchObject({ _method: 'POST', _path: '/tasks/3/complete' })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatchObject({ error: 'Task is already done', status: 409 })
  })

  it('list_notifications reads the unread inbox page', async () => {
    answer = () => ({
      data: [{ id: 1, subject: 's', message: 'm', status: 'inbox', timestamp: 't', lane: 'fyi' }],
      total: 45,
      page: 1,
      limit: 20
    })
    const body = textOf(await call('list_notifications'))
    expect(calls[0]).toMatchObject({
      _path: '/notifications',
      _params: { status: 'inbox', page: 1, limit: 20 }
    })
    expect(body).toMatchObject({ total: 45, truncated: true })
    expect(body.notifications[0]).toEqual({
      id: 1,
      subject: 's',
      message: 'm',
      unread: true,
      at: 't',
      lane: 'fyi'
    })
    await call('list_notifications', { unread_only: false })
    expect(calls[1]._params).toMatchObject({ status: 'all' })
  })

  it('mark_notifications_read marks ids or everything, never nothing', async () => {
    answer = () => ({ data: { updated: 2 } })
    const none = await call('mark_notifications_read', {})
    expect(none.isError).toBe(true)
    expect(calls).toHaveLength(0)
    await call('mark_notifications_read', { ids: [1, 2] })
    expect(calls[0]).toMatchObject({
      _method: 'POST',
      _path: '/notifications/mark-read',
      _body: { ids: [1, 2] }
    })
    await call('mark_notifications_read', { all: true })
    expect(calls[1]).toMatchObject({ _method: 'POST', _path: '/notifications/mark-all-read' })
  })
})

describe('record tools', () => {
  beforeEach(() => setup())
  afterEach(async () => {
    await mcp.close()
  })

  it('list_comments shows the newest comments and names authors and mentions', async () => {
    const thread = Array.from({ length: 5 }, (_, i) => ({
      id: `c${i}`,
      user: { id: 'u', first_name: 'Ann', last_name: null, email: 'ann@x.y' },
      text: `t${i}`,
      created_at: `2026-01-0${i + 1}`,
      edited: i === 4,
      mentions: i === 4 ? [{ id: 'u2', first_name: null, last_name: null, email: 'bo@x.y' }] : []
    }))
    answer = () => ({ data: thread })
    const body = textOf(await call('list_comments', { collection: 'orders', id: 7, limit: 2 }))
    expect(calls[0]).toMatchObject({
      _method: 'GET',
      _path: '/comments',
      _params: { collection: 'orders', item: 7 }
    })
    expect(body.comments.map((c: { id: string }) => c.id)).toEqual(['c3', 'c4'])
    expect(body.comments[1]).toEqual({
      id: 'c4',
      author: 'Ann',
      text: 't4',
      at: '2026-01-05',
      edited: true,
      mentions: ['bo@x.y']
    })
    expect(body).toMatchObject({ total: 5, truncated: true })
  })

  it('add_comment posts the text as-is so the API resolves mentions', async () => {
    answer = () => ({
      data: {
        id: 'c9',
        created_at: 'now',
        mentions: [{ id: 'u2', first_name: 'Bo', last_name: 'Ng', email: 'bo@x.y' }]
      }
    })
    const body = textOf(
      await call('add_comment', { collection: 'orders', id: 7, text: 'ping @bo and @owners' })
    )
    expect(calls[0]).toMatchObject({
      _method: 'POST',
      _path: '/comments',
      _body: { collection: 'orders', item: '7', text: 'ping @bo and @owners' }
    })
    expect(body).toEqual({ id: 'c9', at: 'now', mentioned: ['Bo Ng'] })
  })

  it('list_revisions pages the history and drops full snapshots', async () => {
    answer = () => ({
      data: [
        {
          id: 3,
          timestamp: 't3',
          action: 'update',
          first_name: 'Ann',
          last_name: 'Lee',
          data: { huge: 'x' },
          delta: { amount: 5, note: 'n'.repeat(400) },
          comment: 'reforecast'
        },
        {
          id: null,
          timestamp: 't2',
          action: 'transition',
          user_email: 'bo@x.y',
          data: {},
          delta: null,
          event: { kind: 'transition', from_label: 'Draft', to_label: 'Review' }
        },
        { id: 1, timestamp: 't1', action: 'create', data: { a: 1 }, delta: null }
      ]
    })
    const body = textOf(await call('list_revisions', { collection: 'orders', id: 7, limit: 2 }))
    expect(calls[0]).toMatchObject({
      _path: '/revisions',
      _params: { collection: 'orders', item: 7 }
    })
    expect(body.revisions[0]).toMatchObject({
      id: 3,
      by: 'Ann Lee',
      comment: 'reforecast',
      changes: { amount: 5 }
    })
    expect(body.revisions[0].changes.note).toHaveLength(301)
    expect(body.revisions[0]).not.toHaveProperty('data')
    expect(body.revisions[1].event).toEqual({
      kind: 'transition',
      from: 'Draft',
      to: 'Review',
      transition: null
    })
    expect(body).toMatchObject({ total: 3, truncated: true })
  })

  it('list_record_files reads the file fields, then only those files', async () => {
    const schema = {
      collection: 'orders',
      fields: [
        { field: 'id', interface: 'input' },
        { field: 'invoice', interface: 'file' },
        { field: 'photo', interface: 'select-dropdown-m2o' },
        { field: 'attachments', interface: 'files-m2m' }
      ],
      relations: [
        { many_collection: 'orders', many_field: 'photo', one_collection: 'nivaro_files' },
        {
          many_collection: 'orders_files',
          many_field: 'orders_id',
          one_collection: 'orders',
          one_field: 'attachments',
          junction_field: 'nivaro_files_id'
        }
      ]
    }
    answer = (c) => {
      if (c._path === '/collections/orders') return { data: schema }
      if (c._path === '/items/orders/7') {
        return {
          data: {
            invoice: 'AAA-1',
            photo: null,
            attachments: [{ nivaro_files_id: 'bbb-2' }, { nivaro_files_id: 'aaa-1' }]
          }
        }
      }
      return {
        data: [
          {
            id: 'AAA-1',
            title: 'Invoice',
            filename_download: 'inv.pdf',
            filename_disk: 'secret/key.pdf',
            type: 'application/pdf',
            filesize: 10
          },
          { id: 'bbb-2', filename_download: 'b.png', type: 'image/png', filesize: 4 }
        ],
        total: 2
      }
    }
    const body = textOf(await call('list_record_files', { collection: 'orders', id: 7 }))
    expect(calls[1]).toMatchObject({
      _path: '/items/orders/7',
      _params: { fields: 'invoice,photo,attachments.nivaro_files_id' }
    })
    expect(calls[2]).toMatchObject({
      _method: 'GET',
      _path: '/files',
      _params: { filter: '{"id":{"_in":["aaa-1","bbb-2"]}}', limit: 2 }
    })
    expect(body.files).toEqual([
      {
        field: 'invoice',
        id: 'AAA-1',
        title: 'Invoice',
        filename_download: 'inv.pdf',
        type: 'application/pdf',
        filesize: 10
      },
      {
        field: 'attachments',
        id: 'bbb-2',
        filename_download: 'b.png',
        type: 'image/png',
        filesize: 4
      }
    ])
    expect(JSON.stringify(body)).not.toContain('secret/key')
  })

  it('list_record_files says so when a collection has no file fields', async () => {
    answer = () => ({ data: { collection: 'tags', fields: [{ field: 'id' }], relations: [] } })
    const body = textOf(await call('list_record_files', { collection: 'tags', id: 1 }))
    expect(body.files).toEqual([])
    expect(calls).toHaveLength(1)
  })

  it('read_file reads metadata and never a URL or storage key', async () => {
    answer = () => ({
      data: {
        id: 'f1',
        filename_download: 'a.pdf',
        filename_disk: 'k/a.pdf',
        url: 'https://s3/x?sig',
        type: 'application/pdf',
        filesize: 3,
        uploaded_by: 'u1'
      }
    })
    const body = textOf(await call('read_file', { file_id: 'f1' }))
    expect(calls[0]).toMatchObject({ _method: 'GET', _path: '/files/f1/meta' })
    expect(body).toEqual({
      id: 'f1',
      filename_download: 'a.pdf',
      type: 'application/pdf',
      filesize: 3,
      uploaded_by: 'u1'
    })
  })
})

describe('file field planning', () => {
  it('ignores a to-many alias that does not lead to files', () => {
    const plan = planFileFields('articles', {
      fields: [{ field: 'tags', interface: 'select-multiple-m2m' }],
      relations: [
        {
          many_collection: 'articles_tags',
          many_field: 'articles_id',
          one_collection: 'articles',
          one_field: 'tags',
          junction_field: 'tags_id'
        }
      ]
    })
    expect(plan).toEqual({ single: [], many: [] })
  })

  it('collects ids from plain values and expanded objects, once each', () => {
    const plan = { single: ['a'], many: [{ field: 'm', path: 'm.f' }] }
    const ids = fileIdsOf({ a: { id: 'X' }, m: [{ f: 'x' }, { f: 'y' }, { f: null }] }, plan)
    expect([...ids.entries()]).toEqual([
      ['x', 'a'],
      ['y', 'm']
    ])
  })
})

describe('lookup tools', () => {
  beforeEach(() => setup())
  afterEach(async () => {
    await mcp.close()
  })

  it('search sends the query with collections and a capped limit', async () => {
    answer = () => ({
      data: [
        {
          collection: 'orders',
          collection_label: 'Orders',
          id: '7',
          label: 'O-7',
          score: 80,
          matched_field: 'name'
        }
      ],
      meta: { searched: 3, skipped: ['secret'], truncated: false }
    })
    const body = textOf(
      await call('search', { q: 'acme', collections: ['orders', 'vendors'], limit: 500 })
    )
    expect(calls[0]).toMatchObject({
      _method: 'GET',
      _path: '/search',
      _params: { q: 'acme', collections: 'orders,vendors', limit: 100 }
    })
    expect(body).toEqual({
      hits: [
        {
          collection: 'orders',
          collection_label: 'Orders',
          id: '7',
          label: 'O-7',
          matched_field: 'name'
        }
      ],
      searched: 3,
      skipped: ['secret'],
      truncated: false
    })
  })

  it('find_people returns ids and mention handles', async () => {
    answer = () => ({
      data: [{ id: 'u1', first_name: 'Ann', last_name: 'Lee', email: 'ann.lee@x.y', title: 'PM' }]
    })
    const body = textOf(await call('find_people', { search: 'ann' }))
    expect(calls[0]).toMatchObject({ _path: '/users', _params: { search: 'ann', limit: 10 } })
    expect(body).toEqual([
      { id: 'u1', name: 'Ann Lee', email: 'ann.lee@x.y', mention: '@ann.lee', title: 'PM' }
    ])
  })

  it('list_custom_queries reads the catalog', async () => {
    answer = () => ({
      data: [{ id: 1, slug: 'spend', name: 'Spend', description: null, params: [] }]
    })
    const body = textOf(await call('list_custom_queries'))
    expect(calls[0]).toMatchObject({ _method: 'GET', _path: '/custom-queries/catalog' })
    expect(body).toEqual({
      count: 1,
      truncated: false,
      queries: [{ slug: 'spend', name: 'Spend', params: [] }]
    })
  })

  it('run_custom_query posts the params and cuts the rows', async () => {
    answer = () => ({
      data: [{ a: 1, b: 'z'.repeat(600) }, { a: 2 }, { a: 3 }],
      cached: true,
      executed_at: 'then',
      age_seconds: 40
    })
    const body = textOf(
      await call('run_custom_query', { slug: 'spend', params: '{"year":2026}', limit: 2 })
    )
    expect(calls[0]).toMatchObject({
      _method: 'POST',
      _path: '/custom-queries/spend/execute',
      _body: { params: { year: 2026 } }
    })
    expect(body).toMatchObject({ row_count: 3, truncated: true, cached: true, age_seconds: 40 })
    expect(body.rows).toHaveLength(2)
    expect(body.rows[0].b).toHaveLength(501)
  })

  it('run_custom_query refuses a slug that could leave the path', async () => {
    const res = await call('run_custom_query', { slug: '../admin' })
    expect(res.isError).toBe(true)
    expect(calls).toHaveLength(0)
  })
})

describe('admin tools', () => {
  beforeEach(() => setup(true))
  afterEach(async () => {
    await mcp.close()
  })

  it('health folds readiness into the detailed report, even when not ready', async () => {
    answer = (c) => {
      if (c._path === '/ready') {
        throw apiError(503, {
          ready: false,
          checks: [{ id: 'redis', ok: false, summary: 'Redis down' }]
        })
      }
      return {
        data: {
          db: { ok: true, latency_ms: 3 },
          redis: { ok: false, latency_ms: 2000 },
          migrations: { latest: '410_x', count: 410 },
          sockets: { connections: 4 },
          redis_degradation: { redis_ok: false, consumers: [{ name: 'sessions' }] },
          uptime_s: 10,
          version: '0.2.58',
          node_version: 'v22',
          memory_mb: 300
        }
      }
    }
    const res = await call('health')
    expect(res.isError).toBeFalsy()
    const body = textOf(res)
    expect(calls.map((c) => c._path).sort()).toEqual(['/health/detailed', '/ready'])
    expect(body).toMatchObject({
      ready: false,
      checks: [{ id: 'redis', ok: false }],
      db: { ok: true },
      version: '0.2.58'
    })
    expect(body).not.toHaveProperty('redis_degradation')
  })

  it('health still fails cleanly on a refusal', async () => {
    answer = () => {
      throw apiError(403, { error: 'Forbidden' })
    }
    const res = await call('health')
    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatchObject({ status: 403 })
  })

  it('preflight answers its report on a 503', async () => {
    answer = () => {
      throw apiError(503, { data: { status: 'fail', checks: [{ id: 'migrations' }] } })
    }
    const body = textOf(await call('preflight'))
    expect(calls[0]).toMatchObject({ _method: 'GET', _path: '/preflight' })
    expect(body).toMatchObject({ status: 'fail', checks: [{ id: 'migrations' }] })
  })

  it('runtime_stats reads this replica and the roster', async () => {
    answer = (c) =>
      c._path === '/ops-runtime/runtime'
        ? { data: { rss_mb: 200, pool: { used: 1 } } }
        : { data: [{ instance: 'a' }, { instance: 'b' }], scheduler: { holder: 'a' } }
    const body = textOf(await call('runtime_stats'))
    expect(body).toEqual({
      this_replica: { rss_mb: 200, pool: { used: 1 } },
      instances: [{ instance: 'a' }, { instance: 'b' }],
      instances_total: 2,
      scheduler: { holder: 'a' }
    })
  })

  it('db_pool cuts the held list', async () => {
    answer = () => ({
      data: {
        used: 2,
        free: 8,
        pending_acquires: 0,
        pending_creates: 0,
        max: 10,
        held: Array.from({ length: 30 }, (_, i) => ({ held_ms: 2000 + i, hint: null })),
        pressure: { wait_p95_ms: 1 }
      }
    })
    const body = textOf(await call('db_pool'))
    expect(calls[0]).toMatchObject({ _path: '/ops-db/pool' })
    expect(body.held).toHaveLength(20)
    expect(body).toMatchObject({ used: 2, held_total: 30, pressure: { wait_p95_ms: 1 } })
  })

  it('expensive_sql clips statements and passes an unavailable panel through', async () => {
    answer = () => ({
      data: Array.from({ length: 15 }, (_, i) => ({
        total_cpu_ms: 100 - i,
        statement_text: 's'.repeat(3000)
      }))
    })
    const body = textOf(await call('expensive_sql', { limit: 3 }))
    expect(calls[0]).toMatchObject({ _path: '/ops-db/expensive-sql' })
    expect(body).toHaveLength(3)
    expect(body[0].statement_text).toHaveLength(1501)
    answer = () => ({ unavailable: 'The database login lacks VIEW SERVER STATE' })
    expect(textOf(await call('expensive_sql'))).toEqual({
      unavailable: 'The database login lacks VIEW SERVER STATE'
    })
  })

  it('traffic_summary asks for the window and keeps the busiest entities', async () => {
    const entity = (key: string, req: number, error: number) => ({
      key,
      label: key,
      lane: 'items',
      req,
      error,
      p50: 1,
      p95: 2,
      series: [1, 2, 3],
      routes: [
        { route: 'a', n: 1 },
        { route: 'b', n: 1 },
        { route: 'c', n: 1 },
        { route: 'd', n: 1 }
      ],
      recent_errors: [{ big: true }]
    })
    answer = () => ({
      data: {
        at: 'now',
        window_s: 900,
        node_scope: 'cluster',
        totals: { req: 30 },
        sockets: { count: 2, users: 1 },
        entities: [entity('a', 5, 0), entity('b', 20, 3), entity('c', 10, 1)],
        callers: [{ key: 'k', req: 30, error: 0 }],
        down: [
          { id: 'db', label: 'DB', kind: 'db', req: 9, error: 0, p95: 3 },
          { id: 'x', label: 'X', kind: 'partner', req: 0, error: 0, p95: 0 }
        ]
      }
    })
    const body = textOf(await call('traffic_summary', { window: '900', top: 2 }))
    expect(calls[0]).toMatchObject({ _path: '/traffic-map/snapshot', _params: { window: 900 } })
    expect(body.busiest.map((e: { key: string }) => e.key)).toEqual(['b', 'c'])
    expect(body.most_errors.map((e: { key: string }) => e.key)).toEqual(['b', 'c'])
    expect(body.busiest[0].top_routes).toHaveLength(3)
    expect(body.busiest[0]).not.toHaveProperty('series')
    expect(body.downstream).toEqual([
      { id: 'db', label: 'DB', kind: 'db', req: 9, error: 0, p95: 3 }
    ])
    expect(body).toMatchObject({ entities_total: 3, callers_total: 1, totals: { req: 30 } })
  })

  it('list_cron_jobs reads the registry and can keep only failing jobs', async () => {
    const cron = (id: string, errors: number, last: string | null) => ({
      id,
      expression: '* * * * *',
      overridden: false,
      extension_id: null,
      next_run: 'soon',
      paused: false,
      heavy: false,
      description: null,
      last: last
        ? { status: last, started_at: 't', duration_ms: 1, outcome: null, error: null }
        : null,
      errors_7d: errors
    })
    answer = () => ({
      data: {
        crons: [cron('ok', 0, 'completed'), cron('flaky', 2, 'completed'), cron('bad', 0, 'error')],
        ticks_enabled: true,
        scheduler: null,
        running: []
      }
    })
    const body = textOf(await call('list_cron_jobs', { failing_only: true }))
    expect(calls[0]).toMatchObject({ _method: 'GET', _path: '/job-runs/registry' })
    expect(body.crons.map((c: { id: string }) => c.id)).toEqual(['flaky', 'bad'])
    expect(body.ticks_enabled).toBe(true)
  })

  it('list_job_runs passes the filters and pages', async () => {
    answer = () => ({
      data: [{ id: 1, kind: 'cron', job_id: 'x', status: 'error', error: 'e'.repeat(900) }],
      total: 50
    })
    const body = textOf(
      await call('list_job_runs', { kind: 'cron', status: 'error', job_id: 'sweep' })
    )
    expect(calls[0]).toMatchObject({
      _method: 'GET',
      _path: '/job-runs',
      _params: { kind: 'cron', status: 'error', job_id: 'sweep', page: 1, limit: 20 }
    })
    expect(body.runs[0].error).toHaveLength(501)
    expect(body).toMatchObject({ total: 50, truncated: true })
  })

  it('cpu_profile posts the seconds and refuses more than 30', async () => {
    answer = () => ({
      data: {
        name: 'p.cpuprofile',
        seconds: 5,
        busy_ms: 1,
        idle_ms: 2,
        gc_ms: 0,
        self: Array.from({ length: 25 }, () => ({ fn: 'f', where: 'w', ms: 1 })),
        files: [],
        ours: []
      }
    })
    const body = textOf(await call('cpu_profile', { seconds: 5 }))
    expect(calls[0]).toMatchObject({
      _method: 'POST',
      _path: '/ops-runtime/cpu-profile',
      _body: { seconds: 5 }
    })
    expect(body.self).toHaveLength(15)
    const tooLong = await call('cpu_profile', { seconds: 120 })
    expect(tooLong.isError).toBe(true)
    expect(calls).toHaveLength(1)
  })
})
