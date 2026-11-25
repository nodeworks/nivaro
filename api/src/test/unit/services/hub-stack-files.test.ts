import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub agent 0.2.2: where a Docker stack keeps its files — stack settings uploads_folder,
// files_subfolder and run_as (migration 555), the renderer that sends them only to an agent that
// takes them, and the multi-node volume judgement that an NFS export ends.

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
const { up: up542 } = await import('../../../db/migrations/542_hub_tables.js')
const { up: up546 } = await import('../../../db/migrations/546_hub_stack_settings.js')
const { up: up551 } = await import('../../../db/migrations/551_hub_signins.js')
const { up: up555 } = await import('../../../db/migrations/555_hub_stack_files.js')
const S = await import('../../../services/hub/docker/stack-settings.js')
const { renderStackSpec, StackRenderError } = await import(
  '../../../services/hub/docker/render-spec.js'
)
const { volumesPerNode, STACK_FILES_AGENT_MIN_VERSION } = await import(
  '../../../services/hub/docker/templates.js'
)
// The agent's own modules, loaded by path (they sit outside the API's rootDir).
const agentModule = (f: string) =>
  import(
    /* @vite-ignore */ pathToFileURL(
      resolve(import.meta.dirname, `../../../../../packages/hub-agent/src/${f}`)
    ).href
  )
const { validateStackSpec } = (await agentModule('spec.ts')) as {
  validateStackSpec: (
    body: unknown,
    cfg: Record<string, unknown>
  ) => { ok: true } | { ok: false; fields: Array<{ field: string; code: string }> }
}
const { environmentFromRow } = await import('../../../services/hub/apps.js')

type Env = import('../../../services/hub/promote-types.js').HubEnvironmentRow
type RenderInput = Parameters<typeof renderStackSpec>[0]

const KEY = 'a'.repeat(64)
const driver = {
  agent_url: 'https://agent.example.com',
  dns_mode: 'automatic' as const,
  wildcard_domain: 'apps.example.com',
  edge_target: null
}

let n = 0
let prevKey: string | undefined
async function newEnv(): Promise<Env> {
  const [row] = await db('nivaro_hub_environments')
    .insert({
      app_id: 1,
      key: `f${++n}`,
      base_url: `https://f${n}.apps.example.com`,
      hostnames: '[]'
    })
    .returning('id')
  const id = typeof row === 'object' ? (row as { id: number }).id : row
  return environmentFromRow(await db('nivaro_hub_environments').where({ id }).first()) as Env
}
async function validate(env: Env, body: Record<string, unknown>) {
  return S.validateStackSettings(body, await S.readStackSettings(env.id), { driver, env })
}
async function save(env: Env, body: Record<string, unknown>) {
  const v = await validate(env, body)
  if (!v.ok) throw new Error(`${v.code}: ${v.message}`)
  return S.saveStackSettings(env.id, v.row.fields, v.row.extension_pins)
}

describe('stack settings: files (migration 555)', () => {
  beforeAll(async () => {
    prevKey = process.env.ENCRYPTION_KEY
    process.env.ENCRYPTION_KEY = KEY
    await up542(db)
    await up546(db)
    await up551(db)
  })
  afterAll(async () => {
    if (prevKey === undefined) delete process.env.ENCRYPTION_KEY
    else process.env.ENCRYPTION_KEY = prevKey
    await db.destroy()
  })
  beforeEach(() => {
    process.env.ENCRYPTION_KEY = KEY
  })

  it('a database behind 555 still saves and reads a stack that sets none', async () => {
    const env = await newEnv()
    const row = await save(env, { size: 'small' })
    expect(row.files).toEqual(S.DEFAULT_STACK_FILES)
    await save(env, { size: 'medium', run_as: 'image', uploads_folder: null })
    expect((await S.readStackSettings(env.id))?.size).toBe('medium')
  })

  it('saves, reads, keeps and clears them', async () => {
    await up555(db)
    const env = await newEnv()
    const row = await save(env, {
      uploads_folder: ' efp ',
      files_subfolder: 'directus-uploads',
      run_as: 'app'
    })
    expect(row.files).toEqual({
      uploads_folder: 'efp',
      files_subfolder: 'directus-uploads',
      run_as: 'app'
    })
    expect(S.publicStackSettings(row)?.files).toEqual(row.files)
    // A save that does not name them keeps them (the Stack panel's other fields).
    expect((await save(env, { size: 'large' })).files?.uploads_folder).toBe('efp')
    // A move's / a secret's save passes no files at all: kept too.
    const before = await S.readStackSettings(env.id)
    await S.setStackSecret(env.id, 'DB_PASSWORD', 'pw-xyz-123')
    expect((await S.readStackSettings(env.id))?.files).toEqual(before?.files)
    // null / '' clears; image is the default.
    const cleared = await save(env, { uploads_folder: '', files_subfolder: null, run_as: 'image' })
    expect(cleared.files).toEqual(S.DEFAULT_STACK_FILES)
    expect(
      (await db('nivaro_hub_stack_settings').where({ environment_id: env.id }).first()).run_as
    ).toBeNull()
  })

  it('refuses a path that could leave the export, and a run_as it does not know', async () => {
    const env = await newEnv()
    for (const v of ['..', '../x', '/abs', 'a//b', '.x', 'a/', 'a b', 7]) {
      const u = await validate(env, { uploads_folder: v })
      expect(u.ok ? null : [u.code, u.field], String(v)).toEqual([
        'BAD_UPLOADS_FOLDER',
        { kind: 'uploads_folder' }
      ])
      const f = await validate(env, { files_subfolder: v })
      expect(f.ok ? null : f.code, String(v)).toBe('BAD_FILES_SUBFOLDER')
    }
    const r = await validate(env, { run_as: 'root' })
    expect(r.ok ? null : [r.code, r.field]).toEqual(['BAD_RUN_AS', { kind: 'run_as' }])
  })

  it('the folder rule is the agent rule (twins)', async () => {
    const { folderOk } = (await agentModule('volumes.ts')) as { folderOk: (v: unknown) => boolean }
    for (const v of [
      'a',
      'a/b',
      'A1._-z',
      '..',
      'a/..',
      '.x',
      '/a',
      'a/',
      '',
      'x'.repeat(65),
      'a/b/c/d/e/f/g/h/i'
    ])
      expect(S.folderPathOk(v), v).toBe(folderOk(v))
  })
})

