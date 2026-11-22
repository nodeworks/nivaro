import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 3: the name check. Pure part (create/name-check.ts): does the hostname resolve,
// and does <base_url>/api/version answer the expected version. Environment part
// (hub/name-check.ts): checkName(envId) on real SQLite rows; it clears `waiting_for_name` only
// for an environment no creation is walking.

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
const pure = await import('../../../services/hub/create/name-check.js')
const envCheck = await import('../../../services/hub/name-check.js')

type FetchJson = NonNullable<Parameters<typeof pure.checkName>[3]>['fetchJson']

const resolves = async () => [{ address: '10.0.0.5', family: 4 }]
const nxdomain = async () => {
  throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })
}
const serving =
  (version: string | null, status = 200): NonNullable<FetchJson> =>
  async () => ({ ok: status < 400, status, body: version === null ? {} : { version } })

describe('checkName (hostname, base URL, version)', () => {
  it('a name that does not resolve: resolves false, "does not resolve yet", no fetch', async () => {
    const fetchJson = vi.fn(serving('1.2.3'))
    const r = await pure.checkName(
      'demo.corp.example.com',
      'https://demo.corp.example.com',
      '1.2.3',
      {
        lookup: nxdomain,
        fetchJson
      }
    )
    expect(r).toMatchObject({ resolves: false, serves: false, version: null })
    expect(r.text).toContain('does not resolve yet')
    expect(r.text).toContain('demo.corp.example.com')
    expect(fetchJson).not.toHaveBeenCalled()
  })

  it('resolves but answers another version: serves false, both versions named', async () => {
    const r = await pure.checkName(
      'demo.corp.example.com',
      'https://demo.corp.example.com',
      '1.2.3',
      {
        lookup: resolves,
        fetchJson: serving('1.1.0')
      }
    )
    expect(r).toMatchObject({ resolves: true, serves: false, version: '1.1.0' })
    expect(r.text).toContain('1.1.0')
    expect(r.text).toContain('1.2.3')
  })

  it('resolves but nothing answers: serves false, names the version it waits for', async () => {
    const r = await pure.checkName(
      'demo.corp.example.com',
      'https://demo.corp.example.com',
      '1.2.3',
      {
        lookup: resolves,
        fetchJson: async () => {
          throw new Error('ECONNREFUSED')
        }
      }
    )
    expect(r).toMatchObject({ resolves: true, serves: false, version: null })
    expect(r.text).toMatch(/resolves but does not serve version 1\.2\.3/)
    const r404 = await pure.checkName(
      'demo.corp.example.com',
      'https://demo.corp.example.com',
      '1.2.3',
      {
        lookup: resolves,
        fetchJson: serving(null, 404)
      }
    )
    expect(r404.serves).toBe(false)
  })

  it('resolves and serves the version: both true', async () => {
    const r = await pure.checkName(
      'demo.corp.example.com',
      'https://demo.corp.example.com/',
      '1.2.3',
      {
        lookup: resolves,
        fetchJson: serving('1.2.3')
      }
    )
    expect(r).toMatchObject({ resolves: true, serves: true, version: '1.2.3' })
  })

  it('fetches <base>/api/version with redirect:error and no credentials', async () => {
    const fetchJson = vi.fn(serving('1.2.3'))
    await pure.checkName('demo.corp.example.com', 'https://demo.corp.example.com', '1.2.3', {
      lookup: resolves,
      fetchJson,
      timeoutMs: 1234
    })
    expect(fetchJson).toHaveBeenCalledTimes(1)
    const [url, headers, timeout, opts] = fetchJson.mock.calls[0] as unknown as [
      string,
      Record<string, string>,
      number,
      { redirect?: string }
    ]
    expect(url).toBe('https://demo.corp.example.com/api/version')
    expect(opts).toMatchObject({ redirect: 'error' })
    expect(timeout).toBe(1234)
    expect(Object.keys(headers).map((h) => h.toLowerCase())).not.toContain('authorization')
  })

  it('a redirect counts as not serving', async () => {
    const r = await pure.checkName(
      'demo.corp.example.com',
      'https://demo.corp.example.com',
      '1.2.3',
      {
        lookup: resolves,
        fetchJson: async () => {
          throw Object.assign(new Error('Redirect refused'), { code: 'FETCH_REDIRECT' })
        }
      }
    )
    expect(r.serves).toBe(false)
    expect(r.text).toMatch(/redirect/i)
  })

  it('a lookup that never answers is bounded by the timeout', async () => {
    const r = await pure.checkName(
      'demo.corp.example.com',
      'https://demo.corp.example.com',
      '1.2.3',
      {
        lookup: () => new Promise(() => {}),
        fetchJson: serving('1.2.3'),
        timeoutMs: 20
      }
    )
    expect(r.resolves).toBe(false)
  })

  it('a base URL that is not an http(s) origin is never fetched', async () => {
    const fetchJson = vi.fn(serving('1.2.3'))
    const r = await pure.checkName('demo.corp.example.com', 'file:///etc/passwd', '1.2.3', {
      lookup: resolves,
      fetchJson
    })
    expect(r.serves).toBe(false)
    expect(fetchJson).not.toHaveBeenCalled()
  })
})

