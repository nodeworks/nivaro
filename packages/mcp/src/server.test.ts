import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Command } from '@nivaro/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ADMIN_TOOL_NAMES,
  createNivaroMcpServer,
  keyIsAdmin,
  LAYOUT_TOOL_NAMES,
  TOOL_NAMES
} from './index.js'
import { apiError, connect, type Handler, mockClient, textOf } from './test-utils.js'

const COLLECTION = {
  collection: 'articles',
  display_name: 'Articles',
  singleton: false,
  display_template: '{{title}}',
  upsert_keys: null,
  change_reason_config: null,
  fields: [
    { field: 'id', type: 'integer', hidden: 1, required: 0 },
    {
      field: 'status',
      type: 'string',
      interface: 'select-dropdown',
      required: 1,
      options: '{"choices":[{"text":"Draft","value":"draft"},{"text":"Live","value":"live"}]}'
    },
    { field: 'total', type: 'decimal', computed_type: 'rollup', readonly: 1 }
  ],
  relations: [
    { many_collection: 'articles', many_field: 'author', one_collection: 'authors' },
    {
      many_collection: 'articles_tags',
      many_field: 'articles_id',
      one_collection: 'articles',
      one_field: 'tags',
      junction_collection: 'articles_tags',
      junction_field: 'tags_id'
    }
  ]
}

const INSTANCE = {
  instance: {
    id: 'inst-1',
    collection: 'articles',
    item: '7',
    template: 'tpl',
    current_state: 'st-review',
    started_at: '2026-01-01T00:00:00Z',
    completed_at: null
  },
  states: [
    { id: 'st-draft', key: 'draft', label: 'Draft', sort: 0, is_terminal: false },
    { id: 'st-review', key: 'review', label: 'In review', sort: 1, is_terminal: false },
    { id: 'st-done', key: 'done', label: 'Done', sort: 2, is_terminal: true }
  ],
  available_transitions: [{ id: 'tx-approve', label: 'Approve', to_state: 'st-done' }],
  history: [
    {
      timestamp: '2026-01-02T00:00:00Z',
      from_state_label: 'Draft',
      to_state_label: 'In review',
      first_name: 'Ada',
      last_name: 'Lovelace',
      comment: 'ready'
    }
  ],
  binding: {}
}

describe('createNivaroMcpServer', () => {
  it('refuses to build without a token or client', () => {
    expect(() => createNivaroMcpServer({ url: 'http://nivaro.test' })).toThrow(/token/i)
    expect(() => createNivaroMcpServer({ url: '', token: 'nvk_x' })).toThrow(/URL/i)
  })

  it('registers every tool and both resources, and no admin tool by default', async () => {
    const { client } = mockClient(() => ({ data: [] }))
    const { mcp } = await connect(client)
    const tools = await mcp.listTools()
    expect(tools.tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort())
    for (const name of [...ADMIN_TOOL_NAMES, ...LAYOUT_TOOL_NAMES]) {
      expect(tools.tools.map((t) => t.name)).not.toContain(name)
    }
    const resources = await mcp.listResources()
    const templates = await mcp.listResourceTemplates()
    expect(resources.resources.map((r) => r.uri)).toContain('nivaro://collections')
    expect(templates.resourceTemplates.map((t) => t.uriTemplate)).toContain(
      'nivaro://collection/{name}'
    )
    await mcp.close()
  })

  it('registers the admin tools only with adminTools: true', async () => {
    const { client } = mockClient(() => ({ data: [] }))
    const { mcp } = await connect(client, { adminTools: true })
    const tools = await mcp.listTools()
    expect(tools.tools.map((t) => t.name).sort()).toEqual(
      [...TOOL_NAMES, ...ADMIN_TOOL_NAMES, ...LAYOUT_TOOL_NAMES].sort()
    )
    await mcp.close()
  })

  it('annotates every tool, marks writes non-read-only and delete destructive', async () => {
    const { client } = mockClient(() => ({ data: [] }))
    const { mcp } = await connect(client, { adminTools: true })
    const { tools } = await mcp.listTools()
    const writes = new Set([
      'create_item',
      'update_item',
      'delete_item',
      'transition',
      'create_task',
      'complete_task',
      'mark_notifications_read',
      'add_comment',
      'cpu_profile',
      // a saved query may call a procedure that writes
      'run_custom_query',
      // stores a proposal (never the layout itself)
      'propose_layout_ops',
      // an instance tool may write
      'call_instance_tool'
    ])
    for (const tool of tools) {
      const a = tool.annotations
      expect(a, tool.name).toBeDefined()
      expect(a?.openWorldHint, tool.name).toBe(false)
      expect(typeof a?.readOnlyHint, tool.name).toBe('boolean')
      expect(a?.readOnlyHint, tool.name).toBe(!writes.has(tool.name))
      if (!a?.readOnlyHint) {
        expect(typeof a?.destructiveHint, tool.name).toBe('boolean')
        expect(typeof a?.idempotentHint, tool.name).toBe('boolean')
      }
      expect(a?.destructiveHint === true, tool.name).toBe(tool.name === 'delete_item')
    }
    await mcp.close()
  })

  it('keyIsAdmin reads whoami and is false when it cannot tell', async () => {
    const admin = mockClient(() => ({ data: { id: 'u1', is_admin: true } }))
    expect(await keyIsAdmin(admin.client)).toBe(true)
    expect(admin.calls[0]).toMatchObject({ _method: 'GET', _path: '/auth/me' })
    expect(await keyIsAdmin(mockClient(() => ({ data: { is_admin: false } })).client)).toBe(false)
    const down = mockClient(() => {
      throw apiError(401, { error: 'Unauthorized' })
    })
    expect(await keyIsAdmin(down.client)).toBe(false)
  })
})

