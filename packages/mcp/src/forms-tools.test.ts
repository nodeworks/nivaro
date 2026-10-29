import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { Command } from '@nivaro/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apiError, connect, type Handler, mockClient, textOf } from './test-utils.js'

let calls: Command<unknown>[]
let mcp: Client
let answer: Handler

const call = (name: string, args: Record<string, unknown> = {}) =>
  mcp.callTool({ name, arguments: args })

const STATE = {
  collection: 'orders',
  record: '7',
  as: { role: 'Finance', admin: false, preview: true },
  layout: { id: 5, name: 'Default', why: 'it is the default form' },
  can_update: true,
  derived: { region: 'East' },
  groups: [
    {
      key: 'money',
      label: 'Money',
      type: 'section',
      parent_key: null,
      visible: true,
      locked: true
    },
    {
      key: 'ops',
      label: 'Ops',
      type: 'section',
      parent_key: null,
      visible: false,
      locked: false,
      why: '“Ops” is hidden for this role'
    }
  ],
  fields: [
    {
      field: 'amount',
      label: 'Amount',
      group_key: 'money',
      section: 'Money',
      visible: true,
      required: true,
      locked: false,
      missing: true
    },
    {
      field: 'zone',
      label: 'Zone',
      group_key: 'money',
      section: 'Money',
      visible: true,
      required: false,
      locked: true,
      locked_by: 'section_role',
      why: '“Money” is read-only for this role'
    },
    {
      field: 'notes',
      label: 'Notes',
      group_key: 'ops',
      section: 'Ops',
      visible: false,
      required: false,
      locked: false,
      hidden_by: 'section_role',
      why: '“Ops” is hidden for this role'
    }
  ],
  summary: { visible: 2, hidden: 1, required: ['amount'], locked: ['zone'], missing: ['amount'] }
}

