import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Sign-in through the Hub and the app switcher, per app on a Hub shared deployment (0.3.215).
// The Hub hands each app its own client, hub token and Microsoft audience in the tenant list,
// sealed with that app's key; inside an app the deployment uses that app's values only, outside
// any app none, and Nivaro Cloud never.

vi.mock('../../../db/index.js', () => ({
  db: () => ({ where: () => ({ where: () => ({}), first: async () => undefined }) })
}))
vi.mock('../../../services/settings-overrides.js', () => ({
  overlaySettings: async (r: unknown) => r
}))
vi.mock('../../../services/readiness.js', () => ({ registerReadinessCheck: () => {} }))

import { runWithTenantDb } from '../../../db/tenant-context.js'
import { enabledFeatures } from '../../../services/app-info.js'
import { appHubLink } from '../../../services/hub/mode.js'
import { hubSigninConfig, hubSigninProblems } from '../../../services/hub-signin/config.js'
import { pushKey, switcherKey } from '../../../services/hub-signin/link-client.js'
import {
  _resetHubProbeForTests,
  hubSigninUp,
  noteHubSigninFailed
} from '../../../services/hub-signin/probe.js'
import {
  appHubLinkOf,
  parseHubLink,
  resetAppHubLinksForTests,
  setAppHubLinks
} from '../../../services/tenancy/app-hub-links.js'
import { openForApp, sealForApp } from '../../../services/tenancy/app-sealed.js'
import { parseHubTenants } from '../../../services/tenancy/hub-contract.js'
import {
  type HubTenantRegistry,
  resetHubTenantSourceForTests,
  startHubTenantSource
} from '../../../services/tenancy/hub-source.js'

const KEY_A = 'a1'.repeat(32)
const KEY_B = 'b2'.repeat(32)
const TOKEN_A = `hubtok-a-${'x'.repeat(40)}`
const TOKEN_B = `hubtok-b-${'y'.repeat(40)}`
const CLIENT_A = `hubc_${'a'.repeat(24)}`
const SECRET_A = `hubs_${'s'.repeat(43)}`
const DEPLOYMENT = 'shared-a'

const ENV_KEYS = [
  'HUB_SHARED_DEPLOYMENT',
  'HUB_URL',
  'HUB_DEPLOYMENT_TOKEN',
  'HUB_TOKEN',
  'HUB_CLIENT_ID',
  'HUB_CLIENT_SECRET',
  'HUB_IDP_AUDIENCE',
  'HUB_SIGNIN',
  'HUB',
  'OIDC_ISSUER',
  'OIDC_CLIENT_ID',
  'ENCRYPTION_KEY',
  'CLOUD_META_DB_URL'
]
const saved: Record<string, string | undefined> = {}

function sharedMode() {
  process.env.HUB_SHARED_DEPLOYMENT = DEPLOYMENT
  process.env.HUB_URL = 'https://hub.example.com'
  process.env.HUB_DEPLOYMENT_TOKEN = `dep-${'t'.repeat(40)}`
  process.env.OIDC_ISSUER = 'https://login.microsoftonline.com/tenant-1/v2.0'
  process.env.OIDC_CLIENT_ID = 'deployment-entra-app'
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  process.env.ENCRYPTION_KEY = 'd'.repeat(64)
  resetAppHubLinksForTests()
  _resetHubProbeForTests()
})
afterEach(() => {
  resetHubTenantSourceForTests()
  resetAppHubLinksForTests()
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

function inApp<T>(id: string, fn: () => T | Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    runWithTenantDb(
      {} as never,
      id,
      () => {
        Promise.resolve().then(fn).then(resolve, reject)
      },
      id
    )
  })
}

const linkA = () =>
  sealForApp(
    JSON.stringify({
      v: 1,
      token: TOKEN_A,
      client_id: CLIENT_A,
      client_secret: SECRET_A,
      idp_audience: 'hub-entra-app'
    }),
    KEY_A
  )
const linkB = () => sealForApp(JSON.stringify({ v: 1, token: TOKEN_B }), KEY_B)

describe('app-sealed', () => {
  it('seals the same value to the same text, opens only with that key', () => {
    const a = sealForApp('hello', KEY_A)
    expect(a.startsWith('enc:v1:')).toBe(true)
    expect(sealForApp('hello', KEY_A)).toBe(a)
    expect(sealForApp('hello', KEY_B)).not.toBe(a)
    expect(openForApp(a, KEY_A)).toBe('hello')
    expect(openForApp(a, KEY_B)).toBeNull()
    expect(openForApp(`${a.slice(0, -4)}AAAA`, KEY_A)).toBeNull()
    expect(openForApp('plain', KEY_A)).toBeNull()
    expect(openForApp(a, 'short')).toBeNull()
  })
})