describe('tools', () => {
  let calls: Command<unknown>[]
  let mcp: Client
  let answer: Handler

  beforeEach(async () => {
    answer = () => ({ data: [] })
    const mock = mockClient((c) => answer(c))
    calls = mock.calls
    mcp = (await connect(mock.client)).mcp
  })

  afterEach(async () => {
    await mcp.close()
  })

  it('whoami reads /auth/me and keeps only identity fields', async () => {
    answer = () => ({
      data: {
        id: 'u1',
        email: 'a@b.c',
        is_admin: false,
        static_token: 'secret',
        role_name: 'Editor'
      }
    })
    const res = await mcp.callTool({ name: 'whoami', arguments: {} })
    expect(calls[0]).toMatchObject({ _method: 'GET', _path: '/auth/me' })
    const body = textOf(res)
    expect(body).toEqual({ id: 'u1', email: 'a@b.c', is_admin: false, role_name: 'Editor' })
    expect(JSON.stringify(body)).not.toContain('secret')
  })

  it('list_collections answers one short entry per business collection', async () => {
    answer = () => ({
      data: [
        { ...COLLECTION, singular: 'Article', description: 'd'.repeat(300), sort: 1, icon: 'x' },
        { collection: 'settings', display_name: 'Settings', singleton: 1 },
        { collection: 'archive', display_name: 'Archive', hidden: 1 },
        { collection: 'nivaro_users', hidden: 1 }
      ]
    })
    const res = await mcp.callTool({ name: 'list_collections', arguments: {} })
    expect(calls[0]).toMatchObject({ _method: 'GET', _path: '/collections' })
    const body = textOf(res)
    expect(body).toEqual({
      collections: [
        {
          name: 'articles',
          label: 'Articles',
          singular: 'Article',
          description: `${'d'.repeat(100)}…`
        },
        { name: 'settings', label: 'Settings', singleton: true }
      ],
      total: 2,
      offset: 0,
      truncated: false
    })
    const hidden = textOf(
      await mcp.callTool({ name: 'list_collections', arguments: { include_hidden: true } })
    )
    expect(hidden.collections.map((c: { name: string }) => c.name)).toEqual([
      'articles',
      'settings',
      'archive',
      'nivaro_users'
    ])
  })

  it('list_collections searches, pages and stays small on a big registry', async () => {
    answer = () => ({
      data: Array.from({ length: 400 }, (_, i) => ({
        collection: `table_${i}`,
        display_name: `Table ${i}`,
        description: 'A long description of what this table holds. '.repeat(5),
        singleton: false,
        hidden: false,
        fields: Array.from({ length: 30 }, (_, f) => ({ field: `f${f}` }))
      }))
    })
    const res = await mcp.callTool({ name: 'list_collections', arguments: {} })
    const text = (res.content as Array<{ text: string }>)[0].text
    const body = JSON.parse(text)
    expect(body.collections).toHaveLength(50)
    expect(body).toMatchObject({ total: 400, truncated: true })
    expect(body.note).toMatch(/search/)
    expect(text.length).toBeLessThan(10_000)
    const found = textOf(
      await mcp.callTool({ name: 'list_collections', arguments: { search: 'TABLE 39' } })
    )
    expect(found.collections.map((c: { name: string }) => c.name)).toEqual([
      'table_39',
      'table_390',
      'table_391',
      'table_392',
      'table_393',
      'table_394',
      'table_395',
      'table_396',
      'table_397',
      'table_398',
      'table_399'
    ])
  })

  it('describe_collection returns fields with choices and relations', async () => {
    answer = () => ({ data: COLLECTION })
    const res = await mcp.callTool({
      name: 'describe_collection',
      arguments: { collection: 'articles' }
    })
    expect(calls[0]).toMatchObject({ _method: 'GET', _path: '/collections/articles' })
    const schema = textOf(res)
    expect(schema.fields.find((f: { field: string }) => f.field === 'status')).toEqual({
      field: 'status',
      type: 'string',
      interface: 'select-dropdown',
      required: true,
      choices: [
        { value: 'draft', text: 'Draft' },
        { value: 'live', text: 'Live' }
      ]
    })
    expect(schema.fields.find((f: { field: string }) => f.field === 'total').computed).toBe(true)
    expect(schema.relations).toEqual([
      { field: 'author', kind: 'm2o', related_collection: 'authors', junction: null },
      { field: 'tags', kind: 'm2m', related_collection: 'articles_tags', junction: 'articles_tags' }
    ])
  })

  it('read_items builds the list command, caps the limit and accepts JSON strings', async () => {
    answer = () => ({ data: [{ id: 1 }], total: 1, limit: 200, offset: 0 })
    await mcp.callTool({
      name: 'read_items',
      arguments: {
        collection: 'articles',
        filter: '{"status":{"_eq":"live"}}',
        sort: '-created_at,title',
        fields: ['id', 'title'],
        limit: 5000,
        offset: 10,
        search: 'hello'
      }
    })
    expect(calls[0]).toMatchObject({
      _method: 'GET',
      _path: '/items/articles',
      _params: {
        filter: '{"status":{"_eq":"live"}}',
        sort: '-created_at,title',
        fields: 'id,title',
        limit: 200,
        offset: 10,
        search: 'hello'
      }
    })
  })

  it('read_items defaults the limit and refuses a non-object filter', async () => {
    await mcp.callTool({ name: 'read_items', arguments: { collection: 'articles' } })
    expect(calls[0]._params).toMatchObject({ limit: 25 })
    const res = await mcp.callTool({
      name: 'read_items',
      arguments: { collection: 'articles', filter: '[1,2]' }
    })
    expect(res.isError).toBe(true)
    expect(textOf(res).error).toMatch(/JSON object/)
    expect(calls).toHaveLength(1)
  })

  it('read_item projects fields onto the single-record read', async () => {
    answer = () => ({ data: { id: 7, title: 'x' } })
    const res = await mcp.callTool({
      name: 'read_item',
      arguments: { collection: 'articles', id: 7, fields: 'id,title,author.email' }
    })
    expect(calls[0]).toMatchObject({
      _method: 'GET',
      _path: '/items/articles/7',
      _params: { fields: 'id,title,author.email' }
    })
    expect(textOf(res)).toEqual({ id: 7, title: 'x' })
  })

  it('aggregate_items joins the lists and counts rows when nothing else is asked', async () => {
    answer = () => ({ data: [], total: 0, limit: 100, offset: 0 })
    await mcp.callTool({
      name: 'aggregate_items',
      arguments: {
        collection: 'orders',
        groupBy: ['status'],
        sum: 'amount',
        filter: { paid: { _eq: true } }
      }
    })
    expect(calls[0]).toMatchObject({
      _method: 'GET',
      _path: '/items/orders/aggregate',
      _params: { groupBy: 'status', sum: 'amount', filter: '{"paid":{"_eq":true}}' }
    })
    expect(calls[0]._params).not.toHaveProperty('countAll')
    await mcp.callTool({ name: 'aggregate_items', arguments: { collection: 'orders' } })
    expect(calls[1]._params).toMatchObject({ countAll: 1 })
  })

  it('create_item rehearses by default and only stores with dry_run: false', async () => {
    answer = (c) =>
      c._params?.dry_run
        ? { dry_run: true, ok: true, status: 201, would: 'create', data: { title: 'a' } }
        : { data: { id: 9, title: 'a' } }
    const rehearsed = await mcp.callTool({
      name: 'create_item',
      arguments: { collection: 'articles', data: { title: 'a' } }
    })
    expect(calls[0]).toMatchObject({
      _method: 'POST',
      _path: '/items/articles',
      _params: { dry_run: 1 },
      _body: { title: 'a' }
    })
    expect(textOf(rehearsed)).toMatchObject({ dry_run: true, would: 'create' })

    const stored = await mcp.callTool({
      name: 'create_item',
      arguments: { collection: 'articles', data: '{"title":"a"}', dry_run: false }
    })
    expect(calls[1]).toMatchObject({
      _method: 'POST',
      _path: '/items/articles',
      _body: { title: 'a' }
    })
    expect(calls[1]._params).toBeUndefined()
    expect(textOf(stored)).toEqual({ dry_run: false, data: { id: 9, title: 'a' } })
  })

  it('update_item patches, carries the change reason, and surfaces a 422 cleanly', async () => {
    answer = (c) => {
      const body = c._body as Record<string, unknown>
      if (!body._change_reason) {
        throw apiError(422, {
          error: 'A reason is required when changing: amount',
          code: 'CHANGE_REASON_REQUIRED',
          violations: { fields_changed: ['amount'] },
          stack: 'never'
        })
      }
      return { data: { id: 3, amount: 5 } }
    }
    const refused = await mcp.callTool({
      name: 'update_item',
      arguments: { collection: 'forecasts', id: 3, data: { amount: 5 } }
    })
    expect(refused.isError).toBe(true)
    expect(textOf(refused)).toEqual({
      error: 'A reason is required when changing: amount',
      status: 422,
      code: 'CHANGE_REASON_REQUIRED',
      details: { violations: { fields_changed: ['amount'] } }
    })
    const ok = await mcp.callTool({
      name: 'update_item',
      arguments: {
        collection: 'forecasts',
        id: 3,
        data: { amount: 5 },
        change_reason: 'reforecast'
      }
    })
    expect(calls[1]).toMatchObject({
      _method: 'PATCH',
      _path: '/items/forecasts/3',
      _body: { amount: 5, _change_reason: 'reforecast' }
    })
    expect(textOf(ok)).toEqual({ id: 3, amount: 5 })
  })

  it('update_item refuses an empty patch without calling the API', async () => {
    const res = await mcp.callTool({
      name: 'update_item',
      arguments: { collection: 'articles', id: 1, data: {} }
    })
    expect(res.isError).toBe(true)
    expect(textOf(res).code).toBe('EMPTY_PATCH')
    expect(calls).toHaveLength(0)
  })

  it('delete_item needs confirm: true', async () => {
    answer = () => undefined
    const refused = await mcp.callTool({
      name: 'delete_item',
      arguments: { collection: 'articles', id: 4 }
    })
    expect(refused.isError).toBe(true)
    expect(textOf(refused).code).toBe('CONFIRM_REQUIRED')
    expect(calls).toHaveLength(0)
    const done = await mcp.callTool({
      name: 'delete_item',
      arguments: { collection: 'articles', id: 4, confirm: true }
    })
    expect(calls[0]).toMatchObject({ _method: 'DELETE', _path: '/items/articles/4' })
    expect(textOf(done)).toEqual({ deleted: true, collection: 'articles', id: 4 })
  })

  it('list_pipeline_state folds the instance, owners and history', async () => {
    answer = (c) =>
      c._path.endsWith('/owners/all')
        ? {
            data: {
              'st-review': {
                state: {},
                owners: [{ id: 'u2', email: 'bob@x.y', first_name: 'Bob', last_name: null }]
              }
            }
          }
        : { data: INSTANCE }
    const res = await mcp.callTool({
      name: 'list_pipeline_state',
      arguments: { collection: 'articles', id: 7 }
    })
    expect(calls.map((c) => c._path).sort()).toEqual([
      '/pipelines/instance/articles/7',
      '/pipelines/instance/articles/7/owners/all'
    ])
    const view = textOf(res)
    expect(view.current_state).toEqual({
      id: 'st-review',
      key: 'review',
      label: 'In review',
      is_terminal: false
    })
    expect(view.available_transitions).toEqual([
      {
        id: 'tx-approve',
        label: 'Approve',
        to_state: { id: 'st-done', key: 'done', label: 'Done' }
      }
    ])
    expect(view.owners).toEqual([{ id: 'u2', name: 'Bob', email: 'bob@x.y' }])
    expect(view.history[0]).toMatchObject({ by: 'Ada Lovelace', to: 'In review', comment: 'ready' })
  })

  it('list_pipeline_state reports an unbound collection honestly', async () => {
    answer = (c) => (c._path.endsWith('/owners/all') ? { data: null } : { data: null })
    const res = await mcp.callTool({
      name: 'list_pipeline_state',
      arguments: { collection: 'tags', id: 1 }
    })
    expect(textOf(res)).toMatchObject({ bound: false, started: false, owners: null })
  })

  it('transition posts the transition id and comment', async () => {
    answer = () => ({ data: { id: 'inst-1', current_state: 'st-done' } })
    await mcp.callTool({
      name: 'transition',
      arguments: { collection: 'articles', id: 7, transition_id: 'tx-approve', comment: 'LGTM' }
    })
    expect(calls[0]).toMatchObject({
      _method: 'POST',
      _path: '/pipelines/instance/articles/7/transition',
      _body: { transition_id: 'tx-approve', comment: 'LGTM' }
    })
  })

  it('ask_data sends the conversation to the chat endpoint', async () => {
    answer = () => ({ data: { reply: '42', trace: [] } })
    const res = await mcp.callTool({
      name: 'ask_data',
      arguments: {
        question: 'how many?',
        history: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' }
        ]
      }
    })
    expect(calls[0]).toMatchObject({
      _method: 'POST',
      _path: '/ai/chat',
      _body: {
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
          { role: 'user', content: 'how many?' }
        ]
      }
    })
    expect(textOf(res)).toEqual({ reply: '42', trace: [] })
  })

  it('errors carry the API status and code, never a stack', async () => {
    answer = () => {
      throw apiError(403, {
        error: 'Forbidden',
        code: 'API_KEY_SCOPE_MISSING',
        scope: { action: 'read' }
      })
    }
    const res = await mcp.callTool({ name: 'read_items', arguments: { collection: 'secrets' } })
    expect(res.isError).toBe(true)
    const body = textOf(res)
    expect(body).toEqual({
      error: 'Forbidden',
      status: 403,
      code: 'API_KEY_SCOPE_MISSING',
      details: { scope: { action: 'read' } }
    })
    expect(JSON.stringify(res)).not.toMatch(/at .*\.ts:\d+/)
  })

  it('resources read the collection list and one schema', async () => {
    answer = (c) => (c._path === '/collections' ? { data: [COLLECTION] } : { data: COLLECTION })
    const list = await mcp.readResource({ uri: 'nivaro://collections' })
    expect(JSON.parse(list.contents[0].text as string)).toHaveLength(1)
    const one = await mcp.readResource({ uri: 'nivaro://collection/articles' })
    expect(JSON.parse(one.contents[0].text as string).collection).toBe('articles')
    expect(calls[1]).toMatchObject({ _path: '/collections/articles' })
  })
})
