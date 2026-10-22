import { adminBaseUrl } from '../../admin-base.js'
import { type FaultDefinition, type FaultTarget, listFaults } from './catalog.js'
import { listPresets, type PresetSpec } from './presets.js'
import { type ChaosRun, listRuns } from './runs.js'

/**
 * "What if X died?" (#2860): a read-only answer about one dependency — the degradation claims it
 * carries and how recently each was proven (the scorecard #2830 when present, else the catalog's
 * own `proves` text with each fault's last run), the blast radius worked out from recorded
 * traffic (the Traffic Map's simulate-down, #2841), the last drills against it, and a DRAFT
 * experiment for the builder (#2844). It never arms anything: the draft is a link that opens the
 * builder pre-filled, where a person still presses Run and Confirm.
 *
 * Offered to administrators only: the ops assistant / Telemetry Ask tool `chaos_what_if`
 * (chaos-ai-tool.ts) and the MCP tool of the same name, both through GET /api/chaos/what-if.
 */

export interface Dependency {
  key: string
  label: string
  /** Traffic Map dependency node simulate-down understands (null = none). */
  map_node: string | null
  areas: string[]
  fault_keys: string[]
  claim_prefixes: string[]
  aliases: string[]
}

export const DEPENDENCIES: Dependency[] = [
  {
    key: 'database',
    label: 'The database',
    map_node: 'db',
    areas: ['db'],
    fault_keys: [],
    claim_prefixes: ['db.', 'pool.'],
    aliases: ['db', 'sql', 'sql server', 'mssql', 'database', 'the database', 'pool']
  },
  {
    key: 'redis',
    label: 'Redis',
    map_node: 'redis',
    areas: ['redis'],
    fault_keys: ['redis_pause'],
    claim_prefixes: ['redis.', 'cron.', 'session.', 'sessions.'],
    aliases: ['redis', 'cache', 'the cache', 'cron lease']
  },
  {
    key: 'files',
    label: 'The file share',
    map_node: 'store',
    areas: ['storage', 'files'],
    fault_keys: [],
    claim_prefixes: ['files.', 'storage.'],
    aliases: ['files', 'file share', 'storage', 'disk', 'store', 'uploads']
  },
  {
    key: 'mail',
    label: 'Email (SMTP)',
    map_node: 'mail',
    areas: ['mail'],
    fault_keys: ['mail_down'],
    claim_prefixes: ['mail.'],
    aliases: ['mail', 'email', 'smtp']
  },
  {
    key: 'ai',
    label: 'The AI provider',
    map_node: 'ai',
    areas: ['ai'],
    fault_keys: [],
    claim_prefixes: ['ai.'],
    aliases: ['ai', 'anthropic', 'claude', 'ai gateway', 'gateway', 'llm']
  },
  {
    key: 'signin',
    label: 'The sign-in provider',
    map_node: 'signin',
    areas: ['oidc', 'signin', 'auth'],
    fault_keys: [],
    claim_prefixes: ['oidc.', 'signin.', 'auth.', 'graph.'],
    aliases: [
      'signin',
      'sign-in',
      'sign in',
      'oidc',
      'idp',
      'microsoft',
      'entra',
      'azure ad',
      'sso'
    ]
  },
  {
    key: 'partners',
    label: 'Partner APIs',
    map_node: null,
    areas: ['partner', 'outbound', 'external'],
    fault_keys: [],
    claim_prefixes: ['partner.', 'external.', 'erp.'],
    aliases: ['partner', 'partners', 'external api', 'external apis', 'erp', 'integration']
  },
  {
    key: 'sockets',
    label: 'Realtime sockets',
    map_node: null,
    areas: ['socket', 'realtime'],
    fault_keys: ['socket_drill'],
    claim_prefixes: ['sockets.', 'realtime.', 'socket.'],
    aliases: ['sockets', 'socket', 'websocket', 'socket.io', 'realtime', 'pub/sub', 'pubsub']
  },
  {
    key: 'replica',
    label: 'One API replica',
    map_node: null,
    areas: ['process', 'clock'],
    fault_keys: [],
    claim_prefixes: ['process.', 'loop.', 'clock.', 'memory.', 'replica.'],
    aliases: ['replica', 'api', 'node', 'process', 'event loop', 'server', 'container']
  }
]

