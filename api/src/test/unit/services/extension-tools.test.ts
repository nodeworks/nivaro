import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { shareableTrace } from '../../../services/ai-conversations.js'
import {
  _resetExtensionTools,
  _setExtensionToolsEnabledCheck,
  describeExtensionTools,
  ExtensionToolError,
  extensionToolRoster,
  fieldListsOf,
  isReplayableExtensionTool,
  liveExtensionTools,
  missingRequired,
  normalizeToolArgs,
  registerExtensionTool,
  runExtensionTool,
  summarizeToolResult,
  unregisterExtensionTools
} from '../../../services/extension-tools.js'

const asker = { id: 'u-1', email: 'a@x.test' } as never
const schema = {
  type: 'object',
  properties: { collection: { type: 'string' }, fields: { type: 'array' } },
  required: ['collection']
}
const helpers = () => ({
  readItems: vi.fn(async () => ({ data: [] })),
  assertFieldsReadable: vi.fn(async () => {}),
  linkLabels: vi.fn(async () => ({}))
})

let enabled = new Set(['crm', 'erp'])
beforeEach(() => {
  _resetExtensionTools()
  enabled = new Set(['crm', 'erp'])
  _setExtensionToolsEnabledCheck(async (ext) => enabled.has(ext))
})
afterEach(() => _resetExtensionTools())

describe('normalizeToolArgs — one declaration, two spellings (#2465, #2735)', () => {
  it('accepts the positional form with options in the fourth argument', () => {
    const out = normalizeToolArgs([
      'open_deals',
      schema,
      () => 1,
      { description: 'Deals', read_only: true }
    ])
    expect('def' in out && out.def).toMatchObject({
      name: 'open_deals',
      title: 'open_deals',
      description: 'Deals',
      read_only: true
    })
  })

  it('accepts a definition object and fills an empty schema', () => {
    const out = normalizeToolArgs([{ name: 'ping_me', description: 'x', handler: () => 1 }])
    expect('def' in out && out.def.input_schema).toEqual({ type: 'object', properties: {} })
  })

  it('refuses bad names, missing handlers, non-object schemas and broken field lists', () => {
    expect(normalizeToolArgs(['Bad-Name', schema, () => 1])).toHaveProperty('error')
    expect(normalizeToolArgs(['ok_name', schema, 'nope'])).toHaveProperty('error')
    expect(normalizeToolArgs(['ok_name', { type: 'array' }, () => 1])).toHaveProperty('error')
    expect(
      normalizeToolArgs([
        { name: 'ok_name', description: 'x', handler: () => 1, field_lists: [{ fields_key: 'f' }] }
      ])
    ).toHaveProperty('error')
  })
})

describe('registerExtensionTool', () => {
  it('keeps two extensions off one name; a reload of the same one replaces it', () => {
    const def = { name: 'open_deals', description: 'Deals', handler: () => 1 }
    expect(registerExtensionTool('mcp', 'crm', [def]).ok).toBe(true)
    expect(registerExtensionTool('mcp', 'erp', [def])).toMatchObject({ ok: false })
    expect(registerExtensionTool('mcp', 'crm', [{ ...def, description: 'v2' }]).ok).toBe(true)
    // Channels are separate registries.
    expect(registerExtensionTool('ai', 'erp', [def]).ok).toBe(true)
    expect(describeExtensionTools('crm').mcp_tools).toEqual([
      { name: 'open_deals', description: 'v2', read_only: false }
    ])
  })

  it('requires a description (the assistant reads it)', () => {
    expect(registerExtensionTool('ai', 'crm', ['no_desc', schema, () => 1])).toMatchObject({
      ok: false
    })
  })

  it('replayable only when also read-only, and only on the Ask AI channel', () => {
    registerExtensionTool('ai', 'crm', [
      { name: 'a_read', description: 'r', read_only: true, replayable: true, handler: () => 1 }
    ])
    registerExtensionTool('ai', 'crm', [
      { name: 'a_write', description: 'w', replayable: true, handler: () => 1 }
    ])
    expect(isReplayableExtensionTool('a_read')).toBe(true)
    expect(isReplayableExtensionTool('a_write')).toBe(false)
    expect(isReplayableExtensionTool('nothing')).toBe(false)
  })

  it('unregister drops every tool of the extension', async () => {
    registerExtensionTool('mcp', 'crm', [{ name: 'one_tool', description: 'x', handler: () => 1 }])
    registerExtensionTool('ai', 'crm', [{ name: 'two_tool', description: 'x', handler: () => 1 }])
    unregisterExtensionTools('crm')
    expect(await liveExtensionTools('mcp')).toEqual([])
    expect(await liveExtensionTools('ai')).toEqual([])
  })
})

