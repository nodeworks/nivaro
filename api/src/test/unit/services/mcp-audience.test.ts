import { describe, expect, it } from 'vitest'
import {
  MCP_INNER_HEADER,
  markMcpInnerRequest,
  mcpInnerHeaderValue,
  normalizedPath,
  oauthAudienceRefusal
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
