import type { Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Nivaro Hub phase 6, Task 16 fix round 1 (P6-19 C-2, P6-18 #1 #2): the addresses a move reaches
// each dedicated side on are resolved and probed at start (services/hub/move/addresses.ts).
// Real SQLite; the agent, the hub link and DNS are fakes.

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
const migrations = [
  await import('../../../db/migrations/542_hub_tables.js'),
  await import('../../../db/migrations/543_hub_promotions.js'),
  await import('../../../db/migrations/544_hub_databases.js'),
  await import('../../../db/migrations/545_hub_creations.js'),
  await import('../../../db/migrations/546_hub_stack_settings.js'),
  await import('../../../db/migrations/550_hub_oidc.js'),
  await import('../../../db/migrations/551_hub_signins.js'),
  await import('../../../db/migrations/552_hub_shared_deployments.js'),
  await import('../../../db/migrations/553_hub_moves.js')
]
const { resolveMoveAddresses } = await import('../../../services/hub/move/addresses.js')
const { sealSecret } = await import('../../../services/hub/secrets.js')

const saved = { HUB: process.env.HUB, KEY: process.env.ENCRYPTION_KEY }
const TOKEN = 'hub-link-Token-0123456789-abcdefghijklmnop'

async function insertId(table: string, row: Record<string, unknown>): Promise<number> {
  const [r] = await db(table).insert(row).returning('id')
  return Number(typeof r === 'object' ? (r as { id: number }).id : r)
}

let n = 0
async function placementOf(
  kind: 'gitlab' | 'docker' | 'shared',
  o: { verify?: string; linkUrl?: string } = {}
): Promise<number> {
  n++
  if (kind === 'shared') {
    const sid = await insertId('nivaro_hub_shared_deployments', {
      key: `s${n}`,
      name: 's',
      link_url: o.linkUrl ?? 'https://link.public.example.com',
      status: 'active'
    })
    return insertId('nivaro_hub_placements', {
      kind: 'shared',
      shared_deployment_id: sid,
      target: '{}'
    })
  }
  const driver = await insertId('nivaro_hub_drivers', {
    kind,
    name: `d${n}`,
    config: JSON.stringify(
      kind === 'docker' ? { agent_url: 'https://agent.example.com' } : { api_url: 'https://g' }
    )
  })
  const p = await insertId('nivaro_hub_placements', {
    kind: 'dedicated',
    driver_id: driver,
    target: JSON.stringify(kind === 'docker' ? { stack: `st${n}` } : {})
  })
  if (kind === 'gitlab' && o.verify)
    await insertId('nivaro_hub_components', {
      placement_id: p,
      position: 0,
      name: 'api',
      kind: 'api',
      driver_id: driver,
      verify_url: o.verify
    })
  return p
}

async function envOn(placement: number, baseUrl = 'https://acme.example.com'): Promise<number> {
  const app = await insertId('nivaro_hub_apps', { key: `a${++n}`, name: 'A' })
  return insertId('nivaro_hub_environments', {
    app_id: app,
    key: 'prod',
    status: 'active',
    base_url: baseUrl,
    hostnames: '[]',
    placement_id: placement,
    hub_token: sealSecret(TOKEN)
  })
}

function deps(
  o: { edge?: 'traefik' | 'publish'; dns?: Record<string, string[]>; linkDown?: boolean } = {}
) {
  const bases: string[] = []
  return {
    bases,
    deps: {
      agent: {
        agentHealth: vi.fn(async () => ({
          edge: o.edge ?? 'traefik',
          host_suffixes: ['apps.example.com']
        })) as never,
        agentStack: vi.fn(async () => ({ published_port: 30123 })) as never
      },
      link: (base: string, token: string | null) => {
        bases.push(base)
        expect(token).toBe(TOKEN)
        return {
          status: async () => {
            if (o.linkDown) throw new Error('down')
            return {
              version: '0.3.210',
              maintenance: false,
              retired: false,
              preflight: { status: 'ok', failing: [] }
            }
          }
        } as never
      },
      resolve: async (host: string) => {
        if (o.dns && host in o.dns) {
          if (!o.dns[host].length) throw new Error('ENOTFOUND')
          return o.dns[host]
        }
        return ['93.184.216.34']
      },
      nonce: () => 'abcd1234'
    }
  }
}

beforeAll(async () => {
  process.env.HUB = 'on'
  process.env.ENCRYPTION_KEY = 'e'.repeat(64)
  for (const m of migrations) await m.up(db)
})
afterAll(async () => {
  process.env.HUB = saved.HUB
  process.env.ENCRYPTION_KEY = saved.KEY
  await db.destroy()
})

const err = async (p: Promise<unknown>) => p.then(() => null).catch((e) => e as { code: string })

describe('source addresses (C-2)', () => {
  it('a GitLab source is reached on its API check address, probed now', async () => {
    const env = await envOn(
      await placementOf('gitlab', { verify: 'https://acme-direct.example.com/api/version' })
    )
    const target = await placementOf('shared')
    const d = deps()
    const a = await resolveMoveAddresses(
      env,
      { kind: 'shared', shared_id: 1 },
      { routing: 'manual' },
      d.deps
    )
    void target
    expect(a).toMatchObject({
      source_link_base: 'https://acme-direct.example.com',
      source_link_public: false,
      pull_source: 'https://acme-direct.example.com'
    })
    expect(d.bases).toEqual(['https://acme-direct.example.com'])
  })

  it('a GitLab source whose only address is its public name → SOURCE_UNREACHABLE', async () => {
    const env = await envOn(
      await placementOf('gitlab', { verify: 'https://acme.example.com/api/version' })
    )
    const e = await err(
      resolveMoveAddresses(
        env,
        { kind: 'shared', shared_id: 1 },
        { routing: 'manual' },
        deps().deps
      )
    )
    expect(e?.code).toBe('SOURCE_UNREACHABLE')
  })

  it('a Docker traefik source: the public name only with automatic routing; manual → SOURCE_UNREACHABLE', async () => {
    const env = await envOn(await placementOf('docker'))
    const a = await resolveMoveAddresses(
      env,
      { kind: 'shared', shared_id: 1 },
      { routing: 'automatic' },
      deps().deps
    )
    expect(a).toMatchObject({
      source_link_base: 'https://acme.example.com',
      source_link_public: true
    })
    const e = await err(
      resolveMoveAddresses(
        env,
        { kind: 'shared', shared_id: 1 },
        { routing: 'manual' },
        deps().deps
      )
    )
    expect(e?.code).toBe('SOURCE_UNREACHABLE')
  })

  it('a source that does not answer its hub link now → SOURCE_UNREACHABLE', async () => {
    const env = await envOn(
      await placementOf('gitlab', { verify: 'https://acme-direct.example.com/api/version' })
    )
    const e = await err(
      resolveMoveAddresses(
        env,
        { kind: 'shared', shared_id: 1 },
        { routing: 'manual' },
        deps({ linkDown: true }).deps
      )
    )
    expect(e?.code).toBe('SOURCE_UNREACHABLE')
  })
})

describe('shared source pull rule (P6-18 #2)', () => {
  it('a link name that resolves privately → LINK_URL_NOT_PULLABLE; a private IP literal or a public name passes; no hub token sent', async () => {
    const target = await placementOf('docker')
    const bad = await envOn(
      await placementOf('shared', { linkUrl: 'https://src.internal.example.com' })
    )
    const d1 = deps({ dns: { 'src.internal.example.com': ['10.0.0.5'] } })
    const e = await err(
      resolveMoveAddresses(
        bad,
        { kind: 'dedicated', placement_id: target },
        { routing: 'automatic' },
        d1.deps
      )
    )
    expect(e?.code).toBe('LINK_URL_NOT_PULLABLE')
    expect(d1.bases).toEqual([])
    // P6-20 #2: the operator's override (the target allows this host) lets it through.
    const over = await resolveMoveAddresses(
      bad,
      { kind: 'dedicated', placement_id: target },
      { routing: 'automatic' },
      d1.deps,
      { allowUnpullable: true }
    )
    expect(over.pull_source).toBe('https://src.internal.example.com')
    const literal = await envOn(await placementOf('shared', { linkUrl: 'http://10.0.0.5:3140' }))
    const a = await resolveMoveAddresses(
      literal,
      { kind: 'dedicated', placement_id: target },
      { routing: 'automatic' },
      deps().deps
    )
    expect(a.pull_source).toBe('http://10.0.0.5:3140')
    expect(a.source_link_base).toBeNull()
  })
})

describe('target addresses (P6-18 #1)', () => {
  it('a Docker traefik target gets a per-move name that must resolve; never the public name', async () => {
    const env = await envOn(await placementOf('shared'))
    const target = await placementOf('docker')
    const a = await resolveMoveAddresses(
      env,
      { kind: 'dedicated', placement_id: target },
      { routing: 'automatic' },
      deps().deps
    )
    expect(a.target_temp_host).toBe(`hub-move-e${env}-abcd1234.apps.example.com`)
    expect(a.target_link_base).toBe(`https://hub-move-e${env}-abcd1234.apps.example.com`)
    const noDns = deps({ dns: { [`hub-move-e${env}-abcd1234.apps.example.com`]: [] } })
    const e = await err(
      resolveMoveAddresses(
        env,
        { kind: 'dedicated', placement_id: target },
        { routing: 'automatic' },
        noDns.deps
      )
    )
    expect(e?.code).toBe('TARGET_UNREACHABLE')
  })

  // E2E B3: the per-move name is served on the edge entrypoint of the public name, so it keeps
  // the public address's scheme and port (an edge that is not on 443).
  it('B3: the per-move address keeps the public address’s scheme and port (an edge off 443)', async () => {
    const env = await envOn(await placementOf('shared'), 'https://acme.example.com:18443/app')
    const target = await placementOf('docker')
    const a = await resolveMoveAddresses(
      env,
      { kind: 'dedicated', placement_id: target },
      { routing: 'automatic' },
      deps().deps
    )
    expect(a.target_temp_host).toBe(`hub-move-e${env}-abcd1234.apps.example.com`)
    expect(a.target_link_base).toBe(`https://hub-move-e${env}-abcd1234.apps.example.com:18443`)
  })

  it('a GitLab target with no check address of its own → TARGET_UNREACHABLE', async () => {
    const env = await envOn(await placementOf('shared'))
    const target = await placementOf('gitlab', { verify: 'https://acme.example.com/api/version' })
    const e = await err(
      resolveMoveAddresses(
        env,
        { kind: 'dedicated', placement_id: target },
        { routing: 'manual' },
        deps().deps
      )
    )
    expect(e?.code).toBe('TARGET_UNREACHABLE')
  })

  it('a publish-edge target off this machine → TARGET_UNREACHABLE (no hub token over plain http)', async () => {
    const env = await envOn(await placementOf('shared'))
    const target = await placementOf('docker')
    const e = await err(
      resolveMoveAddresses(
        env,
        { kind: 'dedicated', placement_id: target },
        { routing: 'automatic' },
        deps({ edge: 'publish' }).deps
      )
    )
    expect(e?.code).toBe('TARGET_UNREACHABLE')
  })
})

describe('STACK_REAPPLY_ALL (P6-18 #3)', () => {
  it('a name change on a docker-mode shared stack warns that every app on it restarts', async () => {
    const { withReapplyWarning } = await import('../../../services/hub/move/plan-port.js')
    const sid = await insertId('nivaro_hub_shared_deployments', {
      key: `dock${++n}`,
      name: 'd',
      mode: 'docker',
      link_url: 'https://dock.example.com',
      status: 'active'
    })
    const env = await envOn(await placementOf('docker'))
    const base = {
      kind: 'to_shared' as const,
      routing: 'automatic' as const,
      steps: [],
      route: [{ side: 'target' as const, op: 'add_host' as const, host: 'acme.example.com' }],
      manual_request: null,
      version: '0.3.210',
      hostnames: ['acme.example.com'],
      files: { count: 0, bytes: 0, first_pull: 'full' as const },
      blockers: [],
      warnings: [],
      checklist: [],
      plan_hash: 'h'
    }
    const warned = await withReapplyWarning(base, env, { kind: 'shared', shared_id: sid })
    expect(warned.warnings.map((w) => w.code)).toEqual(['STACK_REAPPLY_ALL'])
    expect(warned.plan_hash).toBe('h')
    const none = await withReapplyWarning({ ...base, route: [] }, env, {
      kind: 'shared',
      shared_id: sid
    })
    expect(none.warnings).toEqual([])
  })
})

describe('GitLab boot maintenance proof (P6-20 gather)', () => {
  it('forwarded only for a Hub-created app whose pinned template carries it in the CI, the manager wrapper and the stack file (R2-M-1)', async () => {
    const { bootMaintenanceForwarded } = await import('../../../services/hub/move/gather.js')
    const env = await envOn(await placementOf('shared'))
    const appId = (await db('nivaro_hub_environments').where({ id: env }).first('app_id')).app_id
    const NEW: Record<string, string> = {
      'ci/deploy.yml': 'deploy.sh … HUB_BOOT_MAINTENANCE …',
      'manager/nivaro-hub-deploy': '… the stack file does not pass HUB_BOOT_MAINTENANCE …',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a compose placeholder, literally
      'manager/docker-stack.yml': 'HUB_BOOT_MAINTENANCE: ${HUB_BOOT_MAINTENANCE:-}'
    }
    const ask = (files: Record<string, string | null>) =>
      bootMaintenanceForwarded({
        envId: env,
        deps: { templateFile: async (_t: number, path: string) => files[path] ?? null }
      })
    // An adopted app (no Hub target): never proven.
    expect(await ask(NEW)).toBe('unproven')
    await db('nivaro_hub_apps').where({ id: appId }).update({ target_id: 3 })
    expect(await ask(NEW)).toBe('forwarded')
    for (const path of Object.keys(NEW)) {
      expect(await ask({ ...NEW, [path]: 'an older revision' }), path).toBe('unproven')
      expect(await ask({ ...NEW, [path]: null }), path).toBe('unproven')
    }
    expect(
      await bootMaintenanceForwarded({
        envId: env,
        deps: {
          templateFile: async () => {
            throw new Error('gitlab down')
          }
        }
      })
    ).toBe('unproven')
  })

  it('the shipped template carries every marker the proof reads', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { BOOT_MAINTENANCE_PROOF } = await import('../../../services/hub/move/gather.js')
    for (const [path, marker] of Object.entries(BOOT_MAINTENANCE_PROOF)) {
      const text = readFileSync(
        join(import.meta.dirname, '../../../../../deploy/hub-app-template', path),
        'utf8'
      )
      expect(text, path).toContain(marker)
    }
  })
})
