import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Hub enhancement 46, Hub side: "Copy this app's structure" reads the source's structure export
// over its link (faked here), keeps it as an ordinary library template — so Create app installs it
// through the one template step — and records where it came from. The Hub scrubs again: a source
// that left a credential (an older or broken one) still never puts it in the library.

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
vi.mock('../../../services/hub/secrets.js', async (orig) => ({
  ...(await orig<object>()),
  openSecret: vi.fn(() => 'plain-hub-token-0123456789abcdef0123')
}))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const clone = await import('../../../services/hub/lifecycle/clone.js')
const library = await import('../../../services/hub/templates/library.js')

const MIGRATIONS = join(import.meta.dirname, '../../../db/migrations')

function pkg(extra: Record<string, unknown> = {}) {
  return {
    type: 'nivaro-blueprint-package',
    version: 1,
    manifest: { name: 'x', nivaro_version: '0.3.215', counts: {} },
    blueprint: {
      type: 'nivaro-blueprint',
      version: 1,
      name: 'Structure of shop',
      exported_at: '2026-11-25T00:00:00.000Z',
      collections: [
        { meta: { collection: 'orders' }, fields: [{ field: 'title', type: 'string' }] }
      ],
      relations: [],
      workflows: [],
      layouts: [],
      queues: [],
      rules: [],
      roles: [],
      flows: [
        {
          flow: {
            id: '22222222-3333-4444-8555-666666666666',
            name: 'Post',
            status: 'active',
            trigger: 'manual'
          },
          operations: [
            {
              id: '33333333-4444-4555-8666-777777777777',
              key: 'post',
              name: 'Post',
              type: 'webhook',
              options: JSON.stringify({ headers: { Authorization: 'Bearer left-by-old-source' } })
            }
          ]
        }
      ],
      ...extra
    }
  }
}

beforeAll(async () => {
  for (const f of readdirSync(MIGRATIONS)
    .filter((x) => /^5[4-9]\d_hub_.*\.ts$/.test(x))
    .sort())
    await ((await import(join(MIGRATIONS, f))) as { up: (k: Knex) => Promise<void> }).up(db)
  await db('nivaro_hub_apps').insert({ id: 1, key: 'shop', name: 'Shop' })
  await db('nivaro_hub_environments').insert({
    id: 4,
    app_id: 1,
    key: 'production',
    status: 'active',
    base_url: 'https://shop.test',
    hub_token: 'sealed'
  })
})

afterAll(async () => {
  await db.destroy()
})

describe('captureClone', () => {
  it('reads the structure export over the hub link and keeps it as a library template', async () => {
    const seen: Array<{ url: string; bearer: string }> = []
    const out = await clone.captureClone(4, 'aaaaaaaa-0000-4000-8000-000000000001', {
      version: async () => '0.3.215',
      now: () => new Date('2026-11-25T14:30:05Z'),
      fetch: async (src) => {
        seen.push({ url: src.url, bearer: src.bearer })
        return {
          status: 200,
          body: { package: pkg(), scrubbed: ['flows[Post].x'], version: '0.3.215' }
        }
      }
    })
    expect(seen).toEqual([
      {
        url: 'https://shop.test/api/hub-link/clone/blueprint',
        bearer: 'plain-hub-token-0123456789abcdef0123'
      }
    ])
    expect(out.template.name).toBe('Clone of shop · production')
    expect(out.template.version).toBe('clone-20261125-143005')
    expect(out.clone.source).toEqual({ app_key: 'shop', app_name: 'Shop', env_key: 'production' })
    expect(out.clone.source_version).toBe('0.3.215')
    // The Hub's own pass emptied what the "old" source left, and the flow is inactive.
    const stored = await library.readTemplateBundle(out.template.id)
    const json = JSON.stringify(stored?.bundle)
    expect(json).not.toContain('left-by-old-source')
    expect(stored?.bundle.blueprint.flows?.[0].flow.status).toBe('inactive')
    expect(out.clone.scrubbed).toContain('flows[Post].x')
    expect(out.clone.scrubbed_count).toBe(2)
    const listed = await clone.listClones()
    expect(listed.map((c) => c.template?.name)).toEqual(['Clone of shop · production'])
  })

  it('refuses a source older than 0.3.215, by its status or by a 404', async () => {
    await expect(
      clone.captureClone(4, null, { version: async () => '0.3.210', fetch: vi.fn() })
    ).rejects.toMatchObject({ code: 'SOURCE_TOO_OLD' })
    await expect(
      clone.captureClone(4, null, {
        version: async () => null,
        fetch: async () => ({ status: 404, body: { statusCode: 404 } })
      })
    ).rejects.toMatchObject({ code: 'SOURCE_TOO_OLD' })
  })

  it('answers the source’s refusals in its own words, never the app text', async () => {
    const refused = (status: number, code?: string) =>
      clone.captureClone(4, null, {
        version: async () => '0.3.215',
        fetch: async () => ({ status, body: { code, message: 'internal driver text' } })
      })
    await expect(refused(401)).rejects.toMatchObject({ code: 'SOURCE_REFUSED' })
    await expect(refused(413, 'TOO_LARGE')).rejects.toMatchObject({ code: 'TOO_LARGE' })
    await expect(refused(409, 'NOTHING_TO_CLONE')).rejects.toMatchObject({
      code: 'NOTHING_TO_CLONE'
    })
    await expect(refused(500)).rejects.toMatchObject({ code: 'SOURCE_SAID_NO' })
    await expect(refused(500)).rejects.not.toThrow(/internal driver text/)
  })

  it('reads a dedicated source on its hub link; an unknown environment is refused', async () => {
    const src = await clone.cloneSourceOf(4)
    expect(src.kind).toBe('dedicated')
    await expect(clone.cloneSourceOf(999)).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
