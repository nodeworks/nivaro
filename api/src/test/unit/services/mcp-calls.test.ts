import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import {
  CONN_RE,
  classifyToolAnswer,
  clientSlug,
  connectionLimit,
  MCP_SETTINGS_DEFAULTS,
  mcpCallerLabel,
  mcpClientNameOf,
  mcpConnOf,
  mcpLogColumns,
  mcpStampOf,
  mergeMcpSettings,
  rpcCallOf,
  rpcToolCallsOf,
  toolAnswerMessage,
  watchResponse
} from '../../../services/mcp-calls.js'
import { callerKeyFor } from '../../../services/traffic-entities.js'

const GRANT = '0b6a6f0e-3f6c-4d8e-9b1a-2c3d4e5f6a7b'
const USER = 'A1B2C3D4-0000-4000-8000-000000000001'

const answer = (result: unknown) => JSON.stringify({ jsonrpc: '2.0', id: 1, result })
const failure = (f: unknown) =>
  answer({ isError: true, content: [{ type: 'text', text: JSON.stringify(f) }] })

describe('connection keys', () => {
  it('names the OAuth grant, the API key, else the person', () => {
    expect(mcpConnOf({ authMethod: 'oauth', oauthGrantId: GRANT, user: { id: USER } })).toBe(
      `o${GRANT}`
    )
    expect(mcpConnOf({ authMethod: 'api_key', apiKeyId: 12, user: { id: USER } })).toBe('k12')
    expect(mcpConnOf({ authMethod: 'token', user: { id: USER } })).toBe(`u${USER.toLowerCase()}`)
    expect(mcpConnOf({})).toBeNull()
  })
  it('validates keys', () => {
    expect(CONN_RE.test(`o${GRANT}`)).toBe(true)
    expect(CONN_RE.test('k12')).toBe(true)
    expect(CONN_RE.test(`u${USER.toLowerCase()}`)).toBe(true)
    expect(CONN_RE.test('x1')).toBe(false)
    expect(CONN_RE.test(`o${GRANT}; DROP`)).toBe(false)
  })
})

describe('client names', () => {
  it('slugs a display name and labels the caller', () => {
    expect(clientSlug('Claude Code')).toBe('Claude_Code')
    expect(clientSlug('ChatGPT (work)')).toBe('ChatGPT_work')
    expect(clientSlug('  ')).toBe('Assistant')
    expect(clientSlug('x'.repeat(80))).toHaveLength(48)
    expect(mcpCallerLabel('m:Claude_Code')).toBe('MCP: Claude Code')
  })
  it('prefers the app registration, then the key, then the person', () => {
    expect(mcpClientNameOf({ oauthClientName: 'Claude', apiKeyName: 'k' })).toBe('Claude')
    expect(mcpClientNameOf({ apiKeyName: 'Laptop codex' })).toBe('Laptop codex')
    expect(mcpClientNameOf({ user: { first_name: 'Pat', last_name: 'Lee' } })).toBe('Pat Lee token')
  })
  it('makes an MCP call its own Traffic Map caller', () => {
    expect(callerKeyFor({ authMethod: 'oauth', userId: USER, mcpClient: 'Claude' })).toBe(
      'm:Claude'
    )
    expect(callerKeyFor({ authMethod: 'api_key', apiKeyId: 3, mcpClient: null })).toBe('k3')
    // A slug the log could not have written is ignored.
    expect(callerKeyFor({ userId: USER, mcpClient: 'bad slug!' })).toBe(`u${USER}`)
  })
})

describe('stamps', () => {
  const req = (over: Record<string, unknown>) =>
    ({
      headers: {},
      authMethod: 'oauth',
      oauthGrantId: GRANT,
      user: { id: USER },
      ...over
    }) as never
  it('stamps inner calls with the tool header only when the marker proved them', () => {
    expect(
      mcpStampOf(
        req({ mcpInner: true, headers: { 'x-nivaro-mcp-tool': 'read_item' } }),
        '/api/items/a/1'
      )
    ).toEqual({ conn: `o${GRANT}`, client: 'Assistant', tool: 'read_item' })
    expect(
      mcpStampOf(req({ headers: { 'x-nivaro-mcp-tool': 'read_item' } }), '/api/items/a/1')
    ).toBeNull()
  })
  it('stamps the endpoint row itself, and leaves the tool off a bad header', () => {
    expect(mcpStampOf(req({ oauthClientName: 'Claude' }), '/api/mcp')).toEqual({
      conn: `o${GRANT}`,
      client: 'Claude',
      tool: null
    })
    expect(
      mcpStampOf(req({ mcpInner: true, headers: { 'x-nivaro-mcp-tool': 'DROP TABLE' } }), '/x')
        ?.tool
    ).toBeNull()
  })
  it('turns a stamp into log columns', () => {
    expect(mcpLogColumns(null)).toEqual({})
    expect(mcpLogColumns({ conn: 'k1', client: 'C', tool: 't', outcome: 'ok', bytes: 9 })).toEqual({
      mcp_conn: 'k1',
      mcp_client: 'C',
      mcp_tool: 't',
      mcp_outcome: 'ok',
      mcp_bytes: 9
    })
  })
})