describe('checkName(envId)', () => {
  let appId: number

  beforeAll(async () => {
    await m542.up(db)
    await m543.up(db)
    await m544.up(db)
    await m545.up(db)
  })
  afterAll(async () => {
    await db.destroy()
  })
  beforeEach(async () => {
    await db('nivaro_hub_creations').del()
    await db('nivaro_hub_environments').del()
    await db('nivaro_hub_apps').del()
    await db('nivaro_hub_apps').insert({ key: 'demo', name: 'Demo', signin_mode: 'direct' })
    appId = Number((await db('nivaro_hub_apps').first('id')).id)
  })

  async function env(status: string, versionPin: string | null = '1.2.3') {
    await db('nivaro_hub_environments').insert({
      app_id: appId,
      key: 'production',
      position: 0,
      status,
      base_url: 'https://demo.corp.example.com',
      hostnames: JSON.stringify(['demo.corp.example.com']),
      version_pin: versionPin
    })
    return Number((await db('nivaro_hub_environments').first('id')).id)
  }

  const statusOf = async (id: number) =>
    String((await db('nivaro_hub_environments').where({ id }).first('status')).status)

  it('waiting while the name does not resolve; the status stays', async () => {
    const id = await env('waiting_for_name')
    const out = await envCheck.checkName(id, { lookup: nxdomain, fetchJson: serving('1.2.3') })
    expect(out).toBe('waiting')
    expect(await statusOf(id)).toBe('waiting_for_name')
    const detail = await envCheck.checkEnvironmentName(id, {
      lookup: nxdomain,
      fetchJson: serving('1.2.3')
    })
    expect(detail?.check.text).toContain('does not resolve yet')
  })

  it('waiting while an old version answers (resolves, wrong version)', async () => {
    const id = await env('waiting_for_name')
    expect(await envCheck.checkName(id, { lookup: resolves, fetchJson: serving('1.0.0') })).toBe(
      'waiting'
    )
    expect(await statusOf(id)).toBe('waiting_for_name')
  })

  it('ok once it serves: a waiting environment no creation walks becomes active', async () => {
    const id = await env('waiting_for_name')
    expect(await envCheck.checkName(id, { lookup: resolves, fetchJson: serving('1.2.3') })).toBe(
      'ok'
    )
    expect(await statusOf(id)).toBe('active')
  })

  it('an open creation keeps the status: the creation runner moves it on', async () => {
    const id = await env('waiting_for_name', null)
    await db('nivaro_hub_creations').insert({
      app_id: appId,
      environment_id: id,
      status: 'waiting',
      waiting_for: 'name',
      steps: '[]',
      version: '1.2.3',
      first_admin: '{"email":"ada@example.com"}',
      created_at: new Date(),
      updated_at: new Date()
    })
    // The creation's version is the one expected (the env has no pin yet).
    expect(await envCheck.checkName(id, { lookup: resolves, fetchJson: serving('1.0.0') })).toBe(
      'waiting'
    )
    expect(await envCheck.checkName(id, { lookup: resolves, fetchJson: serving('1.2.3') })).toBe(
      'ok'
    )
    expect(await statusOf(id)).toBe('waiting_for_name')
  })

  it('markWaitingForName sets the status; an unknown environment is waiting', async () => {
    const id = await env('active')
    await envCheck.markWaitingForName(id)
    expect(await statusOf(id)).toBe('waiting_for_name')
    expect(
      await envCheck.checkName(999_999, { lookup: resolves, fetchJson: serving('1.2.3') })
    ).toBe('waiting')
  })
})