/** A dependency from a key, an alias or a Traffic Map node id (`ext:<id>` = one partner). */
export function resolveDependency(raw: unknown): Dependency | null {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
  if (!s) return null
  const ext = s.match(/^ext:(\d{1,9})$/)
  if (ext) {
    const partners = DEPENDENCIES.find((d) => d.key === 'partners') as Dependency
    return { ...partners, key: s, label: `Partner API ${ext[1]}`, map_node: s }
  }
  return (
    DEPENDENCIES.find((d) => d.key === s || d.map_node === s) ??
    DEPENDENCIES.find((d) => d.aliases.includes(s)) ??
    DEPENDENCIES.find((d) => d.aliases.some((a) => a.length > 3 && s.includes(a))) ??
    null
  )
}

/** Catalog faults that act on a dependency (by key, area or a claim they prove). */
export function faultsFor(dep: Dependency, faults: FaultDefinition[] = listFaults()) {
  return faults.filter(
    (f) =>
      dep.fault_keys.includes(f.key) ||
      (f.area != null && dep.areas.includes(f.area)) ||
      f.claim_keys.some((c) => dep.claim_prefixes.some((p) => c.startsWith(p)))
  )
}

// ─── Optional sources (built by other parts of the program) ───────────────────

export interface ClaimLine {
  key: string
  statement: string
  /** proven | broke | stale | never | unknown */
  status: string
  last_run_at: string | null
  verdict: string | null
  source: 'scorecard' | 'catalog'
}

export interface BlastSummary {
  available: true
  window: string
  totals: {
    routes: number
    per_min: number
    share_of_calls: number | null
    screens: number
    jobs: number
  }
  top_routes: Array<{ route: string; per_min: number; strength: string }>
  jobs: string[]
  fails: string[]
  degrades: string[]
  keeps: string[]
}

export type BlastAnswer = BlastSummary | { available: false; reason: string }

export interface WhatIfDeps {
  /** Scorecard lines for these claim keys, or null when the scorecard (#2830) is not here. */
  scorecard(claimKeys: string[]): Promise<ClaimLine[] | null>
  /** Simulate-down summary for a Traffic Map node (#2841). */
  blast(node: string): Promise<BlastAnswer>
  runs(faultKeys: string[]): Promise<ChaosRun[]>
  faults(): FaultDefinition[]
  presets(): Promise<Array<{ key: string; label: string; claim_keys: string[]; spec: PresetSpec }>>
}

/** Import a module another cluster may not have merged yet; null when it is absent. */
async function optionalImport<T>(spec: string): Promise<T | null> {
  try {
    return (await import(spec)) as T
  } catch {
    return null
  }
}

const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v))

/** Normalise whatever shape the scorecard answers (#2830) into claim lines. */
export function normaliseScorecard(rows: unknown, keys: string[]): ClaimLine[] {
  const list = Array.isArray(rows)
    ? rows
    : Array.isArray((rows as { claims?: unknown })?.claims)
      ? (rows as { claims: unknown[] }).claims
      : []
  const want = new Set(keys)
  const out: ClaimLine[] = []
  for (const raw of list) {
    const r = (raw ?? {}) as Record<string, unknown>
    const key = str(r.key)
    if (!key || (want.size && !want.has(key))) continue
    const last = (r.last_run ?? {}) as Record<string, unknown>
    out.push({
      key,
      statement: str(r.statement) ?? str(r.label) ?? str(r.text) ?? key,
      status: str(r.status) ?? 'unknown',
      last_run_at: str(r.last_run_at) ?? str(last.ended_at) ?? str(last.started_at),
      verdict: str(r.verdict) ?? str(last.verdict),
      source: 'scorecard'
    })
  }
  return out
}

