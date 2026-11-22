import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { lexSource, listSourceFiles } from '../cloud-flag-scan.js'

// Hub phase 5, ruling P5-9: a Hub shared deployment (one process, many apps) schedules the core
// jobs. Each one it registers declares its scope ('app' fans out per app, 'process' runs once);
// the few that only make sense self-hosted are left out. Nivaro Cloud registers none of the
// server.ts jobs, exactly as before, and self-hosted is unchanged.

vi.mock('../../../services/job-runs.js', () => ({
  startJobRun: vi.fn(async () => ({
    id: 1,
    complete: async () => {},
    fail: async () => {},
    progress: () => {}
  }))
}))
vi.mock('../../../db/index.js', () => {
  const chain = { where: () => chain, first: async () => undefined }
  return { db: () => chain, _backgroundDb: null, _staticDb: null }
})

const { CronManager } = await import('../../../plugins/cron.js')
const { CORE_CRON_SCOPES, NO_DEPLOYMENT_STORE_CRONS, SELF_HOSTED_ONLY_CRONS, explicitCronScope } =
  await import('../../../services/cron-scope.js')
const { isMultiTenant, perAppJobs } = await import('../../../services/deployment-mode.js')

const SELF_HOSTED: Record<string, string> = {}
const CLOUD: Record<string, string> = { CLOUD_META_DB_URL: 'postgres://meta/x' }
const SHARED: Record<string, string> = {
  HUB_SHARED_DEPLOYMENT: 'shared-a',
  HUB_URL: 'https://hub.example',
  HUB_DEPLOYMENT_TOKEN: 'x'.repeat(32)
}
const KEYS = ['CLOUD_META_DB_URL', 'HUB_SHARED_DEPLOYMENT', 'HUB_URL', 'HUB_DEPLOYMENT_TOKEN']
const saved = { ...process.env }
function useEnv(env: Record<string, string>) {
  for (const k of KEYS) delete process.env[k]
  Object.assign(process.env, env)
}

type Manager = InstanceType<typeof CronManager>
const managers: Manager[] = []
function make(): Manager {
  const m = new CronManager({ ticksEnabled: () => false, onIssue: () => {} })
  managers.push(m)
  return m
}
const noop = async () => {}

beforeEach(() => useEnv(SELF_HOSTED))
afterEach(() => {
  for (const m of managers.splice(0)) m.stopAll()
  process.env = { ...saved }
})

// ── The outer gates in server.ts ──────────────────────────────────────────────────────────────

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '../../..')
const serverFile = join(SRC, 'server.ts')
const sf = ts.createSourceFile(
  serverFile,
  readFileSync(serverFile, 'utf8'),
  ts.ScriptTarget.Latest,
  true
)

/** The statement whose text starts with `needle` (the first one in the file). */
function statement(needle: string): ts.Node {
  let hit: ts.Node | undefined
  const visit = (n: ts.Node) => {
    if (hit) return
    if (
      n.parent &&
      (ts.isBlock(n.parent) || ts.isSourceFile(n.parent) || ts.isIfStatement(n.parent)) &&
      n.getText(sf).startsWith(needle)
    )
      hit = n
    ts.forEachChild(n, visit)
  }
  visit(sf)
  expect(hit, `${needle} is in server.ts`).toBeDefined()
  return hit as ts.Node
}

/** The condition of the nearest `if` whose THEN branch holds the statement; null when none. */
function guardOf(needle: string): string | null {
  let child = statement(needle)
  for (let n = child.parent; n; child = n, n = n.parent) {
    if (ts.isIfStatement(n)) return n.thenStatement === child ? n.expression.getText(sf) : null
  }
  return null
}

/** Every `if` condition whose THEN branch holds the statement, innermost first. */
function guardsOf(needle: string): string[] {
  const out: string[] = []
  let child = statement(needle)
  for (let n = child.parent; n; child = n, n = n.parent) {
    if (ts.isIfStatement(n) && n.thenStatement === child) out.push(n.expression.getText(sf))
  }
  return out
}

const OUTER = '!isMultiTenant() || perAppJobs()'