describe('runExtensionTool — as the caller, behind the kill switch', () => {
  it('passes the caller, the input and the helpers to the handler', async () => {
    const handler = vi.fn(async (_u: unknown, input: Record<string, unknown>) => ({
      rows: [input]
    }))
    registerExtensionTool('mcp', 'crm', ['open_deals', schema, handler, { description: 'd' }])
    const h = helpers()
    const out = await runExtensionTool('mcp', asker, 'open_deals', { collection: 'deals' }, h)
    expect(out).toEqual({ rows: [{ collection: 'deals' }] })
    expect(handler).toHaveBeenCalledWith(asker, { collection: 'deals' }, h)
  })

  it('a disabled extension is neither listed nor run', async () => {
    registerExtensionTool('mcp', 'crm', ['open_deals', schema, () => 1, { description: 'd' }])
    enabled.delete('crm')
    expect(await liveExtensionTools('mcp')).toEqual([])
    await expect(
      runExtensionTool('mcp', asker, 'open_deals', { collection: 'x' }, helpers())
    ).rejects.toMatchObject({ statusCode: 404 })
    expect((await extensionToolRoster('mcp'))[0]).toMatchObject({ enabled: false })
  })

  it('refuses missing required input before the handler runs', async () => {
    const handler = vi.fn()
    registerExtensionTool('mcp', 'crm', ['open_deals', schema, handler, { description: 'd' }])
    await expect(runExtensionTool('mcp', asker, 'open_deals', {}, helpers())).rejects.toThrow(
      'Missing input: collection'
    )
    expect(handler).not.toHaveBeenCalled()
  })

  it('checks declared field lists through the guard before the handler (#2735)', async () => {
    const handler = vi.fn(async () => 'ran')
    registerExtensionTool('ai', 'crm', [
      'sum_by',
      schema,
      handler,
      { description: 'd', field_lists: [{ fields_key: 'fields', collection_key: 'collection' }] }
    ])
    const h = helpers()
    h.assertFieldsReadable.mockRejectedValueOnce(
      new Error('You do not have access to the field "cost"')
    )
    await expect(
      runExtensionTool('ai', asker, 'sum_by', { collection: 'deals', fields: ['cost'] }, h)
    ).rejects.toThrow('cost')
    expect(handler).not.toHaveBeenCalled()
    expect(h.assertFieldsReadable).toHaveBeenCalledWith('deals', ['cost'])
    expect((await extensionToolRoster('ai'))[0].stats).toMatchObject({ calls: 1, errors: 1 })
  })
})

describe('pure helpers', () => {
  it('missingRequired treats null and empty as missing', () => {
    expect(missingRequired(schema, { collection: '' })).toEqual(['collection'])
    expect(missingRequired(schema, { collection: 'a' })).toEqual([])
  })

  it('fieldListsOf reads a single field or a list, literal or input collection', () => {
    expect(
      fieldListsOf(
        [
          { fields_key: 'group_by', collection: 'deals' },
          { fields_key: 'fields', collection_key: 'c' }
        ],
        { group_by: 'owner', fields: ['a', 'b.c'], c: 'vendors' }
      )
    ).toEqual([
      { collection: 'deals', fields: ['owner'] },
      { collection: 'vendors', fields: ['a', 'b.c'] }
    ])
    expect(() => fieldListsOf([{ fields_key: 'f', collection_key: 'c' }], { f: 'x' })).toThrow(
      ExtensionToolError
    )
  })

  it('summarizeToolResult counts rows', () => {
    expect(summarizeToolResult('t', { rows: [1, 2] })).toBe('t: 2 item(s)')
    expect(summarizeToolResult('t', [1])).toBe('t: 1 item(s)')
    expect(summarizeToolResult('t', null)).toBe('t: done')
  })
})

describe('sharing an Ask AI answer that used an extension tool (#1809 rule)', () => {
  const entry = (tool: string) => ({ tool, input: {}, summary: 'ok', result_hash: 'h' })

  it('is private unless the tool is read-only AND declared replayable', () => {
    registerExtensionTool('ai', 'crm', [
      { name: 'safe_read', description: 'r', read_only: true, replayable: true, handler: () => 1 }
    ])
    registerExtensionTool('ai', 'crm', [
      { name: 'plain_read', description: 'r', read_only: true, handler: () => 1 }
    ])
    expect(shareableTrace([entry('safe_read')] as never)).toBe(true)
    expect(shareableTrace([entry('plain_read')] as never)).toBe(false)
    expect(shareableTrace([entry('query_items'), entry('plain_read')] as never)).toBe(false)
  })
})

describe('withExtensionAiTools — what Ask AI is offered', () => {
  it('appends enabled extension tools, never one that shadows a built-in', async () => {
    const { withExtensionAiTools } = await import('../../../services/extension-tools.js')
    const base = [{ name: 'query_items', description: 'x', input_schema: {} }]
    expect(await withExtensionAiTools(base)).toBe(base)
    registerExtensionTool('ai', 'crm', [
      { name: 'deal_health', description: 'Deals', handler: () => 1 }
    ])
    registerExtensionTool('ai', 'crm', [
      { name: 'query_items', description: 'Shadow', handler: () => 1 }
    ])
    registerExtensionTool('ai', 'crm', [
      { name: 'set_reminder', description: 'Shadow', handler: () => 1 }
    ])
    const out = await withExtensionAiTools(base)
    expect(out.map((t) => t.name)).toEqual(['query_items', 'deal_health'])
    expect(out[1].description).toBe('Deals (from the crm extension)')
    enabled.delete('crm')
    expect((await withExtensionAiTools(base)).map((t) => t.name)).toEqual(['query_items'])
  })
})