describe('JSON-RPC', () => {
  it('reads the tool a tools/call names', () => {
    expect(
      rpcCallOf({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'whoami' } })
    ).toEqual({ method: 'tools/call', tool: 'whoami', id: 4 })
    expect(rpcCallOf({ method: 'tools/list', id: 'a' })).toEqual({
      method: 'tools/list',
      tool: null,
      id: 'a'
    })
    expect(rpcCallOf([{ method: 'tools/call', params: { name: 'x' }, id: 1 }]).tool).toBe('x')
    expect(rpcCallOf(null).method).toBeNull()
  })

  it('counts every tools/call of a batch, odd names included, for the rate limit', () => {
    const call = (name: unknown, id: number) => ({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name }
    })
    expect(
      rpcToolCallsOf([
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        call('read_items', 2),
        call('DROP TABLE', 3),
        call(42, 4)
      ])
    ).toEqual({ calls: 3, tool: 'read_items', id: 2 })
    expect(rpcToolCallsOf(call('', 9))).toEqual({ calls: 1, tool: null, id: 9 })
    expect(rpcToolCallsOf(JSON.stringify([call('a', 1), call('b', 2)])).calls).toBe(2)
    expect(rpcToolCallsOf('not json').calls).toBe(0)
    expect(rpcToolCallsOf({ jsonrpc: '2.0', id: 5, method: 'tools/list' })).toEqual({
      calls: 0,
      tool: null,
      id: 5
    })
  })

  it('classifies an answer as ok, refused or error', () => {
    expect(classifyToolAnswer(answer({ content: [] }))).toBe('ok')
    expect(classifyToolAnswer(failure({ error: 'Forbidden', status: 403 }))).toBe('refused')
    expect(classifyToolAnswer(failure({ error: 'Pass confirm', code: 'CONFIRM_REQUIRED' }))).toBe(
      'refused'
    )
    expect(classifyToolAnswer(failure({ error: 'boom', status: 500 }))).toBe('error')
    expect(classifyToolAnswer(failure({ error: 'down', code: 'NETWORK_ERROR' }))).toBe('error')
    expect(
      classifyToolAnswer(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32602 } }))
    ).toBe('refused')
    expect(
      classifyToolAnswer(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32603 } }))
    ).toBe('error')
    // Too long to parse whole: judged by the tail.
    expect(classifyToolAnswer('', '..."isError":true}}')).toBe('error')
    expect(classifyToolAnswer('', '...}]}}')).toBe('ok')
  })

  it('keeps what a failed call said', () => {
    expect(toolAnswerMessage(failure({ error: 'Forbidden', status: 403, code: 'NO' }))).toBe(
      'Forbidden (403, NO)'
    )
    expect(toolAnswerMessage(answer({ content: [] }))).toBeNull()
  })
})

describe('watchResponse', () => {
  it('counts bytes and hands over the answer once, before the response ends', () => {
    const raw = new EventEmitter() as unknown as ServerResponse & { out: string[] }
    raw.out = []
    raw.write = ((c: string) => {
      raw.out.push(String(c))
      return true
    }) as never
    raw.end = ((c?: string) => {
      if (c) raw.out.push(String(c))
      return raw
    }) as never
    const seen: Array<[string, number]> = []
    watchResponse(raw, (head, _tail, bytes) => seen.push([head, bytes]))
    raw.write('{"a":')
    raw.end('1}')
    raw.end()
    expect(seen).toEqual([['{"a":1}', 7]])
    expect(raw.out.join('')).toBe('{"a":1}')
  })
})

describe('settings', () => {
  it('merges a valid patch and refuses a bad one in words', () => {
    const s = mergeMcpSettings(MCP_SETTINGS_DEFAULTS, {
      idle_flag_days: 30,
      rate_limit_per_minute: 60,
      connection_limits: { k4: 10 }
    })
    expect(s.idle_flag_days).toBe(30)
    expect(connectionLimit(s, 'k4')).toBe(10)
    expect(connectionLimit(s, 'k5')).toBe(60)
    expect(mergeMcpSettings(s, { connection_limits: { k4: null } }).connection_limits).toEqual({})
    expect(() => mergeMcpSettings(s, { idle_revoke_days: 32 })).toThrow(/at least 7 days later/)
    expect(() => mergeMcpSettings(s, { rate_limit_per_minute: -1 })).toThrow(/0 to 10,000/)
    expect(() => mergeMcpSettings(s, { connection_limits: { nope: 1 } })).toThrow(
      /not a connection/
    )
  })
})