describe('renderStackSpec: files', () => {
  const readJson = (rel: string) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'))
  const FIXTURE = readJson('../../fixtures/hub-render-input.json') as RenderInput
  const EXAMPLE = readJson('../../../../../packages/hub-agent/contract/stack-spec.example.json')
  const files = (
    over: Partial<import('../../../services/hub/docker/stack-settings.js').StackFiles>
  ) => ({
    ...S.DEFAULT_STACK_FILES,
    ...over
  })
  const input = (over: Partial<RenderInput>, f = files({})): RenderInput => ({
    ...structuredClone(FIXTURE),
    agentVersion: STACK_FILES_AGENT_MIN_VERSION,
    ...over,
    row: { ...structuredClone(FIXTURE.row), files: f }
  })
  const codeOf = (i: RenderInput) => {
    try {
      renderStackSpec(i)
      return null
    } catch (err) {
      expect(err).toBeInstanceOf(StackRenderError)
      return (err as InstanceType<typeof StackRenderError>).code
    }
  }

  it('no files set: the spec is exactly what it was, on any agent', () => {
    expect(renderStackSpec(input({ agentVersion: '0.2.0' }))).toEqual(EXAMPLE)
  })

  it('sends them to a 0.2.3 agent with an NFS export, and the agent takes the spec', () => {
    const spec = renderStackSpec(
      input(
        { agentVolumeNfs: true },
        files({ uploads_folder: 'efp', files_subfolder: 'directus-uploads', run_as: 'app' })
      )
    )
    expect(spec).toMatchObject({
      uploads_folder: 'efp',
      files_subfolder: 'directus-uploads',
      run_as: 'app'
    })
    const r = validateStackSpec(spec, {
      images: ['nodeworks/nivaro', 'registry.example.com/acme/tools-ext'],
      edge: 'traefik',
      hostSuffixes: ['.apps.example.com'],
      publishPorts: null,
      redisImage: `redis@sha256:${'a'.repeat(64)}`,
      volumeOpts: { type: 'nfs', o: 'addr=nas', device: ':/volume1/nivaro' }
    })
    expect(r.ok ? [] : r.fields).toEqual([])
  })

  it('AGENT_TOO_OLD below 0.2.3 (or unknown), UPLOADS_FOLDER_NEEDS_NFS, EXPORT_MOUNT_MISSING', () => {
    for (const v of ['0.2.1', '0.2.2', null, 'dev'])
      expect(codeOf(input({ agentVersion: v }, files({ run_as: 'app' }))), String(v)).toBe(
        'AGENT_TOO_OLD'
      )
    expect(codeOf(input({ agentVolumeNfs: false }, files({ uploads_folder: 'efp' })))).toBe(
      'UPLOADS_FOLDER_NEEDS_NFS'
    )
    // L3: an agent on NFS that does not see its export cannot deploy any stack: the plan says so.
    expect(codeOf(input({ agentVolumeNfs: true, agentExportMount: false }))).toBe(
      'EXPORT_MOUNT_MISSING'
    )
    expect(codeOf(input({ agentVolumeNfs: true, agentExportMount: true }))).toBeNull()
    // A files sub-folder and run_as need no export.
    expect(codeOf(input({}, files({ files_subfolder: 'x', run_as: 'app' })))).toBeNull()
  })
})

describe('volumesPerNode (P4-33 with agent 0.2.2)', () => {
  it('only local volumes on a swarm of several nodes, not on an NFS export', () => {
    const h = (nodes: number | null, volume_driver?: string, volume_nfs?: boolean) => ({
      swarm: { nodes },
      volume_driver,
      volume_nfs
    })
    expect(volumesPerNode(h(3))).toBe(3)
    expect(volumesPerNode(h(3, 'local'))).toBe(3)
    expect(volumesPerNode(h(3, 'local', false))).toBe(3)
    expect(volumesPerNode(h(3, 'local', true))).toBeNull()
    expect(volumesPerNode(h(3, 'rexray'))).toBeNull()
    expect(volumesPerNode(h(1))).toBeNull()
    expect(volumesPerNode(h(null))).toBeNull()
    expect(volumesPerNode(null)).toBeNull()
  })
})
