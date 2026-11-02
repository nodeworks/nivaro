import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanDeviceName,
  devicePlatform,
  isMobileRedirect,
  mobileClient,
  mobileClients,
  mobileSignInEnabled
} from './mobile-clients.js'

const saved = {
  clients: process.env.MOBILE_APP_CLIENTS,
  signin: process.env.MOBILE_SIGNIN,
  mcp: process.env.MCP_OAUTH
}
const restore = (k: string, v: string | undefined) => {
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
}
afterEach(() => {
  restore('MOBILE_APP_CLIENTS', saved.clients)
  restore('MOBILE_SIGNIN', saved.signin)
  restore('MCP_OAUTH', saved.mcp)
})

describe('first-party mobile clients', () => {
  it('always knows the official Nivaro app', () => {
    delete process.env.MOBILE_APP_CLIENTS
    expect(mobileClient('nivaro-mobile')).toEqual({
      client_id: 'nivaro-mobile',
      client_name: 'Nivaro',
      redirect_uris: ['dev.nivaro.app:/oauth/callback']
    })
    expect(mobileClients().map((c) => c.client_id)).toEqual(['nivaro-mobile'])
    expect(mobileClient('nope')).toBeNull()
    expect(mobileClient('')).toBeNull()
  })

  it('adds apps from MOBILE_APP_CLIENTS and ignores malformed entries', () => {
    process.env.MOBILE_APP_CLIENTS = [
      'acme-mobile|Acme|acme:/oauth/callback',
      'two|Two|two:/cb, https://two.example/cb',
      'just-an-id',
      'empty-name||x:/cb',
      'no-uris|No URIs|',
      '|No id|x:/cb',
      'nvc_00000000-0000-0000-0000-000000000000|Dynamic lookalike|x:/cb',
      'nivaro-mobile|Not Nivaro|evil:/oauth/callback',
      'acme-mobile|Acme again|other:/cb',
      'scripty|Scripty|javascript:alert(1)',
      'fragment|Fragment|frag:/cb#x',
      'web|Web|http://evil.example/cb',
      'bad id|Spaces|x:/cb',
      ''
    ].join(';')
    expect(mobileClient('acme-mobile')?.client_name).toBe('Acme')
    expect(mobileClient('acme-mobile')?.redirect_uris).toEqual(['acme:/oauth/callback'])
    expect(mobileClient('two')?.redirect_uris).toEqual(['two:/cb', 'https://two.example/cb'])
    // The built-in app cannot be redefined from env.
    expect(mobileClient('nivaro-mobile')?.client_name).toBe('Nivaro')
    expect(mobileClients().map((c) => c.client_id)).toEqual(['nivaro-mobile', 'acme-mobile', 'two'])
  })

  it('matches redirect URIs exactly', () => {
    const nivaro = mobileClient('nivaro-mobile')!
    expect(isMobileRedirect(nivaro, 'dev.nivaro.app:/oauth/callback')).toBe(true)
    expect(isMobileRedirect(nivaro, 'dev.nivaro.app:/other')).toBe(false)
    expect(isMobileRedirect(nivaro, 'evil:/oauth/callback')).toBe(false)
    expect(isMobileRedirect(nivaro, 'dev.nivaro.app:/oauth/callback#x')).toBe(false)
    expect(isMobileRedirect(nivaro, 'dev.nivaro.app:/oauth/callback?x=1')).toBe(false)
    expect(isMobileRedirect(nivaro, 'DEV.NIVARO.APP:/oauth/callback')).toBe(false)
    expect(isMobileRedirect(nivaro, '')).toBe(false)
  })

  it('MOBILE_SIGNIN=off turns sign-in off, independent of MCP_OAUTH', () => {
    delete process.env.MOBILE_SIGNIN
    process.env.MCP_OAUTH = 'off'
    expect(mobileSignInEnabled()).toBe(true)
    process.env.MOBILE_SIGNIN = ' OFF '
    delete process.env.MCP_OAUTH
    expect(mobileSignInEnabled()).toBe(false)
    process.env.MOBILE_SIGNIN = 'on'
    expect(mobileSignInEnabled()).toBe(true)
  })

  it('cleans the device name and platform the app sends', () => {
    expect(cleanDeviceName("  Pat's iPhone\u0000 ")).toBe("Pat's iPhone")
    expect(cleanDeviceName('x'.repeat(100))).toHaveLength(60)
    expect(cleanDeviceName('   ')).toBeUndefined()
    expect(cleanDeviceName(42)).toBeUndefined()
    expect(devicePlatform('ios')).toBe('ios')
    expect(devicePlatform('android')).toBe('android')
    expect(devicePlatform('windows')).toBeUndefined()
    expect(devicePlatform(undefined)).toBeUndefined()
  })
})