describe('server.ts: which deployments schedule the core jobs', () => {
  it('the two job blocks open on self-hosted and on a shared deployment, never in cloud', () => {
    expect(guardOf('registerFileCleanup(app.cron)')).toBe(OUTER)
    expect(guardOf("app.addHook('onReady'")).toBe(OUTER)
    const opens = (env: Record<string, string>) => !isMultiTenant(env) || perAppJobs(env)
    expect(opens(SELF_HOSTED)).toBe(true)
    expect(opens(SHARED)).toBe(true)
    expect(opens(CLOUD)).toBe(false)
  })

  it('app jobs are registered under the outer gate only (a shared deployment gets them)', () => {
    for (const id of ['extension-events-sweep', 'outbox-worker', 'scheduled-broadcasts']) {
      expect(guardsOf(`app.cron.schedule('${id}'`), id).toEqual([OUTER])
    }
  })

  it('boot work against the static database stays self-hosted only inside the job block', () => {
    for (const needle of [
      "void import('./services/app-links.js')",
      'void runInBackgroundPool(runRetentionPurge)',
      "void import('./services/row-schedules.js')",
      "void import('./services/help-video-render.js')",
      "void import('./services/maintenance-windows.js')",
      'void bootPhase(',
      'cacheWarmTimer = setTimeout',
      'readinessWarmTimer = setTimeout',
      'void Promise.all([', // the db-tuning twin sweep
      "const { recordRestRoutes } = await import('./services/api-changelog.js')",
      "const row = (await db('nivaro_settings').orderBy('id', 'asc').first('paused_crons'))",
      "await import('./services/restart-cleanups.js')"
    ]) {
      const g = guardsOf(needle)
      expect(g, needle).toContain('!multiTenant')
      expect(g.at(-1), needle).toBe(OUTER)
    }
  })
})

describe('server.ts: no deployment-wide job runs on a shared deployment yet (P5-10)', () => {
  it('the process jobs with nowhere to write are registered self-hosted only', () => {
    expect(Object.keys(NO_DEPLOYMENT_STORE_CRONS).sort()).toEqual([
      'concurrency-sample',
      'pool-monitor'
    ])
    for (const id of Object.keys(NO_DEPLOYMENT_STORE_CRONS)) {
      expect(CORE_CRON_SCOPES[id], id).toBe('process')
      expect(guardsOf(`app.cron.schedule('${id}'`), id).toContain('!multiTenant')
    }
  })

  it('the shared boot summary is a warn line and names no process jobs as running', () => {
    const src = readFileSync(serverFile, 'utf8')
    const at = src.indexOf("'[cron] shared deployment:")
    expect(at).toBeGreaterThan(0)
    const call = src.lastIndexOf('app.log.', at)
    expect(src.slice(call, call + 12)).toBe('app.log.warn')
    expect(src.slice(call, at + 200)).not.toMatch(/process jobs (run )?once/)
  })
})

describe('server.ts: per-app housekeeping on a shared deployment (P5-10)', () => {
  it('a daily job-run prune runs per app on shared only', () => {
    expect(CORE_CRON_SCOPES['job-runs-prune']).toBe('app')
    expect(guardsOf("app.cron.schedule('job-runs-prune'")).toEqual(['multiTenant', OUTER])
  })

  it('the restart clean-ups run per app on shared, inline self-hosted', () => {
    expect(guardsOf('const cleanups = setTimeout(')).toEqual(['multiTenant', OUTER])
    expect(guardsOf("await import('./services/restart-cleanups.js')")).toEqual([
      '!multiTenant',
      OUTER
    ])
  })
})

// ── The manager's registration on a shared deployment ─────────────────────────────────────────

