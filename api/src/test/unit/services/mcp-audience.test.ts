import { describe, expect, it } from 'vitest'
import {
  CHAT_KEY_SCOPE,
  keyChatAccess,
  MCP_INNER_HEADER,
  markMcpInnerRequest,
  mcpAppLabel,
  mcpChatAccess,
  mcpInnerHeaderValue,
  normalizedPath,
  oauthAudienceRefusal,
  oauthScopeRefusal
} from '../../../services/mcp-config.js'

type Req = Parameters<typeof oauthAudienceRefusal>[0]
const req = (method: string, url: string, inner = false) =>
  ({ method, url, mcpInner: inner }) as unknown as Req

describe('OAuth token audience', () => {
  it('works on /api/mcp and on its in-process tool calls only', () => {
    expect(oauthAudienceRefusal(req('POST', '/api/mcp'))).toBeNull()
    expect(oauthAudienceRefusal(req('GET', '/api/items/workflows', true))).toBeNull()
    expect(oauthAudienceRefusal(req('PATCH', '/api/items/workflows/5', true))).toBeNull()
    expect(oauthAudienceRefusal(req('GET', '/api/items/workflows'))).toMatch(/MCP endpoint/)
  })

  it('never writes to sign-in, credential, connection or system-table routes', () => {
    for (const [m, u] of [
      ['POST', '/api/api-keys'],
      ['POST', '/api/auth/masquerade'],
      ['POST', '/api/users/U1/token'],
      ['DELETE', '/api/oauth/connections/x'],
      ['PATCH', '/api/items/nivaro_users/U1'],
      ['POST', '/api/graphql']
    ])
      expect(oauthAudienceRefusal(req(m, u, true))).toMatch(/cannot use/)
    expect(oauthAudienceRefusal(req('GET', '/api/auth/me', true))).toBeNull()
  })

  it('judges encoded, mixed-case and doubled-slash spellings like the plain one', () => {
    for (const [m, u] of [
      ['PATCH', '/api/items/%6Eivaro_users/U1'],
      ['PATCH', '/api/items/%256Eivaro_users/U1'],
      ['PATCH', '/api/items/NIVARO_users/U1'],
      ['POST', '/api/Items/Directus_users'],
      ['POST', '//api//api-keys'],
      ['POST', '/api/API-KEYS'],
      ['POST', '/api/users/U1/%74oken'],
      ['DELETE', '/api/OAuth/connections/x']
    ])
      expect(oauthAudienceRefusal(req(m, u, true)), u).toMatch(/cannot use/)
    expect(normalizedPath('/api/%4Dcp?x=%2F')).toBe('/api/mcp')
    expect(oauthAudienceRefusal(req('POST', '/api/%6Dcp'))).toBeNull()
  })

  it('turns the inner marker into a flag and removes it from the headers', async () => {
    const good = { headers: { [MCP_INNER_HEADER]: mcpInnerHeaderValue() } } as unknown as Req & {
      headers: Record<string, string>
    }
    await markMcpInnerRequest(good)
    expect(good.mcpInner).toBe(true)
    expect(good.headers[MCP_INNER_HEADER]).toBeUndefined()

    const forged = { headers: { [MCP_INNER_HEADER]: 'guess' } } as unknown as Req & {
      headers: Record<string, string>
    }
    await markMcpInnerRequest(forged)
    expect(forged.mcpInner).toBeUndefined()
    expect(forged.headers[MCP_INNER_HEADER]).toBeUndefined()
  })
})

describe('chat consent (#2492)', () => {
  const r = (o: Record<string, unknown>) => o as unknown as Req

  it('a key gets chat only from an explicit $chat scope, never from *', () => {
    expect(keyChatAccess([{ collection: '*', actions: ['*'] }])).toBe('none')
    expect(keyChatAccess([{ collection: CHAT_KEY_SCOPE, actions: ['read'] }])).toBe('read')
    expect(keyChatAccess([{ collection: CHAT_KEY_SCOPE, actions: ['read', 'create'] }])).toBe(
      'post'
    )
    expect(keyChatAccess(undefined)).toBe('none')
  })

  it('an OAuth connection needs the chat scope; static tokens and sessions get none', () => {
    expect(mcpChatAccess(r({ authMethod: 'oauth', oauthScopes: ['nivaro', 'chat'] }))).toBe('post')
    expect(mcpChatAccess(r({ authMethod: 'oauth', oauthScopes: ['nivaro'] }))).toBe('none')
    expect(
      mcpChatAccess(
        r({ authMethod: 'api_key', apiKeyScopes: [{ collection: '$chat', actions: ['read'] }] })
      )
    ).toBe('read')
    expect(mcpChatAccess(r({ authMethod: 'token' }))).toBe('none')
    expect(mcpChatAccess(r({ authMethod: 'session' }))).toBe('none')
  })

  it('refuses every chat route to a connection without the chat scope', () => {
    for (const u of ['/api/chat/rooms', '/api/chat/messages?room=global', '/api/Chat/messages'])
      expect(oauthScopeRefusal(r({ url: u }), ['nivaro']), u).toMatch(/not allowed to use chat/)
    expect(oauthScopeRefusal(r({ url: '/api/chat/rooms' }), ['nivaro', 'chat'])).toBeNull()
    expect(oauthScopeRefusal(r({ url: '/api/chatter' }), ['nivaro'])).toBeNull()
    expect(oauthScopeRefusal(r({ url: '/api/items/workflows' }), ['nivaro'])).toBeNull()
  })

  it('labels only MCP traffic, with the app or key name', () => {
    const h = (app?: string) => (app ? { 'x-nivaro-app': app } : {})
    expect(
      mcpAppLabel(
        r({ headers: h(), mcpInner: true, authMethod: 'oauth', oauthClientName: 'ChatGPT' })
      )
    ).toBe('ChatGPT')
    expect(mcpAppLabel(r({ headers: h('mcp'), authMethod: 'api_key', apiKeyName: 'Laptop' }))).toBe(
      'Laptop'
    )
    expect(mcpAppLabel(r({ headers: h('mcp'), authMethod: 'token' }))).toBe('AI assistant')
    expect(mcpAppLabel(r({ headers: h('admin'), authMethod: 'api_key', apiKeyName: 'ERP' }))).toBe(
      null
    )
    expect(mcpAppLabel(r({ headers: h(), authMethod: 'session' }))).toBeNull()
  })
})
