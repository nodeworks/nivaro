import { afterEach, describe, expect, it } from 'vitest'
import { config } from '../../../config.js'
import { requestIssuer } from '../../../services/request-origin.js'

// requestIssuer: the MCP host answers MCP_PUBLIC_URL first, so a same-host scheme tie
// (PUBLIC_URL http://h, MCP_PUBLIC_URL https://h) is https.

const saved = { pub: config.PUBLIC_URL, admin: config.ADMIN_URL, mcp: process.env.MCP_PUBLIC_URL }
afterEach(() => {
  config.PUBLIC_URL = saved.pub
  config.ADMIN_URL = saved.admin
  if (saved.mcp === undefined) delete process.env.MCP_PUBLIC_URL
  else process.env.MCP_PUBLIC_URL = saved.mcp
})

const req = (host: string) => ({ host }) as never

describe('requestIssuer', () => {
  it('a host that is both PUBLIC_URL (http) and MCP_PUBLIC_URL (https) answers https', () => {
    config.PUBLIC_URL = 'http://h.example'
    process.env.MCP_PUBLIC_URL = 'https://h.example'
    expect(requestIssuer(req('h.example'))).toBe('https://h.example')
  })

  it('another configured host answers its own origin; an unknown host MCP_PUBLIC_URL’s', () => {
    config.ADMIN_URL = 'https://admin.example'
    process.env.MCP_PUBLIC_URL = 'https://h.example'
    expect(requestIssuer(req('admin.example'))).toBe('https://admin.example')
    expect(requestIssuer(req('internal:3055'))).toBe('https://h.example')
  })
})
