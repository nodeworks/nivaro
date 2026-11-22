import type { Knex } from 'knex'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 3: creation targets (where new apps go). Real SQLite holds the rows; the
// Test button runs the real GitLab calls over the in-memory GitLab.

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

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const m542 = await import('../../../db/migrations/542_hub_tables.js')
const m543 = await import('../../../db/migrations/543_hub_promotions.js')
const m544 = await import('../../../db/migrations/544_hub_databases.js')
const m545 = await import('../../../db/migrations/545_hub_creations.js')
const T = await import('../../../services/hub/create/targets.js')
const { HUB_MASK, sealSecret } = await import('../../../services/hub/secrets.js')
const { FakeGitLab } = await import('./hub-fake-gitlab.js')

const KEY = 'c'.repeat(64)
const HOST_KEY = `swarm-1.internal ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${'k'.repeat(43)}`
const config = {
  api: 'https://gitlab.example.com/api/v4',
  namespace: 'apps',
  template_project: 'platform/hub-app-template',
  template_ref: 'v1.0.0',
  deploy_host: 'deploy@swarm-1.internal',
  manager_known_hosts: HOST_KEY,
  dns_mode: 'automatic',
  wildcard_domain: 'apps.example.com'
}

let prevKey: string | undefined
beforeAll(async () => {
  prevKey = process.env.ENCRYPTION_KEY
  process.env.ENCRYPTION_KEY = KEY
  await m542.up(db)
  await m543.up(db)
  await m544.up(db)
  await m545.up(db)
})
afterAll(async () => {
  if (prevKey === undefined) delete process.env.ENCRYPTION_KEY
  else process.env.ENCRYPTION_KEY = prevKey
  await db.destroy()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

const valid = (over: Record<string, unknown> = {}, cfg: Record<string, unknown> = {}) =>
  T.validateTargetInput({
    kind: 'gitlab',
    name: 'Main GitLab',
    config: { ...config, ...cfg },
    secret: 'glpat-SECRET-hub-token-0123456789',
    ...over
  })

describe('validateTargetInput — pinned template ref and manager host keys', () => {
  it('template_ref: a tag or a full sha, never a moving branch', () => {
    for (const r of [
      'v1.0.0',
      'hub-template-3',
      'a'.repeat(40),
      '0123456789abcdef0123456789abcdef01234567'
    ])
      expect(valid({}, { template_ref: r }).ok, r).toBe(true)
    for (const r of [
      undefined,
      '',
      'main',
      'MASTER',
      'HEAD',
      'develop',
      '-x',
      'a..b',
      'v1 2',
      'x.lock',
      'a/b'
    ])
      expect(valid({}, { template_ref: r }), String(r)).toMatchObject({
        ok: false,
        code: 'BAD_CONFIG'
      })
  })

  it('manager_known_hosts: known_hosts lines only, normalised', () => {
    const multi = [
      '# swarm-1',
      '',
      `swarm-1.internal,10.0.0.5   ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${'k'.repeat(43)} root@swarm-1`,
      `[swarm-1.internal]:2222 ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAI${'b'.repeat(40)}=`,
      `@cert-authority *.internal ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${'c'.repeat(43)}`,
      `|1|c2FsdHNhbHRzYWx0|aGFzaGhhc2hoYXNo= ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAAB${'d'.repeat(60)}`
    ].join('\r\n')
    const r = valid({}, { manager_known_hosts: multi })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const lines = r.row.config.manager_known_hosts.split('\n')
    expect(lines).toHaveLength(4)
    expect(lines[0]).toBe(
      `swarm-1.internal,10.0.0.5 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${'k'.repeat(43)}`
    )
    for (const bad of [
      undefined,
      '',
      '# only a comment',
      'swarm-1.internal',
      'swarm-1.internal ssh-dss AAAAB3NzaC1kc3MAAACBAP',
      `swarm-1.internal ssh-ed25519 not*base64${'k'.repeat(20)}`,
      `@revoked-ish swarm ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${'k'.repeat(43)}`,
      `-oProxyCommand=x ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${'k'.repeat(43)}`,
      `swarm;id ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI${'k'.repeat(43)}`,
      'x'.repeat(16_001)
    ])
      expect(valid({}, { manager_known_hosts: bad }), String(bad).slice(0, 40)).toMatchObject({
        ok: false,
        code: 'BAD_CONFIG'
      })
  })
})

describe('validateTargetInput', () => {
  it('fills the defaults and seals the token', () => {
    const r = valid()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.row.config).toEqual({
      api: 'https://gitlab.example.com/api/v4',
      namespace: 'apps',
      template_project: 'platform/hub-app-template',
      template_ref: 'v1.0.0',
      pin_file: '.hub/nivaro-version',
      deploy_job: 'deploy',
      deploy_host: 'deploy@swarm-1.internal',
      manager_known_hosts: HOST_KEY,
      proxy_network: 'proxy',
      dns_mode: 'automatic',
      wildcard_domain: 'apps.example.com',
      edge_address: null,
      scheme: 'https',
      port: null,
      cert_note: null
    })
    expect(r.row.secret).not.toContain('glpat')
    expect(r.row.secret).toBeTruthy()
  })

  it('BAD_KIND / BAD_NAME', () => {
    expect(valid({ kind: 'docker' })).toMatchObject({ ok: false, code: 'BAD_KIND' })
    expect(valid({ name: '  ' })).toMatchObject({ ok: false, code: 'BAD_NAME' })
  })

  it('BAD_CONFIG: unknown key, missing key, unsafe api, bad port or dns mode', () => {
    expect(valid({}, { extra: 1 })).toMatchObject({ ok: false, code: 'BAD_CONFIG' })
    expect(valid({}, { namespace: '' })).toMatchObject({ ok: false, code: 'BAD_CONFIG' })
    expect(valid({}, { template_project: undefined })).toMatchObject({ code: 'BAD_CONFIG' })
    expect(valid({}, { deploy_host: undefined })).toMatchObject({ code: 'BAD_CONFIG' })
    expect(valid({}, { api: 'http://gitlab.example.com' })).toMatchObject({ code: 'BAD_CONFIG' })
    expect(valid({}, { api: 'http://localhost:8080' }).ok).toBe(true)
    expect(valid({}, { port: 70000 })).toMatchObject({ code: 'BAD_CONFIG' })
    expect(valid({}, { port: 8443 }).ok).toBe(true)
    expect(valid({}, { dns_mode: 'magic' })).toMatchObject({ code: 'BAD_CONFIG' })
    expect(valid({}, { scheme: 'ftp' })).toMatchObject({ code: 'BAD_CONFIG' })
    expect(valid({}, { pin_file: '../etc/x' })).toMatchObject({ code: 'BAD_CONFIG' })
    expect(valid({}, { proxy_network: 'a b' })).toMatchObject({ code: 'BAD_CONFIG' })
    expect(valid({ config: [] })).toMatchObject({ code: 'BAD_CONFIG' })
  })

  it('BAD_WILDCARD: automatic needs a valid DNS suffix', () => {
    expect(valid({}, { wildcard_domain: null })).toMatchObject({ code: 'BAD_WILDCARD' })
    expect(valid({}, { wildcard_domain: 'bad_domain!' })).toMatchObject({ code: 'BAD_WILDCARD' })
    expect(valid({}, { wildcard_domain: '-x.example.com' })).toMatchObject({ code: 'BAD_WILDCARD' })
    expect(valid({}, { wildcard_domain: `${'a'.repeat(64)}.com` })).toMatchObject({
      code: 'BAD_WILDCARD'
    })
    const star = valid({}, { wildcard_domain: '*.Apps.Example.com.' })
    expect(star.ok && star.row.config.wildcard_domain).toBe('apps.example.com')
    // Manual: no wildcard needed, but one given must still be valid.
    expect(valid({}, { dns_mode: 'manual', wildcard_domain: null }).ok).toBe(true)
    expect(valid({}, { dns_mode: 'manual', wildcard_domain: 'a..b' })).toMatchObject({
      code: 'BAD_WILDCARD'
    })
  })

  it('BAD_SCHEME: http only for localhost / .test', () => {
    expect(valid({}, { scheme: 'http' })).toMatchObject({ ok: false, code: 'BAD_SCHEME' })
    expect(valid({}, { scheme: 'http', wildcard_domain: 'localhost' }).ok).toBe(true)
    expect(valid({}, { scheme: 'http', wildcard_domain: 'apps.test' }).ok).toBe(true)
    expect(valid({}, { scheme: 'http', wildcard_domain: 'apps.localhost' }).ok).toBe(true)
    expect(valid({}, { scheme: 'http', dns_mode: 'manual', wildcard_domain: null })).toMatchObject({
      code: 'BAD_SCHEME'
    })
  })

  it('SECRET_REQUIRED when the api or namespace changes but the token is kept', () => {
    const first = valid()
    if (!first.ok) throw new Error('setup')
    const existing = { id: 1, ...first.row }
    const moved = (cfg: Record<string, unknown>, secret?: unknown) =>
      T.validateTargetInput(
        { config: { ...first.row.config, ...cfg }, ...(secret !== undefined ? { secret } : {}) },
        existing
      )
    expect(moved({ api: 'https://other.example.com' })).toMatchObject({ code: 'SECRET_REQUIRED' })
    expect(moved({ api: 'https://other.example.com' }, HUB_MASK)).toMatchObject({
      code: 'SECRET_REQUIRED'
    })
    expect(moved({ namespace: 'elsewhere' })).toMatchObject({ code: 'SECRET_REQUIRED' })
    expect(moved({ namespace: 'elsewhere' }, 'glpat-new-token-for-elsewhere').ok).toBe(true)
    const kept = moved({ deploy_host: 'deploy@swarm-2' })
    expect(kept.ok && kept.row.secret).toBe(existing.secret)
  })
})

describe('target rows', () => {
  beforeEach(async () => {
    await db('nivaro_hub_apps').del()
    await db('nivaro_hub_targets').del()
  })

  it('create, list, get, update; the API view masks the token', async () => {
    const v = valid()
    if (!v.ok) throw new Error('setup')
    const row = await T.createTarget(v.row)
    expect(row.id).toBeGreaterThan(0)
    expect((await T.listTargets()).map((t) => t.name)).toEqual(['Main GitLab'])
    const got = await T.getTargetRow(row.id)
    expect(got?.config.namespace).toBe('apps')
    expect(got?.secret).toBe(v.row.secret)
    expect(T.publicTarget(got as NonNullable<typeof got>).secret).toBe(HUB_MASK)
    expect(JSON.stringify(T.publicTarget(got as NonNullable<typeof got>))).not.toContain('glpat')

    const upd = T.validateTargetInput({ name: 'Renamed' }, got ?? undefined)
    if (!upd.ok) throw new Error('update')
    await T.updateTarget(row.id, upd.row)
    expect((await T.getTargetRow(row.id))?.name).toBe('Renamed')
    expect(await T.updateTarget(9999, upd.row)).toBeNull()
    expect(await T.getTargetRow(9999)).toBeNull()
  })

  it('delete: NOT_FOUND, IN_USE while an app names it, then ok', async () => {
    const v = valid()
    if (!v.ok) throw new Error('setup')
    const row = await T.createTarget(v.row)
    await db('nivaro_hub_apps').insert({ key: 'demo', name: 'Demo', target_id: row.id })
    expect(await T.deleteTarget(9999)).toEqual({ ok: false, code: 'NOT_FOUND' })
    expect(await T.deleteTarget(row.id)).toEqual({ ok: false, code: 'IN_USE' })
    await db('nivaro_hub_apps').del()
    expect(await T.deleteTarget(row.id)).toEqual({ ok: true })
    expect(await T.getTargetRow(row.id)).toBeNull()
  })

  it('targetCtx: host without /api/v4, the template by default, the opened token', () => {
    const v = valid()
    if (!v.ok) throw new Error('setup')
    const row = { id: 3, ...v.row, secret: sealSecret('glpat-SECRET-ctx-token') }
    expect(T.targetCtx(row)).toEqual({
      provider: 'gitlab',
      base: 'https://gitlab.example.com',
      project: 'platform/hub-app-template',
      token: 'glpat-SECRET-ctx-token',
      ref: null
    })
    expect(T.targetCtx(row, 'apps/demo-deploy').project).toBe('apps/demo-deploy')
  })
})

describe('testTarget', () => {
  let gl: InstanceType<typeof FakeGitLab>
  let id: number
  beforeEach(async () => {
    await db('nivaro_hub_targets').del()
    gl = new FakeGitLab()
    gl.project('platform/hub-app-template')
    gl.namespace('apps')
    vi.stubGlobal('fetch', gl.fetch)
    const v = valid({ secret: gl.token }, { api: `${gl.base}/api/v4` })
    if (!v.ok) throw new Error('setup')
    id = (await T.createTarget(v.row)).id
  })

  it('all three checks pass', async () => {
    const r = await T.testTarget(id)
    expect(r.ok).toBe(true)
    expect(r.checks.map((c) => [c.id, c.ok])).toEqual([
      ['token', true],
      ['namespace', true],
      ['template', true]
    ])
    expect(r.checks[0].text).toContain('hub-bot')
    for (const c of gl.calls) expect(c.redirect).toBe('error')
  })

  it('a refused token fails the token check and skips the others', async () => {
    gl.token = 'glpat-rotated-elsewhere'
    const r = await T.testTarget(id)
    expect(r.ok).toBe(false)
    expect(r.checks.map((c) => [c.id, c.ok])).toEqual([
      ['token', false],
      ['namespace', false],
      ['template', false]
    ])
    expect(JSON.stringify(r)).not.toContain('glpat')
  })

  it('names the missing namespace', async () => {
    gl.namespaces.clear()
    const r = await T.testTarget(id)
    expect(r.ok).toBe(false)
    const ns = r.checks.find((c) => c.id === 'namespace')
    expect(ns).toMatchObject({ ok: false })
    expect(ns?.text).toContain('apps')
    expect(r.checks.find((c) => c.id === 'template')?.ok).toBe(true)
  })

  it('names the missing template', async () => {
    gl.projects.delete('platform/hub-app-template')
    const r = await T.testTarget(id)
    expect(r.checks.find((c) => c.id === 'template')).toMatchObject({ ok: false })
    expect(r.checks.find((c) => c.id === 'template')?.text).toContain('platform/hub-app-template')
    expect(r.checks.find((c) => c.id === 'token')?.ok).toBe(true)
  })

  it('an unknown target fails without calling GitLab', async () => {
    const r = await T.testTarget(424242)
    expect(r.ok).toBe(false)
    expect(gl.calls).toHaveLength(0)
  })
})

describe('fix round 1', () => {
  it('deploy_host: host, user@host, host:port; never a leading dash', () => {
    for (const h of [
      'swarm-1.internal',
      'deploy@swarm-1.internal',
      'deploy@10.0.0.5:2222',
      'host:22'
    ])
      expect(valid({}, { deploy_host: h }).ok).toBe(true)
    for (const h of ['-oProxyCommand=x', 'a b', 'host:port', 'a;b', '@host'])
      expect(valid({}, { deploy_host: h })).toMatchObject({ ok: false, code: 'BAD_CONFIG' })
  })

  it('api refuses user info, query and fragment', () => {
    for (const api of [
      'https://user:pass@gitlab.example.com',
      'https://user@gitlab.example.com',
      'https://gitlab.example.com/?private_token=x',
      'https://gitlab.example.com/#x'
    ])
      expect(valid({}, { api })).toMatchObject({ ok: false, code: 'BAD_CONFIG' })
  })

  it('wildcard needs two labels except localhost and test', () => {
    expect(valid({}, { wildcard_domain: 'example' })).toMatchObject({ code: 'BAD_WILDCARD' })
    expect(valid({}, { wildcard_domain: 'localhost' }).ok).toBe(true)
    expect(valid({}, { wildcard_domain: 'test' }).ok).toBe(true)
  })
})

describe('testTarget namespace rights', () => {
  let gl: InstanceType<typeof FakeGitLab>
  const make = async (namespace: string) => {
    await db('nivaro_hub_targets').del()
    const v = valid({ secret: gl.token }, { api: `${gl.base}/api/v4`, namespace })
    if (!v.ok) throw new Error('setup')
    return (await T.createTarget(v.row)).id
  }
  beforeEach(() => {
    gl = new FakeGitLab()
    gl.project('platform/hub-app-template')
    vi.stubGlobal('fetch', gl.fetch)
  })

  it('a group where the token user is below Maintainer fails the namespace check', async () => {
    gl.namespace('apps', 'group', 30)
    const r = await T.testTarget(await make('apps'))
    expect(r.ok).toBe(false)
    expect(r.checks.find((c) => c.id === 'namespace')?.text).toContain('Maintainer')
  })

  it('no membership at all fails too; Owner passes', async () => {
    gl.namespace('apps', 'group', null)
    expect((await T.testTarget(await make('apps'))).ok).toBe(false)
    gl.namespace('apps', 'group', 50)
    expect((await T.testTarget(await make('apps'))).ok).toBe(true)
  })

  it("the token user's own namespace passes; another user's fails", async () => {
    gl.namespace('hub-bot', 'user')
    expect((await T.testTarget(await make('hub-bot'))).ok).toBe(true)
    gl.namespace('someone', 'user')
    const r = await T.testTarget(await make('someone'))
    expect(r.checks.find((c) => c.id === 'namespace')).toMatchObject({ ok: false })
  })

  it('a 403 says scope or role', async () => {
    gl.namespace('apps')
    const id = await make('apps')
    const inner = gl.fetch
    vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) =>
      String(input).includes('/namespaces/')
        ? new Response('{}', { status: 403 })
        : inner(input, init)
    )
    const r = await T.testTarget(id)
    expect(r.checks.find((c) => c.id === 'namespace')?.text).toContain('scope or the role')
  })
})