describe('a shared deployment registers each job with an explicit scope', () => {
  it('leaves out the self-hosted-only jobs and keeps app and process jobs', () => {
    useEnv(SHARED)
    const m = make()
    for (const id of Object.keys(SELF_HOSTED_ONLY_CRONS)) m.schedule(id, '* * * * *', noop)
    m.schedule('outbox-worker', '* * * * *', noop)
    m.schedule('own-sampler', '* * * * *', noop, { scope: 'process' })
    const ids = m.list().map((j) => j.id)
    expect(ids.sort()).toEqual(['outbox-worker', 'own-sampler'])
    const r = m.sharedRoster()
    expect(r.app).toEqual(['outbox-worker'])
    expect(r.process).toEqual(['own-sampler'])
    expect(r.leftOut.sort()).toEqual(Object.keys(SELF_HOSTED_ONLY_CRONS).sort())
    expect(r.unscoped).toEqual([])
  })

  it('names a job that declares no scope (it still runs per app, the default)', () => {
    useEnv(SHARED)
    const m = make()
    m.schedule('someone-forgot', '* * * * *', noop)
    m.schedule('ext:nightly', '* * * * *', noop, { extensionId: 'ext' })
    m.schedule('own-sampler', '* * * * *', noop, { scope: 'process' })
    expect(m.list().map((j) => j.id)).toEqual(['someone-forgot', 'ext:nightly', 'own-sampler'])
    expect(m.jobScope('someone-forgot')).toBe('app')
    const r = m.sharedRoster()
    expect(r.unscoped).toEqual(['someone-forgot'])
    expect(r.app.sort()).toEqual(['ext:nightly', 'someone-forgot'])
    expect(r.process).toEqual(['own-sampler'])
  })

  for (const [name, env] of [
    ['self-hosted', SELF_HOSTED],
    ['cloud', CLOUD]
  ] as const) {
    it(`${name}: every job is registered as before, nothing is left out or named`, () => {
      useEnv(env)
      const m = make()
      for (const id of Object.keys(SELF_HOSTED_ONLY_CRONS)) m.schedule(id, '* * * * *', noop)
      m.schedule('someone-forgot', '* * * * *', noop)
      expect(m.list().map((j) => j.id)).toEqual([
        ...Object.keys(SELF_HOSTED_ONLY_CRONS),
        'someone-forgot'
      ])
      expect(m.sharedRoster()).toEqual({ app: [], process: [], leftOut: [], unscoped: [] })
    })
  }
})

// ── Every core job the code schedules, registered as a shared boot would ───────────────────────

/** Literal first arguments of every core `cron.schedule(` / `m.schedule(` call in api/src. */
function coreScheduleIds(): string[] {
  const out = new Set<string>()
  for (const file of listSourceFiles(SRC)) {
    if (file === 'plugins/cron.ts') continue
    const code = readFileSync(join(SRC, file), 'utf8')
    const spans = lexSource(code)
    const inCode = (at: number) => spans.find((s) => s.start <= at && at < s.end)?.kind === 'code'
    for (const m of code.matchAll(/\b(?:cron\??|m)\.schedule\(\s*(['"`])([^'"`$]+)\1\s*,/g)) {
      if (inCode(m.index)) out.add(m[2])
    }
  }
  out.add('chaos-test-overlap') // scheduled by constant (CHAOS_TEST_JOB)
  return [...out].sort()
}

describe('multi-tenant boot roster', () => {
  const ids = coreScheduleIds()

  it('finds the core jobs', () => expect(ids.length).toBeGreaterThan(120))

  it('the P5-10 jobs are left out on a shared deployment', () => {
    for (const id of ['help-video-render-sweep', 'mail-retry'])
      expect(SELF_HOSTED_ONLY_CRONS[id], id).toBeTruthy()
  })

  it('every self-hosted-only job is a core job with a reason', () => {
    for (const [id, why] of Object.entries(SELF_HOSTED_ONLY_CRONS)) {
      expect(CORE_CRON_SCOPES[id], id).toBeDefined()
      expect(ids, id).toContain(id)
      expect(why.trim().length, id).toBeGreaterThan(10)
    }
  })

  it('shared: every job registered declares its scope; the self-hosted-only ones are left out', () => {
    useEnv(SHARED)
    const m = make()
    for (const id of ids) m.schedule(id, '0 3 * * *', noop)
    const r = m.sharedRoster()
    expect(r.unscoped).toEqual([])
    expect(r.leftOut.sort()).toEqual(Object.keys(SELF_HOSTED_ONLY_CRONS).sort())
    for (const j of m.list()) expect(explicitCronScope(j.id), j.id).not.toBeNull()
    expect(r.app.length + r.process.length).toBe(m.list().length)
    expect(m.list().length).toBe(ids.length - Object.keys(SELF_HOSTED_ONLY_CRONS).length)
    // every deployment-wide core job is left out, here or at boot: none runs on shared yet
    expect(r.process.sort()).toEqual(Object.keys(NO_DEPLOYMENT_STORE_CRONS).sort())
  })

  it('cloud: the manager drops nothing (cloud registers none of the server.ts jobs anyway)', () => {
    useEnv(CLOUD)
    const m = make()
    for (const id of ids) m.schedule(id, '0 3 * * *', noop)
    expect(
      m
        .list()
        .map((j) => j.id)
        .sort()
    ).toEqual(ids)
  })
})