describe('form tools (#3216 #3218)', () => {
  beforeEach(async () => {
    answer = () => ({ data: STATE })
    const mock = mockClient((c) => answer(c))
    calls = mock.calls
    mcp = (await connect(mock.client)).mcp
  })
  afterEach(async () => {
    await mcp.close()
  })

  it('form_state posts the record, values and role and answers compactly', async () => {
    const body = textOf(
      await call('form_state', {
        collection: 'orders',
        item: 7,
        values: '{"amount": null}',
        role: 'Finance'
      })
    )
    expect(calls[0]).toMatchObject({
      _method: 'POST',
      _path: '/collection-layouts/form-state',
      _body: { collection: 'orders', item: '7', values: { amount: null }, role: 'Finance' }
    })
    expect(body.form).toEqual(STATE.layout)
    expect(body.visible).toEqual([
      { field: 'amount', label: 'Amount', section: 'Money', required: true, missing: true },
      {
        field: 'zone',
        label: 'Zone',
        section: 'Money',
        locked: true,
        why: '“Money” is read-only for this role'
      }
    ])
    expect(body.hidden).toEqual([
      { field: 'notes (Notes)', by: 'section_role', why: '“Ops” is hidden for this role' }
    ])
    expect(body.hidden_sections).toEqual([{ section: 'Ops', why: '“Ops” is hidden for this role' }])
    expect(body.read_only_sections).toEqual(['Money'])
    expect(body.rules_would_fill).toEqual({ region: 'East' })
  })

  it('form_state refuses values that are not a JSON object, without a call', async () => {
    const res = await call('form_state', { collection: 'orders', values: '[1,2]' })
    expect(res.isError).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('a refused form_state passes the API message through', async () => {
    answer = () => {
      throw apiError(403, { error: 'Only administrators can look at a form as another role' })
    }
    const res = await call('form_state', { collection: 'orders', role: 'Finance' })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatchObject({ status: 403 })
  })

  it('render_form answers an MCP image and a summary', async () => {
    answer = () => ({
      data: {
        mime: 'image/png',
        base64: 'iVBORw0KGgo=',
        bytes: 8,
        width: 1100,
        collection: 'orders',
        record: '7',
        as: STATE.as,
        layout: STATE.layout,
        can_update: true,
        summary: STATE.summary
      }
    })
    const res = await call('render_form', {
      collection: 'orders',
      item: '7',
      theme: 'dark',
      viewport: 'phone',
      show_hidden: true
    })
    expect(calls[0]).toMatchObject({
      _method: 'POST',
      _path: '/collection-layouts/render-form',
      _body: {
        collection: 'orders',
        item: '7',
        theme: 'dark',
        viewport: 'phone',
        show_hidden: true
      }
    })
    const content = res.content as Array<{ type: string; data?: string; mimeType?: string }>
    expect(content[0]).toEqual({ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' })
    const summary = JSON.parse((content[1] as { text: string }).text)
    expect(summary).toMatchObject({ collection: 'orders', form: STATE.layout, width: 1100 })
  })

  it('render_form without an image is an error, not an empty picture', async () => {
    answer = () => ({ data: { mime: 'image/png', base64: '' } })
    const res = await call('render_form', { collection: 'orders' })
    expect(res.isError).toBe(true)
  })

  it('form tools are read-only', async () => {
    const { tools } = await mcp.listTools()
    for (const name of ['form_state', 'render_form', 'drill_widget']) {
      const t = tools.find((x) => x.name === name)
      expect(t?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false })
    }
  })
})

describe('drill_widget (#3208)', () => {
  beforeEach(async () => {
    answer = () => ({
      data: {
        definition: { source: 'dashboard', type: 'count', collection: 'orders', filters: [] },
        collection: 'orders',
        total: 120,
        capped: true,
        columns: ['id', 'title'],
        rows: [{ id: 1, title: 'x'.repeat(400) }],
        filter: { _and: [{ status: { _eq: 'open' } }] },
        dashboard: { id: 'd1', name: 'Ops' }
      }
    })
    const mock = mockClient((c) => answer(c))
    calls = mock.calls
    mcp = (await connect(mock.client)).mcp
  })
  afterEach(async () => {
    await mcp.close()
  })

  it('a dashboard widget posts to the dashboard rows route with the filter bar', async () => {
    const body = textOf(
      await call('drill_widget', {
        widget_id: 'w1',
        segment: { field: 'status', value: 'open' },
        filters: [{ field: 'region', value: 'East' }],
        fields: 'id,title',
        limit: 500
      })
    )
    expect(calls[0]).toMatchObject({
      _method: 'POST',
      _path: '/dashboards/widgets/w1/rows',
      _body: {
        segment: { field: 'status', value: 'open' },
        extra_filters: [{ field: 'region', value: 'East' }],
        fields: ['id', 'title'],
        limit: 100
      }
    })
    expect(body.total).toBe(120)
    expect(body.capped).toBe(true)
    expect(body.shown).toBe(1)
    expect(String(body.rows[0].title).length).toBeLessThan(250)
    expect(body.next).toMatch(/read_items on orders/)
  })

  it('a report widget posts to the report rows route with the date range', async () => {
    await call('drill_widget', {
      widget_id: 'w2',
      report_id: 'r1',
      date_range: { preset: 'last_3_months' },
      segment: { value: '2026-03' }
    })
    expect(calls[0]).toMatchObject({
      _method: 'POST',
      _path: '/report-studio/r1/widgets/w2/rows',
      _body: { date_range: { preset: 'last_3_months' }, segment: { value: '2026-03' }, limit: 25 }
    })
  })

  it('refuses a dashboard filter bar on a report widget and a half custom range', async () => {
    let res = await call('drill_widget', {
      widget_id: 'w2',
      report_id: 'r1',
      filters: [{ field: 'region', value: 'East' }]
    })
    expect(res.isError).toBe(true)
    res = await call('drill_widget', {
      widget_id: 'w2',
      report_id: 'r1',
      date_range: { preset: 'custom', start: '2026-01-01' }
    })
    expect(res.isError).toBe(true)
    expect(calls).toHaveLength(0)
  })

  it('a forbidden widget answers the API refusal', async () => {
    answer = () => {
      throw apiError(403, { error: 'Forbidden' })
    }
    const res = await call('drill_widget', { widget_id: 'w1' })
    expect(res.isError).toBe(true)
    expect(textOf(res)).toMatchObject({ status: 403, error: 'Forbidden' })
  })
})

describe('lint_layout (#3217)', () => {
  beforeEach(async () => {
    answer = () => ({
      data: {
        layout: { id: 5, name: 'Default', collection: 'orders' },
        score: 82,
        costs: [{ label: '1 error', points: 10 }],
        counts: { error: 1, warn: 1, info: 1 },
        findings: [
          {
            id: 'a',
            rule: 'required-hidden',
            severity: 'error',
            where: 'Amount in Money',
            target: { kind: 'field', field: 'amount', group_key: 'money' },
            message: 'Amount is required but hidden',
            fix: { label: 'Show it', ops: [{ op: 'update_placement' }] }
          },
          {
            id: 'b',
            rule: 'empty-section',
            severity: 'warn',
            where: 'Ops',
            target: { kind: 'group', key: 'ops' },
            message: 'Ops is empty'
          },
          {
            id: 'c',
            rule: 'a11y-tab-order',
            severity: 'info',
            where: 'the form',
            target: { kind: 'layout' },
            message: 'Tab order doubles back'
          }
        ]
      }
    })
    const mock = mockClient((c) => answer(c))
    calls = mock.calls
    mcp = (await connect(mock.client, { adminTools: true })).mcp
  })
  afterEach(async () => {
    await mcp.close()
  })

  it('reads the stored layout lint and filters by severity', async () => {
    const body = textOf(await call('lint_layout', { layout_id: 5, severity: 'warn' }))
    expect(calls[0]).toMatchObject({ _method: 'GET', _path: '/collection-layouts/5/lint' })
    expect(body.score).toBe(82)
    expect(body.findings.map((f: { rule: string }) => f.rule)).toEqual([
      'required-hidden',
      'empty-section'
    ])
    expect(body.findings[0].fix.ops).toEqual([{ op: 'update_placement' }])
    expect(body.next).toMatch(/propose_layout_ops/)
  })

  it('is registered only with the admin tools', async () => {
    const plain = mockClient(() => ({ data: {} }))
    const other = (await connect(plain.client)).mcp
    const { tools } = await other.listTools()
    expect(tools.some((t) => t.name === 'lint_layout')).toBe(false)
    await other.close()
  })
})
