import { db } from '../../../db/index.js'
import { NIVARO_VERSION } from '../../../version.js'
import type { GitCtx } from '../../gitlab-client.js'
import { releaseFacts } from '../../hub-link/release-figures.js'
import { gitlabCall } from '../gitlab-write.js'
import { gatherPlanInput, lastDeployedBuildReader } from '../promote-gather.js'
import { driverGitCtx } from '../promote-heal.js'
import { buildPromotionPlan } from '../promote-plan.js'
import type { PromotionPlan, PromotionStep } from '../promote-types.js'
import { type ReleaseFacts, readEnvFiguresById } from './figures.js'

/**
 * Release notes per promotion (Hub release operations): what changes between the version an
 * environment runs and the one a run deploys, from data the Hub can read.
 *
 *  - per GitLab component: the commits between the build the environment runs (the Hub's last
 *    recorded deploy of that component) and the build the plan deploys (GitLab compare), the
 *    migration files those commits add (any `migrations/` folder) and the setting names they add
 *    to env files (`.env*`, `*.env`)
 *  - Nivaro itself: the migration names and known setting names of the target version that the
 *    running version lacks — from build facts the Hub learned per version (its own build, and
 *    every environment it reads over its hub link with ?release_facts=1). A version the Hub has
 *    not seen yet answers null with a note, never a guess.
 *
 * A rollback lists what goes AWAY (the commits of the newer build), and says that migrations
 * which ran stay. The plan preview computes them live (previewReleaseNotes); a started run
 * stores them once in nivaro_hub_release_notes (recordReleaseNotes), shown in deploy history.
 * Read-only on GitLab; a part that cannot be read says so in its `error` and the rest stays.
 */

export const NOTES = 'nivaro_hub_release_notes'
export const FACTS = 'nivaro_hub_version_facts'
const COMMITS_SHOWN = 50
const VERSION_RE = /^\d+\.\d+\.\d+$/

export interface NoteCommit {
  sha: string
  title: string
  author: string | null
  at: string | null
}

export interface ComponentNotes {
  position: number
  component: string
  kind: string
  from_sha: string | null
  to_sha: string | null
  /** added = commits this run brings; removed = commits a rollback takes away. */
  direction: 'added' | 'removed'
  commits: NoteCommit[]
  total_commits: number
  migrations: string[]
  env_keys: string[]
  error?: string
}

export interface ReleaseNotes {
  kind: 'promote' | 'rollback'
  from_version: string | null
  to_version: string
  components: ComponentNotes[]
  nivaro: {
    migrations: string[] | null
    env_keys: string[] | null
    note: string | null
  }
  computed_at: string
}

export interface CompareAnswer {
  commits: NoteCommit[]
  diffs: Array<{ path: string; newFile: boolean; deletedFile: boolean; diff: string }>
}