/** Compact the Traffic Map's simulate-down answer (#2841) for an assistant. */
export function summariseBlast(data: unknown, window: string): BlastAnswer {
  const d = (data ?? {}) as Record<string, any>
  if (!d.totals || !Array.isArray(d.routes))
    return { available: false, reason: 'the blast-radius answer had an unexpected shape' }
  const claimTexts = (k: string) =>
    Array.isArray(d.claims?.[k])
      ? (d.claims[k] as Array<{ text?: string }>).map((c) => String(c.text ?? '')).filter(Boolean)
      : []
  return {
    available: true,
    window: String(d.window ?? window),
    totals: {
      routes: Number(d.totals.routes) || 0,
      per_min: Number(d.totals.per_min) || 0,
      share_of_calls: d.totals.share_of_calls == null ? null : Number(d.totals.share_of_calls),
      screens: Number(d.totals.screens) || 0,
      jobs: Number(d.totals.jobs) || 0
    },
    top_routes: (d.routes as Array<Record<string, unknown>>).slice(0, 8).map((r) => ({
      route: String(r.route),
      per_min: Number(r.per_min) || 0,
      strength: String(r.strength ?? 'direct')
    })),
    jobs: Array.isArray(d.jobs)
      ? d.jobs.slice(0, 10).map((j: { id: unknown }) => String(j.id))
      : [],
    fails: claimTexts('fails'),
    degrades: claimTexts('degrades'),
    keeps: claimTexts('keeps')
  }
}

export const defaultDeps: WhatIfDeps = {
  async scorecard(claimKeys) {
    // #2830 lives in claims.ts once merged; its absence is a normal state, not an error.
    const m = await optionalImport<Record<string, unknown>>('./claims.js')
    if (!m) return null
    for (const name of ['claimScorecard', 'scorecard', 'listClaimStatus', 'claimStatuses']) {
      const fn = m[name]
      if (typeof fn === 'function') {
        try {
          return normaliseScorecard(await (fn as () => Promise<unknown>)(), claimKeys)
        } catch {
          return null
        }
      }
    }
    return null
  },
  async blast(node) {
    if (process.env.CLOUD_META_DB_URL)
      return { available: false, reason: 'the Traffic Map does not simulate in cloud mode' }
    const m = await optionalImport<{
      parseDependencyNode(raw: unknown): unknown
      simulateDown(dep: unknown, window: string, opts: Record<string, unknown>): Promise<unknown>
    }>('../traffic-actions/simulate-down.js')
    if (!m?.simulateDown)
      return { available: false, reason: 'this instance has no Traffic Map simulate-down' }
    const dep = m.parseDependencyNode(node)
    if (!dep) return { available: false, reason: `no estimate for ${node}` }
    try {
      const data = await m.simulateDown(dep, '24h', { until: null, who: null, fresh: false })
      return data
        ? summariseBlast(data, '24h')
        : { available: false, reason: 'no such dependency on the map' }
    } catch (err) {
      return { available: false, reason: `the estimate failed: ${(err as Error).message}` }
    }
  },
  async runs(faultKeys) {
    if (!faultKeys.length) return []
    const lists = await Promise.all(
      faultKeys.map((k) => listRuns({ fault_key: k, limit: 3 }).catch(() => []))
    )
    return lists
      .flat()
      .sort((a, b) =>
        String(b.started_at ?? b.created_at).localeCompare(String(a.started_at ?? a.created_at))
      )
      .slice(0, 5)
  },
  faults: () => listFaults(),
  presets: () => listPresets()
}

export interface WhatIfAnswer {
  dependency: { key: string; label: string; map_node: string | null }
  claims: ClaimLine[]
  blast_radius: BlastAnswer
  last_runs: Array<{
    id: string
    fault_key: string | null
    label: string
    status: string
    verdict: string | null
    started_at: string | null
  }>
  faults: Array<{ key: string; label: string; proves: string }>
  draft: (PresetSpec & { preset_key: string | null }) | null
  builder_href: string | null
  /** Always true: this answer never arms a fault. */
  draft_only: true
  note: string
}

export class WhatIfError extends Error {
  statusCode = 400
}

export function dependencyChoices(): string {
  return DEPENDENCIES.map((d) => d.key).join(', ')
}

