import { describe, expect, it } from 'vitest'
import { BUILTIN_KITS } from '../../../services/mcp-kits.js'

const { kitFieldset, consentPage, hubKitConflict } = await import('../../../routes/oauth.js')

describe('consent page kit picker (#3214)', () => {
  it('offers everything plus every kit, everything chosen by default', () => {
    const html = kitFieldset({ kits: BUILTIN_KITS, current: null })
    expect(html).toContain('<legend>What it may use</legend>')
    expect(html).toContain('value="" checked')
    for (const k of BUILTIN_KITS) expect(html).toContain(`value="${k.key}"`)
    expect(html).not.toContain('__keep')
  })

  it('keeps an earlier custom limit unless the person picks again', () => {
    const html = kitFieldset({
      kits: BUILTIN_KITS,
      current: { kit: null, custom: true, locked: false }
    })
    expect(html).toContain('value="__keep" checked')
  })

  it('preselects the kit the app already has', () => {
    const html = kitFieldset({
      kits: BUILTIN_KITS,
      current: { kit: 'ops', custom: false, locked: false }
    })
    expect(html).toContain('value="ops" checked')
  })

  it('shows, and never offers, a locked limit', () => {
    const html = kitFieldset({
      kits: BUILTIN_KITS,
      current: { kit: 'ops', custom: false, locked: true }
    })
    expect(html).toContain('type="hidden" name="kit" value="__keep"')
    expect(html).not.toContain('type="radio"')
  })

  it('escapes kit text', () => {
    const html = kitFieldset({
      kits: [{ ...BUILTIN_KITS[0], key: 'x', label: '<b>x</b>', description: '"q"' }],
      current: null
    })
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(html).not.toContain('<b>x</b>')
  })

  it('is empty before the migration', () => {
    expect(kitFieldset(null)).toBe('')
  })
})

describe('consent page Hub choice (Hub mode only)', () => {
  const client = { client_id: 'c1', client_name: 'Claude', redirect_uris: ['https://claude.ai/cb'] }
  const params = {
    client_id: 'c1',
    redirect_uri: 'https://claude.ai/cb',
    response_type: 'code',
    code_challenge: 'x'.repeat(43),
    code_challenge_method: 'S256',
    scope: 'nivaro chat hub:read',
    state: 's'
  }
  const user = { id: 'u1', first_name: 'Ada', last_name: null, email: 'ada@x' }
  const render = (hub: string | undefined) => {
    const saved = process.env.HUB
    if (hub === undefined) delete process.env.HUB
    else process.env.HUB = hub
    try {
      return consentPage(client as never, params as never, user as never, 'csrf')
    } finally {
      if (saved === undefined) delete process.env.HUB
      else process.env.HUB = saved
    }
  }

  it('is not offered on a regular install', () => {
    expect(render(undefined)).not.toContain('name="hub"')
  })

  it('is offered unticked on a Hub, even when the app asked for hub:read', () => {
    const html = render('on')
    expect(html).toContain('<input type="checkbox" name="hub" value="1">')
    expect(html).not.toMatch(/name="hub" value="1" checked/)
  })

  it('refuses the Hub with a kit limited to named collections', () => {
    const kits = [
      { ...BUILTIN_KITS[0], key: 'narrow', label: 'Projects only', collections: ['projects'] },
      { ...BUILTIN_KITS[0], key: 'tools', label: 'Tools', collections: null }
    ]
    expect(hubKitConflict('narrow', kits)).toMatch(/Projects only/)
    expect(hubKitConflict('tools', kits)).toBeNull()
    expect(hubKitConflict('', kits)).toBeNull()
    expect(hubKitConflict('__keep', kits)).toBeNull()
  })
})