export interface NotesDeps {
  gitCtx(driverId: number): Promise<GitCtx>
  compare(ctx: GitCtx, from: string, to: string): Promise<CompareAnswer>
  /** The commit the environment runs for this step's component (the Hub's last record). */
  running(envId: number, step: PromotionStep): Promise<string | null>
  facts(version: string): Promise<ReleaseFacts | null>
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** GitLab compare (read-only). */
export async function gitlabCompare(ctx: GitCtx, from: string, to: string): Promise<CompareAnswer> {
  const enc = encodeURIComponent
  const res = await gitlabCall(
    ctx,
    'compare',
    `/repository/compare?from=${enc(from)}&to=${enc(to)}&straight=false`,
    { timeoutMs: 20_000 }
  )
  const b = (res.body ?? {}) as { commits?: unknown; diffs?: unknown }
  const commits = (Array.isArray(b.commits) ? b.commits : []).map((c) => {
    const r = (c ?? {}) as Record<string, unknown>
    return {
      sha: str(r.id),
      title: (str(r.title) || str(r.message)).split('\n')[0].slice(0, 300),
      author: str(r.author_name) || null,
      at: str(r.created_at) || null
    }
  })
  const diffs = (Array.isArray(b.diffs) ? b.diffs : []).map((d) => {
    const r = (d ?? {}) as Record<string, unknown>
    return {
      path: str(r.new_path) || str(r.old_path),
      newFile: r.new_file === true,
      deletedFile: r.deleted_file === true,
      diff: str(r.diff).slice(0, 200_000)
    }
  })
  return { commits, diffs }
}

const MIGRATION_RE = /(^|\/)migrations\/[^/]+\.(ts|js|mjs|cjs|sql)$/
const ENV_FILE_RE = /(^|\/)(\.env[^/]*|[^/]+\.env)$/

/** Migration files a diff adds (path names only). */
export function migrationsAdded(diffs: CompareAnswer['diffs']): string[] {
  return diffs
    .filter((d) => d.newFile && MIGRATION_RE.test(d.path))
    .map((d) => d.path.split('/').pop() as string)
    .sort()
}

const KEY_LINE = /^([+-])\s*(?:export\s+)?([A-Z][A-Z0-9_]{1,100})\s*=/

/** Setting names a diff adds to env files (a key both removed and added is not new). */
export function envKeysAdded(diffs: CompareAnswer['diffs']): string[] {
  const added = new Set<string>()
  const removed = new Set<string>()
  for (const d of diffs) {
    if (!ENV_FILE_RE.test(d.path)) continue
    for (const line of d.diff.split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---')) continue
      const m = KEY_LINE.exec(line)
      if (!m) continue
      ;(m[1] === '+' ? added : removed).add(m[2])
    }
  }
  return [...added].filter((k) => !removed.has(k)).sort()
}

const minus = (a: string[], b: string[]) => {
  const s = new Set(b)
  return a.filter((x) => !s.has(x)).sort()
}

/** The Nivaro part: the build facts of both versions diffed (pure). */
export function nivaroNotes(
  kind: 'promote' | 'rollback',
  from: ReleaseFacts | null,
  to: ReleaseFacts | null,
  fromVersion: string | null,
  toVersion: string
): ReleaseNotes['nivaro'] {
  if (!fromVersion) return { migrations: null, env_keys: null, note: 'Nothing runs here yet.' }
  if (fromVersion === toVersion) return { migrations: [], env_keys: [], note: null }
  const missing = [!from ? fromVersion : null, !to ? toVersion : null].filter(Boolean)
  if (!from || !to)
    return {
      migrations: null,
      env_keys: null,
      note: `The Hub has not seen the build of ${missing.join(' and ')} yet (it learns a version from its own build and from every environment that runs it).`
    }
  if (kind === 'rollback')
    return {
      migrations: minus(from.migrations, to.migrations),
      env_keys: minus(from.env_keys, to.env_keys),
      note: `These came with ${fromVersion}. A rollback does not undo migrations that ran.`
    }
  return {
    migrations: minus(to.migrations, from.migrations),
    env_keys: minus(to.env_keys, from.env_keys),
    note: null
  }
}

/** Notes for one plan (no writes; never throws for a part — that part carries an error). */
export async function buildReleaseNotes(
  o: {
    envId: number
    kind: 'promote' | 'rollback'
    fromVersion: string | null
    toVersion: string
    plan: Pick<PromotionPlan, 'steps'>
  },
  deps: NotesDeps
): Promise<ReleaseNotes> {
  const components: ComponentNotes[] = []
  for (const s of o.plan.steps) {
    if (s.driver === 'docker' || s.kind === 'stack') continue
    const to = s.sourceSha ?? s.expectHead ?? null
    const base: ComponentNotes = {
      position: s.position,
      component: s.component,
      kind: s.kind,
      from_sha: null,
      to_sha: to,
      direction: o.kind === 'rollback' ? 'removed' : 'added',
      commits: [],
      total_commits: 0,
      migrations: [],
      env_keys: []
    }
    try {
      const from = await deps.running(o.envId, s)
      base.from_sha = from
      if (!to) {
        base.error = 'The plan names no build for this part'
      } else if (!from) {
        base.error = 'The Hub has no record of the build this environment runs'
      } else if (from !== to && !from.startsWith(to) && !to.startsWith(from)) {
        const ctx = await deps.gitCtx(s.driverId)
        // A rollback lists what the older build lacks: newer (running) against older (target).
        const ans =
          o.kind === 'rollback'
            ? await deps.compare(ctx, to, from)
            : await deps.compare(ctx, from, to)
        base.total_commits = ans.commits.length
        // GitLab lists oldest first; the newest are what a person reads first.
        base.commits = ans.commits.slice(-COMMITS_SHOWN).reverse()
        base.migrations = migrationsAdded(ans.diffs)
        base.env_keys = envKeysAdded(ans.diffs)
      }
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code
      base.error =
        code === 'GITLAB_UNREACHABLE'
          ? 'GitLab did not answer'
          : typeof code === 'string'
            ? `GitLab refused the comparison (${code})`
            : 'The changes could not be read'
    }
    components.push(base)
  }
  const [fromFacts, toFacts] = await Promise.all([
    o.fromVersion ? deps.facts(o.fromVersion).catch(() => null) : null,
    deps.facts(o.toVersion).catch(() => null)
  ])
  return {
    kind: o.kind,
    from_version: o.fromVersion,
    to_version: o.toVersion,
    components,
    nivaro: nivaroNotes(o.kind, fromFacts, toFacts, o.fromVersion, o.toVersion),
    computed_at: new Date().toISOString()
  }
}

// ─── build facts per version ────────────────────────────────────────────────────────────────

const parseList = (v: unknown): string[] => {
  try {
    const x = JSON.parse(String(v ?? ''))
    return Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : []
  } catch {
    return []
  }
}

/** Stores (or refreshes) one version's facts. Never throws. */
export async function rememberFacts(facts: ReleaseFacts, source: string): Promise<void> {
  if (!VERSION_RE.test(facts.version) || !facts.migrations.length) return
  const row = {
    migrations: JSON.stringify(facts.migrations),
    env_keys: JSON.stringify(facts.env_keys),
    source: source.slice(0, 64),
    seen_at: new Date()
  }
  try {
    const n = await db(FACTS).where({ version: facts.version }).update(row)
    if (!n) await db(FACTS).insert({ version: facts.version, ...row })
  } catch {
    /* a race on the unique version, or a table behind 565: the facts are a cache */
  }
}

/** The facts the Hub knows for `version`: its own build's, else the stored row. */
export async function factsFor(version: string): Promise<ReleaseFacts | null> {
  if (version === NIVARO_VERSION) {
    const own = await releaseFacts()
    if (own.migrations.length) {
      void rememberFacts({ version, ...own }, 'hub')
      return { version, ...own }
    }
  }
  try {
    const r = (await db(FACTS).where({ version }).first('migrations', 'env_keys')) as
      | { migrations: unknown; env_keys: unknown }
      | undefined
    return r
      ? { version, migrations: parseList(r.migrations), env_keys: parseList(r.env_keys) }
      : null
  } catch {
    return null
  }
}

/** Reads these environments' build facts over their hub links and stores them. Never throws. */
export async function learnFacts(envIds: Array<number | null | undefined>): Promise<void> {
  const ids = [...new Set(envIds.filter((x): x is number => typeof x === 'number'))]
  await Promise.all(
    ids.map(async (id) => {
      try {
        const f = await readEnvFiguresById(id, { releaseFacts: true, timeoutMs: 6000 })
        if (f.release_facts) await rememberFacts(f.release_facts, `env:${id}`)
      } catch {
        /* learning is best effort */
      }
    })
  )
}

export function defaultNotesDeps(): NotesDeps {
  return {
    gitCtx: driverGitCtx,
    compare: gitlabCompare,
    running: async (envId, step) => (await lastDeployedBuildReader(envId)(step))?.sha ?? null,
    facts: factsFor
  }
}

/** The notes a plan would bring (the Promote panel's preview). No writes but learned facts. */
export async function previewReleaseNotes(
  envId: number,
  kind: 'promote' | 'rollback',
  version: string,
  deps: NotesDeps = defaultNotesDeps()
): Promise<ReleaseNotes> {
  const input = await gatherPlanInput(envId, { kind, version })
  await learnFacts([envId, input.previous?.id])
  const plan = buildPromotionPlan(input)
  return buildReleaseNotes(
    { envId, kind, fromVersion: input.targetVersion, toVersion: version, plan },
    deps
  )
}

/** Builds and stores a started run's notes once (a second call keeps the first). */
export async function recordReleaseNotes(
  deployId: number,
  deps: NotesDeps = defaultNotesDeps()
): Promise<ReleaseNotes | null> {
  const row = (await db('nivaro_hub_deploys').where({ id: deployId }).first()) as
    | Record<string, unknown>
    | undefined
  if (!row || (row.kind !== 'promote' && row.kind !== 'rollback')) return null
  if (await db(NOTES).where({ deploy_id: deployId }).first('id')) return null
  let plan: PromotionPlan
  try {
    plan = JSON.parse(String(row.plan ?? '')) as PromotionPlan
  } catch {
    return null
  }
  if (!Array.isArray(plan?.steps)) return null
  const envId = Number(row.environment_id)
  const prev = (await db('nivaro_hub_environments as e')
    .join('nivaro_hub_environments as p', 'p.app_id', 'e.app_id')
    .where('e.id', envId)
    .where('p.position', '<', db.ref('e.position'))
    .orderBy('p.position', 'desc')
    .first('p.id as id')
    .catch(() => undefined)) as { id: number } | undefined
  await learnFacts([envId, prev?.id])
  const notes = await buildReleaseNotes(
    {
      envId,
      kind: row.kind as 'promote' | 'rollback',
      fromVersion: row.from_version == null ? null : String(row.from_version),
      toVersion: String(row.version),
      plan
    },
    deps
  )
  try {
    await db(NOTES).insert({
      deploy_id: deployId,
      notes: JSON.stringify(notes),
      created_at: new Date()
    })
  } catch {
    return null
  }
  return notes
}

/** A run's stored notes, or null. */
export async function readReleaseNotes(deployId: number): Promise<ReleaseNotes | null> {
  try {
    const r = (await db(NOTES).where({ deploy_id: deployId }).first('notes')) as
      | { notes: string }
      | undefined
    return r ? (JSON.parse(String(r.notes)) as ReleaseNotes) : null
  } catch {
    return null
  }
}
