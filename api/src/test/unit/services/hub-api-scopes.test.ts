import { describe, expect, it } from 'vitest'
import { hubCredentialRefusal } from '../../../services/hub/api/gate.js'
import { hubScopeEntry, hubScopeLevel, hubScopeRefusal } from '../../../services/hub/api/scopes.js'
import { apiKeyWidening, describeKeyScopes } from '../../../services/security-alerts-text.js'

// hub:read / hub:write: the `$hub` scope entry on a named API key (Hub mode only).

const ALL = { collection: '*', actions: ['*'] }

describe('hub scope level', () => {
  it('`*` never implies the Hub; write implies read', () => {
    expect(hubScopeLevel([ALL])).toBe('none')
    expect(hubScopeLevel([ALL, { collection: '$hub', actions: ['read'] }])).toBe('read')
    expect(hubScopeLevel([{ collection: '$hub', actions: ['read', 'write'] }])).toBe('write')
    expect(hubScopeLevel(undefined)).toBe('none')
    expect(hubScopeEntry('write')).toEqual({ collection: '$hub', actions: ['read', 'write'] })
    expect(hubScopeEntry('none')).toBeNull()
  })
})

describe('hub scope on save', () => {
  const hub = { collection: '$hub', actions: ['read'] }
  it('refused on a regular install and in cloud mode', () => {
    expect(hubScopeRefusal([hub], {} as never)?.code).toBe('HUB_SCOPE_NOT_HERE')
    expect(hubScopeRefusal([hub], { HUB: 'on', CLOUD_META_DB_URL: 'x' } as never)?.code).toBe(
      'HUB_SCOPE_NOT_HERE'
    )
    expect(hubScopeRefusal([ALL], {} as never)).toBeNull()
  })
  it('off a Hub, a key keeps the Hub scope it already had, but gains none', () => {
    expect(hubScopeRefusal([ALL, hub], {} as never, [hub])).toBeNull()
    expect(
      hubScopeRefusal([{ collection: '$hub', actions: ['read', 'write'] }], {} as never, [hub])
        ?.code
    ).toBe('HUB_SCOPE_NOT_HERE')
  })
  it('on a Hub: read / write only, one entry', () => {
    const env = { HUB: 'on' } as never
    expect(hubScopeRefusal([hub], env)).toBeNull()
    expect(hubScopeRefusal([{ collection: '$hub', actions: ['delete'] }], env)?.code).toBe(
      'BAD_HUB_SCOPE'
    )
    expect(hubScopeRefusal([hub, hub], env)?.code).toBe('BAD_HUB_SCOPE')
  })
})

describe('credential refusal', () => {
  it('session people pass; keys need the matching level; agents and View-as never write', () => {
    expect(hubCredentialRefusal({ authMethod: 'session' }, 'write')).toBeNull()
    const readKey = {
      authMethod: 'api_key' as const,
      apiKeyScopes: [{ collection: '$hub', actions: ['read'] }]
    }
    expect(hubCredentialRefusal(readKey, 'read')).toBeNull()
    expect(hubCredentialRefusal(readKey, 'plan')).toBeNull()
    expect(hubCredentialRefusal(readKey, 'write')?.code).toBe('HUB_SCOPE_MISSING')
    expect(hubCredentialRefusal({ authMethod: 'oauth' }, 'plan')).toBeNull()
    expect(hubCredentialRefusal({ authMethod: 'oauth' }, 'write')?.code).toBe(
      'HUB_WRITE_NOT_FOR_AGENTS'
    )
    expect(hubCredentialRefusal({ authMethod: 'teams' }, 'write')?.code).toBe(
      'HUB_WRITE_NOT_FOR_AGENTS'
    )
    expect(
      hubCredentialRefusal({ authMethod: 'masquerade', masqueradeAdminId: 'a' }, 'write')?.code
    ).toBe('NOT_WHILE_MASQUERADING')
  })
})

describe('security alert words', () => {
  it('names the Hub and treats it as never implied by `*`', () => {
    expect(describeKeyScopes([{ collection: '$hub', actions: ['read', 'write'] }])).toBe(
      'read and change the Hub'
    )
    expect(describeKeyScopes([ALL, { collection: '$hub', actions: ['read'] }])).toBe(
      'full access to every collection and read the Hub'
    )
    const before = { scopes: [ALL], ip_allowlist: [], expires_at: null } as never
    const after = {
      scopes: [ALL, { collection: '$hub', actions: ['read', 'write'] }],
      ip_allowlist: [],
      expires_at: null
    } as never
    expect(apiKeyWidening(before, after).join(' ')).toContain('the Hub')
  })
})