describe('parseHubLink', () => {
  it('keeps a client only as a pair, drops off-shape values', () => {
    expect(parseHubLink(null)).toBeNull()
    expect(parseHubLink('not json')).toBeNull()
    expect(parseHubLink(JSON.stringify({ token: 'short' }))).toBeNull()
    expect(parseHubLink(JSON.stringify({ client_id: CLIENT_A }))).toBeNull()
    expect(parseHubLink(JSON.stringify({ client_id: 'bad', client_secret: SECRET_A }))).toBeNull()
    expect(
      parseHubLink(
        JSON.stringify({ client_id: CLIENT_A, client_secret: SECRET_A, idp_audience: 'a b' })
      )
    ).toEqual({ token: null, clientId: CLIENT_A, clientSecret: SECRET_A, idpAudience: null })
    expect(parseHubLink(JSON.stringify({ token: TOKEN_A }))).toEqual({
      token: TOKEN_A,
      clientId: null,
      clientSecret: null,
      idpAudience: null
    })
  })

  it('opens each app with its own key; a link sealed with another key is dropped', () => {
    setAppHubLinks([
      { id: 'app-a', encryptionKey: KEY_A, hubLink: linkA() },
      { id: 'app-b', encryptionKey: KEY_A, hubLink: linkB() },
      { id: 'app-c', hubLink: linkA() }
    ])
    expect(appHubLinkOf('app-a')?.clientId).toBe(CLIENT_A)
    expect(appHubLinkOf('app-b')).toBeNull()
    expect(appHubLinkOf('app-c')).toBeNull()
  })
})

describe('the tenants contract', () => {
  it('keeps a sealed hub_link; a bad one drops the field, never the tenant', () => {
    const wire = (id: string, hub_link: unknown) => ({
      id,
      app_key: id,
      env_key: 'prod',
      name: id,
      status: 'active',
      hostnames: [`${id}.example.com`],
      db: { client: 'pg', connection: `postgres://u:p@db/${id}` },
      encryption_key: KEY_A,
      hub_link
    })
    const parsed = parseHubTenants(
      {
        data: {
          deployment: DEPLOYMENT,
          tenants: [
            wire('a', linkA()),
            wire('b', 'plain text'),
            wire('c', 'enc:v1:'.padEnd(9000, 'x'))
          ]
        }
      },
      DEPLOYMENT
    )
    expect(parsed?.tenants.map((t) => [t.id, !!t.hubLink])).toEqual([
      ['a', true],
      ['b', false],
      ['c', false]
    ])
    expect(parsed?.dropped).toEqual([])
  })
})

