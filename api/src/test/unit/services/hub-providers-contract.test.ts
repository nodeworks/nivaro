import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub third-party providers, Task 0 (contract): the registry, the host-allowlisted fetch,
// the AWS SigV4 signer (AWS's published test vector), the AWS XML reader, the context builder's
// secret scrubbing + token cache, and the migration 582 row store on real SQLite (sealed
// connection secrets that never come back from a read).

vi.mock('../../../db/index.js', async () => {
  const knex = (await import('knex')).default
  const { sqliteAfterCreate, sqliteCompat } = await import('../../../db/sqlite.js')
  sqliteCompat()
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1, afterCreate: sqliteAfterCreate }
  })
  return { db }
})

const { db } = await import('../../../db/index.js')
const migration = await import('../../../db/migrations/582_hub_providers.js')
const registry = await import('../../../services/hub/providers/registry.js')
const { makeProviderFetch, ProviderFetchError, hostAllowed } = await import(
  '../../../services/hub/providers/provider-fetch.js'
)
const { signAwsRequest } = await import('../../../services/hub/providers/aws/sigv4.js')
const { parseAwsXml, xmlList, xmlText, xmlChild, awsXmlError } = await import(
  '../../../services/hub/providers/aws/xml.js'
)
const { makeProviderContext, scrubValues } = await import(
  '../../../services/hub/providers/context.js'
)
const store = await import('../../../services/hub/providers/store.js')
const engine = await import('../../../services/hub/providers/engine/contract.js')
const { isEncrypted } = await import('../../../services/encryption.js')

import type { ProviderAdapter } from '../../../services/hub/providers/types.js'

const KEY = 'f'.repeat(64)
let prevKey: string | undefined