/** The builder link for a draft: `/chaos?tab=builder&spec=<json>` (absolute when known). */
export function builderHref(spec: PresetSpec, presetKey: string | null): string {
  const q = new URLSearchParams({ tab: 'builder' })
  if (presetKey) q.set('preset', presetKey)
  q.set('spec', JSON.stringify(spec))
  const base = adminBaseUrl() ?? ''
  return `${base}/chaos?${q.toString()}`
}

function draftFor(
  faults: FaultDefinition[],
  presets: Array<{ key: string; claim_keys: string[]; spec: PresetSpec }>
): (PresetSpec & { preset_key: string | null }) | null {
  const keys = new Set(faults.map((f) => f.key))
  const preset = presets.find((p) => keys.has(p.spec.fault_key))
  if (preset) return { ...structuredClone(preset.spec), preset_key: preset.key }
  const f = faults.find((x) => !x.console_href) ?? faults[0]
  if (!f) return null
  const kind = f.targets.includes('all') ? 'all' : f.targets.includes('share') ? 'share' : null
  const target: FaultTarget | undefined =
    kind === 'all'
      ? { kind: 'all' }
      : kind === 'share'
        ? { kind: 'share', share_pct: 10 }
        : undefined
  const params: Record<string, number | string | boolean> = {}
  for (const [k, s] of Object.entries(f.params))
    if ('default' in s && s.default !== undefined) params[k] = s.default
  return {
    fault_key: f.key,
    ...(target ? { target } : {}),
    params,
    seconds: Math.min(f.default_seconds ?? 30, 60),
    hypothesis: f.hypothesis_defaults ?? [],
    preset_key: null
  }
}

/** The answer for one dependency. Read-only; throws WhatIfError for an unknown dependency. */
export async function whatIf(raw: unknown, deps: WhatIfDeps = defaultDeps): Promise<WhatIfAnswer> {
  const dep = resolveDependency(raw)
  if (!dep)
    throw new WhatIfError(
      `Unknown dependency "${String(raw ?? '')}". Choose one of ${dependencyChoices()}, or ext:<partner id>.`
    )
  const faults = faultsFor(dep, deps.faults())
  const claimKeys = [...new Set(faults.flatMap((f) => f.claim_keys))]
  const [score, blast, runs, presets] = await Promise.all([
    deps.scorecard(claimKeys).catch(() => null),
    dep.map_node
      ? deps
          .blast(dep.map_node)
          .catch((err): BlastAnswer => ({ available: false, reason: (err as Error).message }))
      : Promise.resolve<BlastAnswer>({
          available: false,
          reason: 'no Traffic Map node for this dependency, so no estimate'
        }),
    deps.runs(faults.map((f) => f.key)).catch(() => [] as ChaosRun[]),
    deps.presets().catch(() => [])
  ])

  let claims: ClaimLine[]
  if (score?.length) claims = score
  else {
    // No scorecard: each fault's own claim, judged by its newest run.
    claims = faults.map((f) => {
      const last = runs.find((r) => r.fault_key === f.key)
      return {
        key: f.claim_keys[0] ?? f.key,
        statement: f.proves,
        status: !last
          ? 'never'
          : last.verdict === 'held'
            ? 'proven'
            : (last.verdict ?? last.status),
        last_run_at: last?.ended_at ?? last?.started_at ?? null,
        verdict: last?.verdict ?? null,
        source: 'catalog' as const
      }
    })
  }

  const draft = draftFor(faults, presets)
  const { preset_key: presetKey = null, ...spec } = draft ?? { preset_key: null }
  return {
    dependency: { key: dep.key, label: dep.label, map_node: dep.map_node },
    claims,
    blast_radius: blast,
    last_runs: runs.map((r) => ({
      id: r.id,
      fault_key: r.fault_key,
      label: r.label,
      status: r.status,
      verdict: r.verdict,
      started_at: r.started_at
    })),
    faults: faults.map((f) => ({ key: f.key, label: f.label, proves: f.proves })),
    draft,
    builder_href: draft ? builderHref(spec as PresetSpec, presetKey) : null,
    draft_only: true,
    note: draft
      ? 'Draft only: nothing was armed. The builder link opens it pre-filled; a person still runs pre-flight, Run and Confirm.'
      : 'No fault on this instance acts on this dependency yet, so there is no draft.'
  }
}