describe('per app on a Hub shared deployment', () => {
  async function startWithTwoApps(): Promise<HubTenantRegistry> {
    sharedMode()
    const wire = (id: string, key: string, hub_link?: string) => ({
      id,
      app_key: id,
      env_key: 'prod',
      name: id,
      status: 'active',
      hostnames: [`${id}.example.com`],
      db: { client: 'pg', connection: `postgres://u:p@db/${id}` },
      encryption_key: key,
      ...(hub_link ? { hub_link } : {})
    })
    const body = {
      data: {
        deployment: DEPLOYMENT,
        generated_at: '2026-11-24T00:00:00Z',
        tenants: [
          wire('app-a', KEY_A, linkA()),
          wire('app-b', KEY_B, linkB()),
          wire('app-c', KEY_A)
        ]
      }
    }
    const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
    return (await startHubTenantSource({ redis: null, fetch: fetch as never })) as HubTenantRegistry
  }

  it('signs each app in with its own client; none outside an app or for an app without one', async () => {
    await startWithTwoApps()
    const a = await inApp('app-a', () => hubSigninConfig())
    expect(a).toEqual({
      hubUrl: 'https://hub.example.com',
      issuer: 'https://hub.example.com/api/hub/oidc',
      clientId: CLIENT_A,
      clientSecret: SECRET_A,
      idpAudience: 'hub-entra-app',
      allowInsecure: false
    })
    expect(await inApp('app-b', () => hubSigninConfig())).toBeNull()
    expect(await inApp('app-b', () => hubSigninProblems())).toEqual([])
    expect(await inApp('app-c', () => hubSigninConfig())).toBeNull()
    expect(hubSigninConfig()).toBeNull()
  })

  it("never uses the deployment's own HUB_CLIENT_* or HUB_TOKEN for an app", async () => {
    await startWithTwoApps()
    process.env.HUB_CLIENT_ID = `hubc_${'f'.repeat(24)}`
    process.env.HUB_CLIENT_SECRET = 'z'.repeat(40)
    process.env.HUB_IDP_AUDIENCE = 'deploy-aud'
    process.env.HUB_TOKEN = 'w'.repeat(40)
    expect(await inApp('app-c', () => hubSigninConfig())).toBeNull()
    expect(await inApp('app-c', () => appHubLink())).toBeNull()
    expect(hubSigninConfig()).toBeNull()
    expect(appHubLink()).toBeNull()
    // the app's own audience wins over the deployment's
    expect((await inApp('app-a', () => hubSigninConfig()))?.idpAudience).toBe('hub-entra-app')
  })

  it('names what is missing for an app the Hub gave a client', async () => {
    await startWithTwoApps()
    delete process.env.OIDC_CLIENT_ID
    process.env.HUB_SIGNIN = 'off'
    expect(await inApp('app-a', () => hubSigninProblems())).toEqual([
      'HUB_SIGNIN',
      'OIDC_CLIENT_ID'
    ])
    expect(await inApp('app-a', () => hubSigninConfig())).toBeNull()
  })

  it('the switcher and sign-in reports use each app’s own token, under keys that name the app', async () => {
    await startWithTwoApps()
    expect(await inApp('app-a', () => appHubLink())).toEqual({
      hub: 'https://hub.example.com',
      token: TOKEN_A
    })
    expect(await inApp('app-b', () => appHubLink())).toEqual({
      hub: 'https://hub.example.com',
      token: TOKEN_B
    })
    expect(await inApp('app-c', () => appHubLink())).toBeNull()
    expect(await inApp('app-a', () => enabledFeatures())).toContain('hub_switcher')
    expect(await inApp('app-c', () => enabledFeatures())).not.toContain('hub_switcher')
    expect(enabledFeatures()).not.toContain('hub_switcher')
    const ka = await inApp('app-a', () => pushKey('u1', TOKEN_A))
    const kb = await inApp('app-b', () => switcherKey('u1', TOKEN_A))
    expect(ka).toMatch(/^nvr:hub-signin-push:app:app-a:[0-9a-f]{10}:u1$/)
    expect(kb).toMatch(/^nvr:hub-switcher:app:app-b:[0-9a-f]{10}:u1$/)
  })

  it('a failed Hub round trip in one app never sends another app to direct sign-in', async () => {
    await startWithTwoApps()
    const cfg = (await inApp('app-a', () => hubSigninConfig()))!
    const other = { ...cfg, clientId: `hubc_${'b'.repeat(24)}` }
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    )
    await inApp('app-a', () => noteHubSigninFailed(Date.now(), cfg))
    expect(await inApp('app-a', () => hubSigninUp(cfg, { fetchImpl }))).toBe(false)
    expect(await inApp('app-b', () => hubSigninUp(other, { fetchImpl }))).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('an app that leaves the list loses its link', async () => {
    const reg = await startWithTwoApps()
    expect(await inApp('app-a', () => appHubLink())).not.toBeNull()
    setAppHubLinks((await reg.listAll()).filter((t) => t.id !== 'app-a'))
    expect(await inApp('app-a', () => appHubLink())).toBeNull()
  })

  it('Nivaro Cloud stays strict', async () => {
    setAppHubLinks([{ id: 'app-a', encryptionKey: KEY_A, hubLink: linkA() }])
    process.env.CLOUD_META_DB_URL = 'postgres://meta'
    process.env.HUB_URL = 'https://hub.example.com'
    process.env.HUB_TOKEN = 'w'.repeat(40)
    process.env.OIDC_ISSUER = 'https://login.microsoftonline.com/tenant-1/v2.0'
    process.env.OIDC_CLIENT_ID = 'x'
    expect(await inApp('app-a', () => hubSigninConfig())).toBeNull()
    expect(await inApp('app-a', () => hubSigninProblems())).toEqual([])
    expect(await inApp('app-a', () => appHubLink())).toBeNull()
    expect(await inApp('app-a', () => enabledFeatures())).not.toContain('hub_switcher')
  })
})