beforeAll(async () => {
  prevKey = process.env.ENCRYPTION_KEY
  process.env.ENCRYPTION_KEY = KEY
  await migration.up(db)
  // A second run changes nothing (guarded, additive).
  await migration.up(db)
})
afterAll(async () => {
  await db.destroy()
  if (prevKey === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = prevKey
})

function demoAdapter(key = 'demo', over: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return {
    key,
    label: 'Demo',
    connection: {
      fields: [
        { key: 'org', label: 'Organisation', kind: 'string', required: true },
        { key: 'token', label: 'Token', kind: 'string', secret: true, required: true }
      ],
      hosts: () => ['api.demo.example'],
      describe: (c) => `Demo ${String(c.org ?? '')}`
    },
    types: [
      {
        key: `${key}.thing`,
        label: 'Thing',
        scope: 'app',
        fields: [
          { key: 'name', label: 'Name', kind: 'string', required: true },
          { key: 'parent', label: 'Parent', kind: 'ref', refType: `${key}.thing` }
        ],
        capabilities: {
          create: true,
          update: true,
          delete: true,
          adopt: true,
          snapshot: false,
          tag: true
        },
        reversible: true,
        refs: [{ field: 'parent', type: `${key}.thing` }],
        risk: (op) => (op.kind === 'delete' ? ['destructive'] : [])
      }
    ],
    testConnection: async () => ({ ok: true, identity: 'demo', permissions: [], missing: [] }),
    observe: async () => null,
    list: async () => ({ items: [], cursor: null }),
    plan: () => [],
    apply: async () => ({ ok: true, externalId: null, observed: null }),
    ...over
  }
}

describe('provider registry', () => {
  beforeEach(() => registry.resetProvidersForTest())

  it('registers and finds an adapter and its types', () => {
    registry.registerProvider(demoAdapter())
    expect(registry.getProvider('demo')?.label).toBe('Demo')
    expect(registry.listProviders().map((p) => p.key)).toEqual(['demo'])
    const hit = registry.findType('demo.thing')
    expect(hit?.provider.key).toBe('demo')
    expect(hit?.type.label).toBe('Thing')
    expect(registry.findType('demo.other')).toBeNull()
    expect(registry.findType('nope.thing')).toBeNull()
    expect(registry.findType('nodot')).toBeNull()
  })

  it('refuses a duplicate key with PROVIDER_KEY_TAKEN (the first stays)', () => {
    registry.registerProvider(demoAdapter())
    const second = demoAdapter('demo', { label: 'Other' })
    expect(() => registry.registerProvider(second)).toThrow(
      expect.objectContaining({ code: 'PROVIDER_KEY_TAKEN' })
    )
    expect(registry.getProvider('demo')?.label).toBe('Demo')
  })

  it('refuses bad keys and bad shapes with PROVIDER_INVALID', () => {
    for (const bad of ['A', 'x', '1abc', 'has_underscore', 'way-too-long-provider-key-over-31', ''])
      expect(() => registry.registerProvider(demoAdapter(bad))).toThrow(
        expect.objectContaining({ code: 'PROVIDER_INVALID' })
      )
    const wrongPrefix = demoAdapter()
    wrongPrefix.types = [{ ...wrongPrefix.types[0], key: 'other.thing' }]
    expect(() => registry.registerProvider(wrongPrefix)).toThrow(
      expect.objectContaining({ code: 'PROVIDER_INVALID' })
    )
    const badSuffix = demoAdapter()
    badSuffix.types = [{ ...badSuffix.types[0], key: 'demo.Bad-Type' }]
    expect(() => registry.registerProvider(badSuffix)).toThrow(
      expect.objectContaining({ code: 'PROVIDER_INVALID' })
    )
    const noApply = demoAdapter() as Partial<ProviderAdapter>
    delete noApply.apply
    expect(() => registry.registerProvider(noApply as ProviderAdapter)).toThrow(
      expect.objectContaining({ code: 'PROVIDER_INVALID' })
    )
    const badRef = demoAdapter()
    badRef.types = [{ ...badRef.types[0], refs: [{ field: 'missing', type: 'demo.thing' }] }]
    expect(() => registry.registerProvider(badRef)).toThrow(
      expect.objectContaining({ code: 'PROVIDER_INVALID' })
    )
    expect(registry.listProviders()).toEqual([])
  })
})

describe('makeProviderFetch', () => {
  const ok = () => new Response('{}', { status: 200 })

  it('matches exact hosts and *.suffix, never the bare suffix or a look-alike', () => {
    const p = ['api.github.com', '*.amazonaws.com']
    expect(hostAllowed('api.github.com', p)).toBe(true)
    expect(hostAllowed('API.GitHub.com', p)).toBe(true)
    expect(hostAllowed('ec2.us-east-1.amazonaws.com', p)).toBe(true)
    expect(hostAllowed('amazonaws.com', p)).toBe(false)
    expect(hostAllowed('evilamazonaws.com', p)).toBe(false)
    expect(hostAllowed('github.com', p)).toBe(false)
  })

  it('refuses http and other hosts with HOST_NOT_ALLOWED before sending', async () => {
    const sent: string[] = []
    const f = makeProviderFetch(['api.github.com', '*.amazonaws.com'], {
      fetchImpl: async (u) => {
        sent.push(u)
        return ok()
      }
    })
    for (const url of ['http://api.github.com/user', 'https://evil.com/', 'not a url'])
      await expect(f(url)).rejects.toMatchObject({ code: 'HOST_NOT_ALLOWED' })
    await expect(f('https://user:pw@api.github.com/')).rejects.toMatchObject({
      code: 'HOST_NOT_ALLOWED'
    })
    expect(sent).toEqual([])
    const res = await f('https://ec2.us-east-1.amazonaws.com/?Action=DescribeVpcs')
    expect(res.status).toBe(200)
    expect(sent).toEqual(['https://ec2.us-east-1.amazonaws.com/?Action=DescribeVpcs'])
  })

  it('times out at timeoutMs with a retryable TIMEOUT', async () => {
    const f = makeProviderFetch(['api.github.com'], {
      timeoutMs: 50,
      fetchImpl: (_u, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    })
    const started = Date.now()
    const err = await f('https://api.github.com/').catch((e) => e)
    expect(err).toBeInstanceOf(ProviderFetchError)
    expect(err.code).toBe('TIMEOUT')
    expect(err.retryable).toBe(true)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('follows redirects only to allowed hosts and drops auth across hosts', async () => {
    const seen: Array<{ url: string; auth?: string }> = []
    const f = makeProviderFetch(['api.github.com', 'objects.github.com'], {
      fetchImpl: async (u, init) => {
        const h = init.headers as Record<string, string>
        seen.push({ url: u, auth: h.authorization })
        if (u.endsWith('/a'))
          return new Response(null, {
            status: 302,
            headers: { location: 'https://objects.github.com/b' }
          })
        if (u.endsWith('/evil'))
          return new Response(null, { status: 302, headers: { location: 'https://evil.com/' } })
        return ok()
      }
    })
    const res = await f('https://api.github.com/a', { headers: { Authorization: 'Bearer x' } })
    expect(res.status).toBe(200)
    expect(seen).toEqual([
      { url: 'https://api.github.com/a', auth: 'Bearer x' },
      { url: 'https://objects.github.com/b', auth: undefined }
    ])
    await expect(f('https://api.github.com/evil')).rejects.toMatchObject({
      code: 'HOST_NOT_ALLOWED'
    })
  })
})

describe('signAwsRequest', () => {
  // AWS sig-v4 test suite, case get-vanilla.
  it('matches the published get-vanilla vector', () => {
    const headers = signAwsRequest(
      {
        method: 'GET',
        url: 'https://example.amazonaws.com/',
        headers: {},
        body: '',
        service: 'service',
        region: 'us-east-1'
      },
      {
        accessKeyId: 'AKIDEXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'
      },
      new Date('2015-08-30T12:36:00Z')
    )
    expect(headers['x-amz-date']).toBe('20150830T123600Z')
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
        'SignedHeaders=host;x-amz-date, ' +
        'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31'
    )
    expect(headers.host).toBeUndefined()
  })

  it('signs the session token and S3 payload hash', () => {
    const h = signAwsRequest(
      {
        method: 'PUT',
        url: 'https://bucket.s3.us-east-1.amazonaws.com/a b.txt',
        body: 'hello',
        service: 's3',
        region: 'us-east-1'
      },
      { accessKeyId: 'AKID', secretAccessKey: 'SECRET', sessionToken: 'TOKEN' },
      new Date('2026-11-26T00:00:00Z')
    )
    expect(h['x-amz-security-token']).toBe('TOKEN')
    expect(h['x-amz-content-sha256']).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
    )
    expect(h.authorization).toContain(
      'SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token'
    )
    expect(h.authorization).not.toContain('SECRET')
  })
})

describe('parseAwsXml', () => {
  const sample = `<?xml version="1.0" encoding="UTF-8"?>
<DescribeSecurityGroupsResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/">
    <requestId>59dbff89-35bd-4eac-99ed-be587EXAMPLE</requestId>
    <securityGroupInfo>
        <item>
            <ownerId>123456789012</ownerId>
            <groupId>sg-1a2b3c4d</groupId>
            <groupName>WebServers &amp; friends</groupName>
            <groupDescription>Web Servers</groupDescription>
            <vpcId>vpc-614cc409</vpcId>
            <ipPermissions>
                <item>
                    <ipProtocol>tcp</ipProtocol>
                    <fromPort>80</fromPort>
                    <toPort>80</toPort>
                    <groups/>
                    <ipRanges>
                        <item><cidrIp>0.0.0.0/0</cidrIp></item>
                    </ipRanges>
                </item>
            </ipPermissions>
            <tagSet>
                <item><key>nivaro-hub:app</key><value>efp</value></item>
                <item><key>Name</key><value>web</value></item>
            </tagSet>
        </item>
        <item>
            <ownerId>123456789012</ownerId>
            <groupId>sg-2b3c4d5e</groupId>
            <groupName>RangedPortsBySource</groupName>
            <ipPermissions/>
        </item>
    </securityGroupInfo>
</DescribeSecurityGroupsResponse>`

  it('reads a DescribeSecurityGroups answer', () => {
    const doc = parseAwsXml(sample)
    const resp = doc.DescribeSecurityGroupsResponse
    expect(xmlText(xmlChild(resp, 'requestId'))).toBe('59dbff89-35bd-4eac-99ed-be587EXAMPLE')
    const groups = xmlList(xmlChild(resp, 'securityGroupInfo'), 'item')
    expect(groups).toHaveLength(2)
    expect(xmlText(xmlChild(groups[0], 'groupId'))).toBe('sg-1a2b3c4d')
    expect(xmlText(xmlChild(groups[0], 'groupName'))).toBe('WebServers & friends')
    const perms = xmlList(xmlChild(groups[0], 'ipPermissions'), 'item')
    expect(perms).toHaveLength(1)
    expect(xmlText(xmlChild(perms[0], 'fromPort'))).toBe('80')
    const ranges = xmlList(xmlChild(perms[0], 'ipRanges'), 'item')
    expect(ranges.map((r) => xmlText(xmlChild(r, 'cidrIp')))).toEqual(['0.0.0.0/0'])
    expect(xmlList(xmlChild(perms[0], 'groups'), 'item')).toEqual([])
    const tags = xmlList(xmlChild(groups[0], 'tagSet'), 'item').map((t) => [
      xmlText(xmlChild(t, 'key')),
      xmlText(xmlChild(t, 'value'))
    ])
    expect(tags).toEqual([
      ['nivaro-hub:app', 'efp'],
      ['Name', 'web']
    ])
    expect(xmlList(xmlChild(groups[1], 'ipPermissions'), 'item')).toEqual([])
    expect(awsXmlError(doc)).toBeNull()
  })

  it('reads error answers and refuses broken XML', () => {
    const ec2 = parseAwsXml(
      '<Response><Errors><Error><Code>UnauthorizedOperation</Code><Message>no &#x41;</Message></Error></Errors><RequestID>x</RequestID></Response>'
    )
    expect(awsXmlError(ec2)).toEqual({ code: 'UnauthorizedOperation', message: 'no A' })
    const query = parseAwsXml(
      '<ErrorResponse><Error><Type>Sender</Type><Code>Throttling</Code><Message>Rate exceeded</Message></Error></ErrorResponse>'
    )
    expect(awsXmlError(query)).toEqual({ code: 'Throttling', message: 'Rate exceeded' })
    for (const bad of ['', '<a><b></a>', '<a></a><b></b>', '<!DOCTYPE x><a/>', '<a>'])
      expect(() => parseAwsXml(bad)).toThrow()
    // A key that would reach the prototype is dropped.
    const p = parseAwsXml('<r><__proto__><x>1</x></__proto__><y>2</y></r>')
    expect(({} as Record<string, unknown>).x).toBeUndefined()
    expect(xmlText(xmlChild(p.r, 'y'))).toBe('2')
  })
})

describe('makeProviderContext', () => {
  it('scrubs the connection secrets and cached tokens, and keeps tokens per credentials', () => {
    let t = new Date('2026-11-26T00:00:00Z')
    const ctx = makeProviderContext({
      adapter: demoAdapter(),
      connectionId: 9001,
      config: { org: 'acme' },
      secrets: { token: 'ghp_supersecret123' },
      now: () => t
    })
    expect(ctx.scrub('bad token ghp_supersecret123 here')).toBe('bad token •••••• here')
    ctx.tokens.set('install', 'ghs_installtoken', new Date(t.getTime() + 3600_000))
    expect(ctx.tokens.get('install')).toBe('ghs_installtoken')
    expect(ctx.scrub('x ghs_installtoken')).toBe('x ••••••')
    // A context built from other credentials never sees the old token.
    const other = makeProviderContext({
      adapter: demoAdapter(),
      connectionId: 9001,
      config: {},
      secrets: { token: 'rotated-token-value' },
      now: () => t
    })
    expect(other.tokens.get('install')).toBeNull()
    // Expired (within 60 s of the end) = gone.
    t = new Date(t.getTime() + 3600_000 - 30_000)
    expect(ctx.tokens.get('install')).toBeNull()
    expect(scrubValues('abc', ['ab'])).toBe('abc')
  })

  it('limits ctx.fetch to the hosts the connection declares', async () => {
    const ctx = makeProviderContext({
      adapter: demoAdapter(),
      connectionId: 1,
      config: {},
      secrets: {},
      fetch: { fetchImpl: async () => new Response('ok') }
    })
    await expect(ctx.fetch('https://api.github.com/')).rejects.toMatchObject({
      code: 'HOST_NOT_ALLOWED'
    })
    expect((await ctx.fetch('https://api.demo.example/x')).status).toBe(200)
  })
})

describe('provider store (migration 582, SQLite)', () => {
  beforeEach(async () => {
    process.env.ENCRYPTION_KEY = KEY
    for (const t of [
      store.CONNECTIONS,
      store.APP_CONNECTIONS,
      store.RESOURCES,
      store.RESOURCE_CHANGES
    ])
      await db(t).del()
  })

  it('round-trips a connection with a sealed secret that no read answers', async () => {
    const c = await store.createConnection({
      provider: 'github',
      name: 'Nodeworks org',
      config: { org: 'nodeworks' },
      secrets: { private_key: 'PEM-PRIVATE-KEY-VALUE', app_id_secret: '' },
      createdBy: 'AAAAAAAA-0000-4000-8000-000000000001'
    })
    const raw = await db(store.CONNECTIONS).where({ id: c.id }).first()
    expect(isEncrypted(raw.secret)).toBe(true)
    expect(String(raw.secret)).not.toContain('PEM-PRIVATE-KEY-VALUE')

    const read = await store.readConnection(c.id)
    expect(read).toMatchObject({
      provider: 'github',
      name: 'Nodeworks org',
      config: { org: 'nodeworks' },
      secret_mask: '••••••',
      secret_keys: ['private_key'],
      status: 'untested'
    })
    expect(read?.secret_fingerprint).toMatch(/^[0-9a-f]{32}$/)
    expect(JSON.stringify(read)).not.toContain('PEM-PRIVATE-KEY-VALUE')
    expect(JSON.stringify(await store.listConnections())).not.toContain('PEM-PRIVATE-KEY-VALUE')
    expect(await store.openConnectionSecrets(c)).toEqual({ private_key: 'PEM-PRIVATE-KEY-VALUE' })

    // The mask keeps a secret, '' clears one, a new value replaces / adds.
    const upd = await store.updateConnection(c.id, {
      name: 'Renamed',
      secrets: { private_key: '••••••', pat: 'ghp_newvalue' }
    })
    expect(upd?.name).toBe('Renamed')
    expect(upd?.secret_keys).toEqual(['pat', 'private_key'])
    expect(await store.openConnectionSecrets(c)).toEqual({
      private_key: 'PEM-PRIVATE-KEY-VALUE',
      pat: 'ghp_newvalue'
    })
    await store.updateConnection(c.id, { secrets: { private_key: '', pat: null } })
    expect(await store.openConnectionSecrets(c)).toEqual({})
    expect((await store.readConnection(c.id))?.secret_mask).toBeNull()

    await store.setAppAllowedConnections(7, [c.id, c.id])
    expect(await store.appAllowedConnections(7)).toEqual([c.id])
    expect(await store.deleteConnection(c.id)).toBe(true)
    expect(await store.readConnection(c.id)).toBeNull()
    expect(await store.appAllowedConnections(7)).toEqual([])
  })

  it('keeps one live row per provider id and filters resources', async () => {
    const base = {
      connection_id: 1,
      provider: 'aws',
      type: 'aws.vpc',
      external_id: 'vpc-123',
      scope: 'shared' as const
    }
    const a = await store.insertResource({ ...base, desired: { cidr: '10.0.0.0/16' } })
    expect(a).toMatchObject({ scope: 'shared', app_id: null, drift: false, adopted: false })
    await expect(store.insertResource(base)).rejects.toMatchObject({
      code: 'RESOURCE_ALREADY_MANAGED'
    })
    await store.updateResource(a.id, { deleted_at: new Date() })
    const b = await store.insertResource({ ...base, adopted: true })
    expect(b.adopted).toBe(true)

    const sg = await store.insertResource({
      connection_id: 1,
      provider: 'aws',
      type: 'aws.security_group',
      scope: 'app',
      app_id: 3,
      environment_id: 5,
      refs: [{ field: 'vpc', resourceId: b.id }],
      tags: { 'nivaro-hub:app': 'efp' }
    })
    await store.updateResource(sg.id, { drift: true, observed_at: new Date() })
    expect((await store.listResources({ appId: 3 })).map((r) => r.id)).toEqual([sg.id])
    expect((await store.listResources({ drift: true }))[0]).toMatchObject({
      refs: [{ field: 'vpc', resourceId: b.id }],
      tags: { 'nivaro-hub:app': 'efp' }
    })
    expect(await store.listResources({ type: 'aws.vpc' })).toHaveLength(1)
    expect(await store.listResources({ type: 'aws.vpc', includeDeleted: true })).toHaveLength(2)
  })

  it('stores changes with compare-and-set on status', async () => {
    const plan = {
      request: { connectionId: 1, scope: 'app' as const, appId: 3, ops: [] },
      ops: [],
      gates: [],
      needsConfirm: null,
      needsApproval: false,
      blockers: [],
      preconditionFingerprint: 'fp',
      resourceIds: []
    }
    const ch = await store.insertChange({
      connection_id: 1,
      app_id: 3,
      scope: 'app',
      plan,
      plan_hash: 'h1'
    })
    expect(ch).toMatchObject({ status: 'planned', plan_hash: 'h1', steps: [], plan })
    expect(
      await store.updateChange(ch.id, { status: 'applying' }, { expectStatus: 'pending_approval' })
    ).toBeNull()
    const started = await store.updateChange(
      ch.id,
      { status: 'applying', run_key: 'rk', heartbeat_at: new Date() },
      { expectStatus: ['planned', 'interrupted'] }
    )
    expect(started).toMatchObject({ status: 'applying', run_key: 'rk' })
    expect((await store.listChanges({ status: 'applying', appId: 3 })).map((c) => c.id)).toEqual([
      ch.id
    ])
  })
})

describe('engine contract', () => {
  it('is signatures only until Task 1', async () => {
    const actor = { id: 'u', isAdmin: true, via: 'session' as const }
    await expect(
      engine.planResourceChange({ connectionId: 1, scope: 'shared', ops: [] }, actor)
    ).rejects.toThrow('not implemented')
    const err = new engine.ResourceChangeError('SHARED_IN_USE', 'in use')
    expect(err.status).toBe(409)
  })
})

describe('providerFetch refuses dot segments (path traversal by id)', () => {
  it('flags plain, encoded and decoded-to-dot segments', async () => {
    const { hasDotSegment } = await import('../../../services/hub/providers/provider-fetch.js')
    expect(hasDotSegment('https://api.github.com/repos/a/b/environments/..')).toBe(true)
    expect(hasDotSegment('https://api.github.com/repos/a/b/environments/%2e%2e')).toBe(true)
    expect(hasDotSegment('https://api.github.com/repos/a/b/environments/%2E')).toBe(true)
    expect(hasDotSegment('https://api.github.com/repos/a/b/x/..%2f..')).toBe(true)
    expect(hasDotSegment('https://api.github.com/repos/a/b/x/%zz')).toBe(true)
    expect(hasDotSegment('https://gitlab.example.com/api/v4/projects/group%2Fproject')).toBe(false)
    expect(hasDotSegment('https://api.github.com/repos/a/b/environments/prod?x=..')).toBe(false)
    expect(hasDotSegment('https://api.github.com/repos/a/b/contents/.github/CODEOWNERS')).toBe(
      false
    )
  })

  it('refuses the call before anything is sent', async () => {
    const { makeProviderFetch } = await import('../../../services/hub/providers/provider-fetch.js')
    let sent = 0
    const f = makeProviderFetch(['api.github.com'], {
      fetchImpl: async () => {
        sent++
        return new Response('{}')
      }
    })
    await expect(
      f('https://api.github.com/repos/a/b/environments/%2e%2e', { method: 'DELETE' })
    ).rejects.toMatchObject({ code: 'HOST_NOT_ALLOWED' })
    expect(sent).toBe(0)
  })
})
