import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  cleanClientName,
  escapeHtml,
  hashToken,
  isAllowedRedirectUri,
  randomToken,
  redirectMatches,
  verifyPkceS256,
  withAuthResponse
} from '../../../lib/oauth.js'

const challengeOf = (v: string) => createHash('sha256').update(v).digest('base64url')

describe('PKCE S256', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
  it('accepts the matching verifier (RFC 7636 appendix B)', () => {
    expect(verifyPkceS256(verifier, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')).toBe(true)
  })
  it('refuses a wrong, short or malformed verifier', () => {
    expect(verifyPkceS256(`${verifier}x`, challengeOf(verifier))).toBe(false)
    expect(verifyPkceS256('short', challengeOf('short'))).toBe(false)
    const spaced = `${'a'.repeat(42)} b`
    expect(verifyPkceS256(spaced, challengeOf(spaced))).toBe(false)
  })
})

describe('redirect URIs', () => {
  it('allows https anywhere and http only on loopback', () => {
    expect(isAllowedRedirectUri('https://chatgpt.com/connector_platform_oauth_redirect')).toBe(true)
    expect(isAllowedRedirectUri('https://claude.ai/api/mcp/auth_callback')).toBe(true)
    expect(isAllowedRedirectUri('http://localhost:33418/callback')).toBe(true)
    expect(isAllowedRedirectUri('http://127.0.0.1:9000/cb')).toBe(true)
    expect(isAllowedRedirectUri('http://evil.example/cb')).toBe(false)
    expect(isAllowedRedirectUri('javascript:alert(1)')).toBe(false)
    expect(isAllowedRedirectUri('https://a.example/cb#frag')).toBe(false)
    expect(isAllowedRedirectUri('https://user:pw@a.example/cb')).toBe(false)
    expect(isAllowedRedirectUri('not a url')).toBe(false)
  })

  it('matches exactly, except a loopback port may change', () => {
    const reg = ['https://chatgpt.com/cb', 'http://127.0.0.1:5000/callback']
    expect(redirectMatches(reg, 'https://chatgpt.com/cb')).toBe(true)
    expect(redirectMatches(reg, 'https://chatgpt.com/cb2')).toBe(false)
    expect(redirectMatches(reg, 'https://chatgpt.com:8443/cb')).toBe(false)
    expect(redirectMatches(reg, 'http://127.0.0.1:61234/callback')).toBe(true)
    expect(redirectMatches(reg, 'http://127.0.0.1:61234/other')).toBe(false)
    expect(redirectMatches(reg, 'http://localhost:61234/callback')).toBe(false)
  })

  it('appends code, state and iss to the redirect', () => {
    const u = new URL(
      withAuthResponse('https://a.example/cb?x=1', { code: 'c', state: 's', iss: 'https://n' })
    )
    expect(u.searchParams.get('x')).toBe('1')
    expect(u.searchParams.get('code')).toBe('c')
    expect(u.searchParams.get('state')).toBe('s')
    expect(u.searchParams.get('iss')).toBe('https://n')
  })
})

describe('tokens and display', () => {
  it('makes distinct prefixed tokens and stable hashes', () => {
    const a = randomToken('nvo_')
    expect(a.startsWith('nvo_')).toBe(true)
    expect(a).not.toBe(randomToken('nvo_'))
    expect(hashToken(a)).toBe(hashToken(a))
    expect(hashToken(a)).not.toContain(a)
  })
  it('cleans client names and escapes html', () => {
    expect(cleanClientName('  ChatGPT\u0007 ')).toBe('ChatGPT')
    expect(cleanClientName(undefined)).toBe('An AI assistant')
    expect(cleanClientName('x'.repeat(200))).toHaveLength(80)
    expect(escapeHtml('<b a="1">&\'')).toBe('&lt;b a=&quot;1&quot;&gt;&amp;&#39;')
  })
})
