import { createHash } from 'node:crypto'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { getAiClient, getAiModelSettings } from './ai-client.js'
import { getApp } from './io-holder.js'
import { isSensitiveKey, MASK } from './secret-mask.js'

/**
 * "Explain this" for operational events (issues, slow requests, failed runs, readiness checks,
 * partner failures, webhook deliveries, slow pages, configuration).
 *
 * One pattern for every kind: a gatherer reads the FACTS deterministically (no model involved),
 * the facts are redacted and capped, ONE model call turns them into a short explanation with
 * numbered steps, and the answer is cached briefly against a hash of the facts — so the same
 * unchanged situation costs nothing twice, and a changed one (a new detail, a new error) gets a
 * fresh answer on its own. The model never sees credentials, request bodies or file contents.
 */

export interface ExplainFacts {
  /** One line naming the subject ("Issue #12", "Readiness check db-pool"). */
  title: string
  /** The facts, as compact JSON-able data. Redacted by `redactForModel` before use. */
  facts: Record<string, unknown>
  /** Kind-specific guidance appended to the shared system prompt. */
  instructions: string
  /** Where the admin can go next ({label, href}); never sent to the model. */
  links?: Array<{ label: string; href: string }>
  /** People worth contacting ({role, name, email}); sent as names only. */
  contacts?: Array<{ role: string; name: string; email?: string | null }>
}

export interface ExplainAnswer {
  kind: string
  title: string
  summary: string
  steps: string[]
  /** Whether re-running is safe, when the kind asks (partner / webhook / import). */
  retry_safe: 'yes' | 'no' | 'unknown' | null
  caution: string | null
  links: Array<{ label: string; href: string }>
  contacts: Array<{ role: string; name: string; email?: string | null }>
  generated_at: string
  cached: boolean
  model: string | null
}

export class ExplainError extends Error {
  constructor(
    public statusCode: number,
    message: string
  ) {
    super(message)
  }
}

// ── Redaction ────────────────────────────────────────────────────────────────

const BODY_KEYS = /^(body|request_body|response_body|payload|data|csv_data|file_content|content)$/i
const MAX_STRING = 700
const MAX_ARRAY = 40
const MAX_FACTS_CHARS = 14_000

/** Bearer tokens, JWTs, long hex/base64 blobs and `key=value` credentials inside free text. */
export function scrubText(input: string): string {
  return input
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${MASK}`)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, MASK)
    .replace(
      /\b(password|passwd|secret|token|api[_-]?key|authorization|client_secret|signature)(["']?\s*[:=]\s*["']?)[^\s"',;&]{3,}/gi,
      (_m, k: string, sep: string) => `${k}${sep}${MASK}`
    )
    .replace(/\b[A-Fa-f0-9]{40,}\b/g, MASK)
    .replace(/(https?:\/\/[^\s?#"']+)\?[^\s"']*/g, '$1?…')
}

/**
 * A deep copy that is safe to send to the model: values under credential-looking keys masked,
 * request/response bodies and file contents replaced by their shape, strings scrubbed and cut,
 * arrays capped. Pure; the cap on the whole result is enforced by `capFacts`.
 */
/** First line of free text, scrubbed and cut: enough to name an error class, nothing more. */
export function firstLineScrubbed(input: unknown, max = 200): string {
  const line =
    String(input ?? '')
      .split(/\r?\n/)
      .find((l) => l.trim()) ?? ''
  return scrubText(line.trim()).slice(0, max)
}

export function redactForModel(value: unknown, depth = 0): unknown {
  if (value == null) return value
  if (typeof value === 'string') {
    const s = scrubText(value)
    return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}… [${s.length - MAX_STRING} more]` : s
  }
  if (typeof value !== 'object') return value
  if (value instanceof Date) return value.toISOString()
  if (depth > 6) return '[nested]'
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY).map((v) => redactForModel(v, depth + 1))
    if (value.length > MAX_ARRAY) out.push(`… ${value.length - MAX_ARRAY} more`)
    return out
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(k) && v != null && v !== '') {
      out[k] = MASK
    } else if (BODY_KEYS.test(k) && v != null && typeof v === 'object') {
      out[k] =
        `[omitted: ${Array.isArray(v) ? `list of ${v.length}` : `object of ${Object.keys(v as object).length} fields`}]`
    } else if (BODY_KEYS.test(k) && typeof v === 'string' && v.length > 0) {
      out[k] = `[omitted: ${v.length} characters]`
    } else {
      out[k] = redactForModel(v, depth + 1)
    }
  }
  return out
}

/** JSON text of the redacted facts, cut to what one prompt should carry. */
export function capFacts(facts: Record<string, unknown>): string {
  const text = JSON.stringify(redactForModel(facts), null, 1)
  return text.length > MAX_FACTS_CHARS
    ? `${text.slice(0, MAX_FACTS_CHARS)}\n… [facts cut at ${MAX_FACTS_CHARS} characters]`
    : text
}

// ── Cache ────────────────────────────────────────────────────────────────────

const CACHE_SECONDS = 30 * 60
const memory = new Map<string, { at: number; value: string }>()

function redisOf(): {
  get(k: string): Promise<string | null>
  set(k: string, v: string, mode: string, ttl: number): Promise<unknown>
} | null {
  try {
    return (getApp() as { redis?: ReturnType<typeof redisOf> } | null)?.redis ?? null
  } catch {
    return null
  }
}

async function cacheGet(key: string): Promise<string | null> {
  const r = redisOf()
  if (r) {
    try {
      const v = await r.get(key)
      if (v) return v
    } catch {
      /* fall through to memory */
    }
  }
  const m = memory.get(key)
  if (m && Date.now() - m.at < CACHE_SECONDS * 1000) return m.value
  return null
}

async function cacheSet(key: string, value: string): Promise<void> {
  memory.set(key, { at: Date.now(), value })
  if (memory.size > 300) memory.delete(memory.keys().next().value as string)
  const r = redisOf()
  if (r) {
    try {
      await r.set(key, value, 'EX', CACHE_SECONDS)
    } catch {
      /* memory copy stands */
    }
  }
}

export function clearExplainCacheForTests(): void {
  memory.clear()
}

// ── The model call ───────────────────────────────────────────────────────────

const SYSTEM = `You are an operations assistant inside an admin console. You are given a compact, already-redacted FACT SHEET about one event or configuration. Explain it for an administrator.

Rules:
- Use only the facts given. If they do not support a conclusion, say what is missing instead of guessing. Never invent file names, ids, numbers or causes.
- Plain words, no jargon the admin did not see in the facts. Short.
- This is a suggestion, not a verdict: say "likely" where you are inferring.
- Never ask for or repeat secrets. Values shown as •••••• are hidden on purpose.

Reply with ONLY a JSON object:
{"summary": "<2-4 sentences: what happened and the likely cause>",
 "steps": ["<numbered-step text without the number>", ...] (at most 6; [] when nothing to do),
 "retry_safe": "yes" | "no" | "unknown" | null (null unless the kind asks about retrying),
 "caution": "<one sentence the admin should know before acting>" | null}`

interface ModelOut {
  summary: string
  steps: string[]
  retry_safe: 'yes' | 'no' | 'unknown' | null
  caution: string | null
}

/** Pull the JSON object out of a model reply; fall back to the raw text as the summary. */
export function parseModelAnswer(text: string): ModelOut {
  const trimmed = text.trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const j = JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>
      const steps = Array.isArray(j.steps)
        ? j.steps
            .map((s) =>
              String(s)
                .replace(/^\s*\d+[.)]\s*/, '')
                .trim()
            )
            .filter(Boolean)
            .slice(0, 6)
        : []
      const rs = String(j.retry_safe ?? '').toLowerCase()
      return {
        summary: String(j.summary ?? '').trim() || trimmed,
        steps,
        retry_safe: rs === 'yes' || rs === 'no' || rs === 'unknown' ? rs : null,
        caution: j.caution ? String(j.caution).trim() || null : null
      }
    } catch {
      /* fall through */
    }
  }
  return { summary: trimmed, steps: [], retry_safe: null, caution: null }
}

type Messages = {
  messages: {
    create: (p: Record<string, unknown>) => Promise<{
      content: Array<{ type: string; text?: string }>
    }>
  }
}

export interface ExplainOptions {
  fresh?: boolean
  /** Test seam: replaces the provider client. */
  client?: Messages | null
}

/**
 * Ask the model about gathered facts, with the answer cached against the facts' hash. Throws
 * ExplainError(503) when no provider is configured.
 */
export async function explainFacts(
  kind: string,
  gathered: ExplainFacts,
  opts: ExplainOptions = {}
): Promise<ExplainAnswer> {
  const factText = capFacts(gathered.facts)
  const contacts = (gathered.contacts ?? []).map((c) => ({ ...c }))
  const key = `nvr:aiexplain:${kind}:${createHash('sha1').update(`${gathered.instructions}\n${factText}`).digest('hex')}`
  const shape = (out: ModelOut, at: string, cached: boolean, model: string | null) => ({
    kind,
    title: gathered.title,
    ...out,
    links: gathered.links ?? [],
    contacts,
    generated_at: at,
    cached,
    model
  })

  if (!opts.fresh) {
    const hit = await cacheGet(key)
    if (hit) {
      try {
        const j = JSON.parse(hit) as { out: ModelOut; at: string; model: string | null }
        return shape(j.out, j.at, true, j.model)
      } catch {
        /* regenerate */
      }
    }
  }

  const client = (opts.client ?? (await getAiClient())) as Messages | null
  if (!client) throw new ExplainError(503, 'AI is not configured on this instance')
  const settings = await getAiModelSettings()
  const model = settings.summarizeModel ?? settings.model
  const prompt = `${gathered.instructions}\n\nSubject: ${scrubText(gathered.title)}\n\nFACTS:\n${factText}`
  let text: string
  try {
    const res = await client.messages.create({
      model,
      max_tokens: 700,
      system: SYSTEM,
      messages: [{ role: 'user', content: prompt }]
    })
    text = res.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('')
  } catch (err) {
    throw new ExplainError(
      502,
      `The AI provider failed: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  const out = parseModelAnswer(text)
  const at = new Date().toISOString()
  await cacheSet(key, JSON.stringify({ out, at, model }))
  return shape(out, at, false, model)
}

// ── Gatherers ────────────────────────────────────────────────────────────────

export type Gatherer = (params: Record<string, unknown>, user: User) => Promise<ExplainFacts>

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,200}$/

function str(params: Record<string, unknown>, key: string): string {
  const v = params[key]
  const s = v == null ? '' : String(v)
  if (!SAFE_ID.test(s)) throw new ExplainError(400, `${key} is required`)
  return s
}

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

const iso = (d: unknown): string | null => (d ? new Date(d as string).toISOString() : null)

async function userName(
  id: string | null | undefined
): Promise<{ name: string; email: string | null } | null> {
  if (!id) return null
  const u = (await db('nivaro_users')
    .where({ id })
    .first('first_name', 'last_name', 'email')
    .catch(() => null)) as {
    first_name: string | null
    last_name: string | null
    email: string | null
  } | null
  if (!u) return null
  return {
    name: `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || (u.email ?? 'Unknown'),
    email: u.email
  }
}

/** Names of the tables a SQL text reads, for matching tuning proposals. */
export function tablesOf(sql: string): string[] {
  const out = new Set<string>()
  for (const m of sql.matchAll(/\b(?:from|join|update|into)\s+\[?([A-Za-z_][A-Za-z0-9_]*)\]?/gi)) {
    out.add(m[1].toLowerCase())
  }
  return [...out]
}

// #1814 — an issue
const gatherIssue: Gatherer = async (params) => {
  const id = Number(str(params, 'id'))
  const row = (await db('nivaro_issues')
    .where({ id })
    .first(
      'id',
      'title',
      'severity',
      'status',
      'source',
      'details',
      'occurrence_count',
      'created_at',
      'last_seen_at',
      'resolution_notes',
      'fingerprint'
    )) as Record<string, unknown> | undefined
  if (!row) throw new ExplainError(404, 'Issue not found')
  const details = String(row.details ?? '')
  const route = /^Route:\s*(.+)$/m.exec(details)?.[1]?.trim() ?? null
  const created = new Date(row.created_at as string)
  const dayBefore = new Date(created.getTime() - 86_400_000)

  const [migrations, configChanges, similar] = await Promise.all([
    db('nivaro_migration_effects')
      .whereBetween('ran_at', [dayBefore, created])
      .select('name', 'ran_at', 'summary')
      .limit(6)
      .catch(() => []),
    db('nivaro_activity')
      .where('action', 'config-epoch')
      .whereBetween('timestamp', [dayBefore, created])
      .select('timestamp', 'comment')
      .limit(6)
      .catch(() => []),
    route
      ? db('nivaro_issues')
          .whereIn('status', ['resolved', 'closed'])
          .whereNot('id', id)
          .where('title', 'like', `%${route.replace(/[%_[]/g, '')}%`)
          .whereNotNull('resolution_notes')
          .orderBy('updated_at', 'desc')
          .limit(5)
          .select('id', 'title', 'resolution_notes', 'updated_at')
          .catch(() => [])
      : Promise.resolve([])
  ])
  return {
    title: `Issue #${id}`,
    facts: {
      issue: { ...row, details: undefined, fingerprint: undefined },
      route,
      first_seen: iso(row.created_at),
      last_seen: iso(row.last_seen_at),
      stack_and_context: scrubText(details).slice(0, 5000),
      just_before_first_occurrence: {
        migrations_applied: migrations,
        configuration_changes: configChanges
      },
      similar_issues_resolved_before: similar
    },
    instructions:
      'Explain the likely cause of this error from the stack and the request context. Say what changed just before the first occurrence if the facts show it. Point to the files named in the stack frames (only those). Suggest a fix as a suggestion, and say whether similar issues resolved before help.',
    links: [{ label: 'Open the issue log', href: '/issues' }]
  }
}

// #1858 — a slow request
/**
 * #2544 — a trace that has left this process's memory ring (or was kept by another process) is
 * read back from the long-history traces store instead, when the instance sends traces there.
 */
async function gatherStoredTrace(id: string): Promise<ExplainFacts> {
  const { storeEnabled } = await import('./telemetry-store.js')
  const notHere = 'That trace is no longer in memory (traces are kept per process)'
  if (!storeEnabled()) throw new ExplainError(404, notHere)
  const { loadStoredTrace } = await import('./telemetry-traces.js')
  const t = await loadStoredTrace(id).catch(() => null)
  if (!t) throw new ExplainError(404, `${notHere}, and the traces store does not have it either`)
  return {
    title: `${t.method} ${t.route} (${t.total_ms} ms)`,
    facts: {
      request: {
        method: t.method,
        route: t.route,
        status: t.status,
        total_ms: t.total_ms,
        at: t.at,
        why_it_was_traced: t.reason
      },
      database: {
        round_trips: t.round_trips,
        sql_ms: t.sql_ms,
        unaccounted_ms: Math.max(0, t.total_ms - t.sql_ms)
      },
      phases: t.phases,
      heaviest_statements: t.heaviest_statements,
      repeated_statements: t.repeated_statements
    },
    instructions:
      'Explain where the time of this request went (database waiting vs application time vs a repeated statement = N+1) and what would help most. Phases are nested by depth (0 = directly under the request) and can overlap the statements inside them; unaccounted_ms is request time outside any SQL. Statement values were left out on purpose.',
    links: [{ label: 'Open Database', href: '/database' }]
  }
}

const gatherTrace: Gatherer = async (params) => {
  const { getTrace, unaccountedMs } = await import('./request-trace.js')
  const id = str(params, 'id')
  const t = getTrace(id)
  if (!t) return gatherStoredTrace(id)
  const shapes = t.top_sql.map((s) => ({
    sql: s.sql.slice(0, 500),
    calls: s.n,
    total_ms: Math.round(s.ms)
  }))
  const tables = new Set(t.top_sql.flatMap((s) => tablesOf(s.sql)))
  const proposals = (await db('nivaro_tuning_proposals')
    .whereIn('status', ['proposed', 'watching', 'applied'])
    .select('id', 'kind', 'target', 'title', 'status', 'estimate_ms_per_day')
    .limit(300)
    .catch(() => [])) as Array<{
    id: string
    kind: string
    target: string
    title: string
    status: string
    estimate_ms_per_day: number
  }>
  const related = proposals.filter(
    (p) =>
      tables.has(String(p.target).split('.')[0].toLowerCase()) ||
      [...tables].some((tb) => String(p.title).toLowerCase().includes(tb))
  )
  return {
    title: `${t.method} ${t.route} (${t.total_ms} ms)`,
    facts: {
      request: {
        method: t.method,
        route: t.route,
        status: t.status,
        total_ms: t.total_ms,
        at: t.ts
      },
      database: { round_trips: t.queries, sql_ms: t.sql_ms, unaccounted_ms: unaccountedMs(t) },
      phases: t.spans.map((s) => ({
        phase: s.phase,
        ms: s.ms,
        queries: s.queries,
        repeated_statement: s.repeat
          ? { sql: s.repeat.sql.slice(0, 300), times: s.repeat.n, ms: s.repeat.ms }
          : undefined
      })),
      heaviest_statements: shapes,
      select_star_on_wide_tables: t.wide,
      existing_tuning_proposals: related.map((p) => ({
        id: p.id,
        title: p.title,
        status: p.status,
        kind: p.kind
      }))
    },
    instructions:
      'Explain where the time of this request went (database waiting vs application time vs a repeated statement = N+1) and what would help most. If an existing tuning proposal covers it, say so by title. Statement bindings were left out on purpose.',
    links: related.length
      ? [{ label: 'Open database tuning', href: '/database/tuning' }]
      : [{ label: 'Open Database', href: '/database' }]
  }
}

// #1859 / #2023 — a staged import run (failed or slow)
const gatherImportRun: Gatherer = async (params) => {
  const id = Number(str(params, 'id'))
  const run = (await db('nivaro_import_queue').where({ id }).first()) as
    | Record<string, unknown>
    | undefined
  if (!run) throw new ExplainError(404, 'Import run not found')
  const def = run.definition
    ? ((await db('nivaro_import_definitions')
        .where({ id: run.definition })
        .first('key', 'label', 'staging_table', 'procedure', 'processor', 'service_config')
        .catch(() => null)) as Record<string, unknown> | null)
    : null
  let report: Record<string, unknown> | null = null
  try {
    report = run.report
      ? typeof run.report === 'string'
        ? JSON.parse(run.report)
        : run.report
      : null
  } catch {
    report = null
  }
  const prior = (await db('nivaro_import_queue')
    .where('import_key', run.import_key as string)
    .where('status', 'completed')
    .whereNot('id', id)
    .orderBy('id', 'desc')
    .limit(12)
    .select('id', 'duration', 'row_count', 'report')
    .catch(() => [])) as Array<{
    id: number
    duration: number | null
    row_count: number | null
    report: unknown
  }>
  const phaseMs = new Map<string, number[]>()
  for (const p of prior) {
    try {
      const r = p.report ? (typeof p.report === 'string' ? JSON.parse(p.report) : p.report) : null
      for (const ph of (r?.phases ?? []) as Array<{ key?: string; label?: string; ms?: number }>) {
        const k = ph.label ?? ph.key
        if (k && typeof ph.ms === 'number') phaseMs.set(k, [...(phaseMs.get(k) ?? []), ph.ms])
      }
    } catch {
      /* skip */
    }
  }
  const logs = String(run.logs ?? '')
  const rep = report as {
    counts?: unknown
    skipped?: unknown
    phases?: Array<{ label?: string; key?: string; ms?: number; count?: number; failed?: boolean }>
    unmatched?: Array<{
      label?: string
      column?: string
      distinct?: number
      rows?: number
      effect?: string
      values?: string[]
    }>
    notes?: string[]
  } | null
  return {
    title: `Import run #${id} (${run.import_key})`,
    facts: {
      run: {
        status: run.status,
        import_key: run.import_key,
        rows_in_file: run.row_count,
        duration_s: run.duration,
        started_at: iso(run.started_at),
        finished_at: iso(run.finished_at),
        ran_via: run.ran_via
      },
      definition: def
        ? { ...def, service_config: undefined, has_service_config: !!def.service_config }
        : null,
      log_tail: scrubText(logs.slice(-5000)),
      report: rep
        ? {
            counts: rep.counts,
            skipped_reasons: rep.skipped,
            phases: rep.phases,
            unmatched: (rep.unmatched ?? []).slice(0, 8).map(({ values: _values, ...u }) => u),
            notes: (rep.notes ?? []).slice(0, 8)
          }
        : null,
      usual_runs: {
        samples: prior.length,
        median_duration_s: median(
          prior.map((p) => Number(p.duration)).filter((n) => Number.isFinite(n))
        ),
        median_rows: median(
          prior.map((p) => Number(p.row_count)).filter((n) => Number.isFinite(n))
        ),
        median_phase_ms: Object.fromEntries([...phaseMs].map(([k, v]) => [k, median(v)]))
      }
    },
    instructions:
      'If the run failed, explain the cause and the fix from the log and the definition, and say whether starting the import again is safe. If it completed, explain where the time went across its phases (load, compare, writes, procedures) compared with the usual runs, and what would help. File contents are never included.',
    links: [{ label: 'Open the import console', href: '/imports' }]
  }
}

// #1859 — a background job run
const gatherJobRun: Gatherer = async (params) => {
  const id = Number(str(params, 'id'))
  const run = (await db('nivaro_job_runs').where({ id }).first()) as
    | Record<string, unknown>
    | undefined
  if (!run) throw new ExplainError(404, 'Job run not found')
  const prior = (await db('nivaro_job_runs')
    .where({ kind: run.kind as string, job_id: run.job_id as string })
    .whereNot('id', id)
    .orderBy('id', 'desc')
    .limit(15)
    .select('status', 'duration_ms', 'started_at', 'error')
    .catch(() => [])) as Array<{
    status: string
    duration_ms: number | null
    started_at: Date
    error: string | null
  }>
  return {
    title: `${run.label ?? run.job_id} (run #${id})`,
    facts: {
      run: {
        kind: run.kind,
        job_id: run.job_id,
        extension: run.extension_id,
        status: run.status,
        started_at: iso(run.started_at),
        duration_ms: run.duration_ms,
        outcome: run.outcome,
        error: String(run.error ?? '').slice(0, 3000)
      },
      earlier_runs: prior.map((p) => ({
        status: p.status,
        duration_ms: p.duration_ms,
        at: iso(p.started_at),
        error: p.error ? String(p.error).slice(0, 160) : null
      })),
      usual_duration_ms: median(
        prior.map((p) => Number(p.duration_ms)).filter((n) => Number.isFinite(n) && n > 0)
      )
    },
    instructions:
      'Explain why this background job run failed (or ran long) in plain words from its error and outcome, whether it has failed before, and the fix. Say whether running it again is safe.',
    links: [{ label: 'Open Jobs', href: '/jobs' }]
  }
}

// #1860 — a readiness check
const gatherReadiness: Gatherer = async (params) => {
  const id = str(params, 'id')
  // The stored result the admin is looking at (live only when it has none).
  const { readReadinessCheck } = await import('./readiness.js')
  const check = await readReadinessCheck(id)
  if (!check) throw new ExplainError(404, 'No such readiness check')
  return {
    title: `Readiness: ${check.label}`,
    facts: {
      check: {
        id: check.id,
        label: check.label,
        group: check.group,
        description: check.description,
        status: check.status,
        detail: check.detail,
        blockers: check.blockers,
        has_automatic_fix: check.remediation_label ?? null
      }
    },
    instructions:
      'Explain what this readiness check is guarding, why it is not passing (from its detail and blockers) and give numbered steps to fix it. If the check offers an automatic fix, say so as the first step when it applies.',
    links: [{ label: 'Open readiness', href: '/readiness' }]
  }
}

// #1910 — a partner failure on an Integrations console row
const gatherSignalRow: Gatherer = async (params) => {
  const signal = str(params, 'signal')
  // The console knows a row by its key; the numeric id is accepted too.
  const rowKey = typeof params.row_key === 'string' ? params.row_key.slice(0, 300) : ''
  const rowQuery = db('nivaro_integration_signal_rows')
  const row = (await (rowKey
    ? rowQuery.where({ signal, row_key: rowKey }).whereNull('cleared_at')
    : rowQuery.where({ id: Number(str(params, 'id')), signal })
  ).first('signal', 'row_key', 'payload', 'first_seen', 'last_seen', 'cleared_at')) as
    | Record<string, unknown>
    | undefined
  if (!row) throw new ExplainError(404, 'That row is no longer open')
  let payload: Record<string, unknown> = {}
  try {
    payload = JSON.parse(String(row.payload)) as Record<string, unknown>
  } catch {
    /* keep empty */
  }
  const apiName = typeof payload.api === 'string' ? payload.api : null
  const api = apiName
    ? ((await db('nivaro_external_apis')
        .where({ name: apiName })
        .first('id', 'name', 'base_url', 'owner_user', 'ack_grace_minutes')
        .catch(() => null)) as {
        id: number
        name: string
        base_url: string | null
        owner_user: string | null
        ack_grace_minutes: number | null
      } | null)
    : null
  const owner = await userName(api?.owner_user)
  const latest = api
    ? ((await db('nivaro_erp_submissions')
        .where({ external_api: api.id })
        .whereIn('status', ['failed', 'rejected'])
        .orderBy('id', 'desc')
        .first('id', 'status', 'last_error', 'error_class', 'attempts', 'created_at')
        .catch(() => null)) as Record<string, unknown> | null)
    : null
  let host: string | null = null
  try {
    host = api?.base_url ? new URL(api.base_url).host : null
  } catch {
    host = null
  }
  const contacts = owner
    ? [{ role: 'Integration owner', name: owner.name, email: owner.email }]
    : []
  return {
    title: String(payload.title ?? `${signal} row`),
    facts: {
      signal,
      problem: {
        title: payload.title,
        detail: payload.detail,
        since: payload.since,
        first_seen: iso(row.first_seen),
        last_seen: iso(row.last_seen)
      },
      partner: api ? { name: api.name, host, ack_grace_minutes: api.ack_grace_minutes } : null,
      latest_failed_push: latest
        ? { ...latest, last_error: firstLineScrubbed(latest.last_error) }
        : latest,
      error_class_meanings: {
        transient: 'a retry is usually safe',
        rate_limited: 'a retry is safe after waiting',
        auth: 'credentials or access need fixing first',
        not_found: 'the target record does not exist on the partner',
        validation: 'the payload was refused; retrying the same payload fails again',
        unknown: 'not classified'
      },
      owner_known: !!owner
    },
    instructions:
      'Explain the plain cause of this partner failure from the partner response and the error class, whether a retry is safe (set retry_safe), and who to contact (the integration owner given in facts, or say none is set).',
    links: [{ label: 'Open the Integrations console', href: '/integration-health' }],
    contacts
  }
}

// #1963 — a webhook delivery
const gatherWebhookDelivery: Gatherer = async (params) => {
  const id = Number(str(params, 'id'))
  const d = (await db('nivaro_webhook_deliveries').where({ id }).first()) as
    | Record<string, unknown>
    | undefined
  if (!d) throw new ExplainError(404, 'Delivery not found')
  const hook = (await db('nivaro_webhooks')
    .where({ id: d.webhook as number })
    .first('name', 'url', 'method', 'events')) as Record<string, unknown> | undefined
  const recent = (await db('nivaro_webhook_deliveries')
    .where({ webhook: d.webhook as number })
    .orderBy('id', 'desc')
    .limit(12)
    .select('status_code', 'success', 'latency_ms', 'attempt', 'created_at')
    .catch(() => [])) as Array<Record<string, unknown>>
  let host: string | null = null
  try {
    host = hook?.url ? new URL(String(hook.url)).host : null
  } catch {
    host = null
  }
  return {
    title: `Webhook delivery #${id}${hook?.name ? ` (${hook.name})` : ''}`,
    facts: {
      delivery: {
        event: d.event,
        status_code: d.status_code,
        success: !!d.success,
        latency_ms: d.latency_ms,
        attempt: d.attempt,
        at: iso(d.created_at),
        receiver_response: firstLineScrubbed(d.response_body)
      },
      webhook: hook
        ? { name: hook.name, receiver_host: host, method: hook.method, events: hook.events }
        : null,
      recent_deliveries: recent.map((r) => ({
        ...r,
        created_at: iso(r.created_at),
        success: !!r.success
      }))
    },
    instructions:
      'Explain the cause of this webhook delivery failure from the receiver response and status code, whether replaying/retrying is safe (set retry_safe; a receiver that may have processed the event makes a retry unsafe unless it is idempotent), and what to change on our side or theirs.',
    links: [{ label: 'Open webhooks', href: '/webhooks' }]
  }
}

// #1919 — a slow page (route)
const gatherRumRoute: Gatherer = async (params) => {
  const route = String(params.route ?? '').slice(0, 300)
  if (!route) throw new ExplainError(400, 'route is required')
  const days = Math.min(14, Math.max(1, Number(params.days) || 1))
  const since = new Date(Date.now() - days * 86_400_000)
  const rows = (await db('nivaro_rum_events')
    .where('route', route)
    .where('created_at', '>=', since)
    .select('kind', 'ttfb_ms', 'fcp_ms', 'lcp_ms', 'duration_ms')
    .limit(5000)) as Array<{
    kind: string
    ttfb_ms: number | null
    fcp_ms: number | null
    lcp_ms: number | null
    duration_ms: number | null
  }>
  if (rows.length === 0)
    throw new ExplainError(404, 'No real-user data for that route in the window')
  const p75 = (xs: Array<number | null>) => {
    const v = xs.filter((x): x is number => x != null).sort((a, b) => a - b)
    return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * 0.75))] : null
  }
  const loads = rows.filter((r) => r.kind === 'load')
  const navs = rows.filter((r) => r.kind === 'route')
  const slowApi = (await db('nivaro_api_logs')
    .where('created_at', '>=', since)
    .where('latency_ms', '>', 600)
    .groupBy('path')
    .select(
      'path',
      db.raw('COUNT(*) as n'),
      db.raw('MAX(latency_ms) as max_ms'),
      db.raw('AVG(latency_ms) as avg_ms')
    )
    .orderBy('n', 'desc')
    .limit(10)
    .catch(() => [])) as Array<{ path: string; n: number; max_ms: number; avg_ms: number }>
  const { listTraces } = await import('./request-trace.js')
  const traces = listTraces(200)
    .slice(0, 8)
    .map((t) => ({
      route: `${t.method} ${t.route}`,
      total_ms: t.total_ms,
      sql_ms: t.sql_ms,
      queries: t.queries
    }))
  return {
    title: `Page ${route}`,
    facts: {
      route,
      window_days: days,
      full_page_loads: {
        count: loads.length,
        p75_ttfb_ms: p75(loads.map((r) => r.ttfb_ms)),
        p75_fcp_ms: p75(loads.map((r) => r.fcp_ms)),
        p75_lcp_ms: p75(loads.map((r) => r.lcp_ms))
      },
      in_app_navigations: {
        count: navs.length,
        p75_duration_ms: p75(navs.map((r) => r.duration_ms))
      },
      thresholds: 'good LCP < 2500 ms, good TTFB < 800 ms',
      slow_api_requests_all_pages: slowApi.map((s) => ({
        path: s.path,
        slow_count: Number(s.n),
        avg_ms: Math.round(Number(s.avg_ms)),
        max_ms: s.max_ms
      })),
      slowest_traces_in_memory: traces,
      note: 'API requests and traces are not tied to this page specifically; treat them as likely suspects.'
    },
    instructions:
      'Explain where the time goes for this page (server wait vs rendering/paint vs navigation) and what would help most. Be clear that the request list is not page-specific.',
    links: [{ label: 'Open API analytics', href: '/api-analytics' }]
  }
}

// #1813 — describe a configuration
const gatherConfig: Gatherer = async (params) => {
  const type = str(params, 'type')
  if (type === 'pipeline') {
    const id = str(params, 'id')
    const t = (await db('nivaro_workflow_templates').where({ id }).first('name', 'description')) as
      | { name: string; description: string | null }
      | undefined
    if (!t) throw new ExplainError(404, 'Pipeline not found')
    const [states, transitions, groups] = (await Promise.all([
      db('nivaro_workflow_states')
        .where({ template: id })
        .orderBy('sort')
        .select(
          'id',
          'key',
          'label',
          'is_initial',
          'is_terminal',
          'skip_criteria',
          'owners_not_required'
        ),
      db('nivaro_workflow_transitions')
        .where({ template: id })
        .orderBy('sort')
        .select(
          'from_state',
          'to_state',
          'label',
          'required_roles',
          'auto_trigger',
          'condition_rules',
          'group_label'
        ),
      db('nivaro_pipeline_owner_groups')
        .join('nivaro_workflow_states as s', 's.id', 'nivaro_pipeline_owner_groups.state')
        .where('s.template', id)
        .groupBy('s.label')
        .select('s.label as state', db.raw('COUNT(*) as groups'))
    ])) as [
      Array<Record<string, unknown>>,
      Array<Record<string, unknown>>,
      Array<Record<string, unknown>>
    ]
    const label = new Map(states.map((s) => [String(s.id), String(s.label)]))
    const roleIds = [...new Set(transitions.flatMap((tr) => safeList(tr.required_roles)))]
    const roles = roleIds.length
      ? ((await db('nivaro_roles').whereIn('id', roleIds).select('id', 'name')) as Array<{
          id: string
          name: string
        }>)
      : []
    const roleName = new Map(roles.map((r) => [String(r.id).toUpperCase(), r.name]))
    return {
      title: `Pipeline ${t.name}`,
      facts: {
        name: t.name,
        description: t.description,
        states: states.map((s) => ({
          label: s.label,
          key: s.key,
          initial: !!s.is_initial,
          terminal: !!s.is_terminal,
          skip_rules: s.skip_criteria ? safeJson(s.skip_criteria) : null,
          owners_not_required: !!s.owners_not_required
        })),
        transitions: transitions.map((tr) => ({
          from: tr.from_state ? label.get(String(tr.from_state)) : 'any state',
          to: label.get(String(tr.to_state)),
          label: tr.label,
          automatic: !!tr.auto_trigger,
          roles: safeList(tr.required_roles).map(
            (r) => roleName.get(String(r).toUpperCase()) ?? 'a role'
          ),
          conditions: tr.condition_rules ? safeJson(tr.condition_rules) : null
        })),
        owner_groups_per_state: groups
      },
      instructions:
        'Describe this pipeline in plain English for an admin: the path a record takes through its states, who approves what, which steps can be skipped or happen automatically, and the send-back routes. Short paragraphs; one step per line is fine. Put the description in "summary"; steps may stay empty.',
      links: []
    }
  }
  if (type === 'field-rules') {
    const collection = str(params, 'collection')
    const rules = await db('nivaro_field_rules')
      .where({ collection, is_active: true })
      .orderBy('sort')
      .select(
        'trigger_field',
        'trigger_op',
        'trigger_value',
        'target_field',
        'target_type',
        'target_value',
        'only_when_empty'
      )
    return {
      title: `Field rules on ${collection}`,
      facts: { collection, rules },
      instructions:
        'Describe in plain English what these field rules do when someone edits a record, grouped by what triggers them. Put it in "summary"; steps may stay empty.'
    }
  }
  if (type === 'layout') {
    const id = Number(str(params, 'id'))
    const l = (await db('nivaro_collection_layouts')
      .where({ id })
      .first('name', 'collection', 'layout_type', 'tab_mode', 'conditions')) as
      | Record<string, unknown>
      | undefined
    if (!l) throw new ExplainError(404, 'Layout not found')
    const [groups, assignments] = (await Promise.all([
      db('nivaro_field_groups')
        .where({ layout_id: id })
        .orderBy('sort')
        .select('key', 'label', 'type'),
      db('nivaro_layout_field_assignments')
        .where({ layout_id: id })
        .orderBy('sort')
        .select('field', 'group_key', 'overrides')
    ])) as [Array<Record<string, unknown>>, Array<Record<string, unknown>>]
    return {
      title: `Layout ${l.name}`,
      facts: {
        layout: l,
        groups,
        fields: assignments.map((a) => {
          const o = safeJson(a.overrides) as {
            options?: { row_rules?: unknown }
            readonly?: boolean
            required?: boolean
          } | null
          return {
            field: a.field,
            group: a.group_key,
            readonly: o?.readonly,
            required: o?.required,
            grid_row_rules: o?.options?.row_rules
          }
        })
      },
      instructions:
        'Describe this layout in plain English: how the form is organised (sections/steps), who sees it, and what each grid\'s row rules do. Put it in "summary"; steps may stay empty.'
    }
  }
  throw new ExplainError(400, 'type must be pipeline, field-rules or layout')
}

function safeJson(v: unknown): unknown {
  if (v == null) return null
  if (typeof v !== 'string') return v
  try {
    return JSON.parse(v)
  } catch {
    return null
  }
}
function safeList(v: unknown): string[] {
  const j = safeJson(v)
  return Array.isArray(j) ? j.map(String) : []
}

// #2021 — the data model
const gatherDataModel: Gatherer = async () => {
  const [collections, relations, bindings] = (await Promise.all([
    db('nivaro_collections')
      .where((q) => q.whereNull('hidden').orWhere('hidden', false))
      .select('collection', 'display_name', 'singular', 'is_virtual')
      .limit(300),
    db('nivaro_relations')
      .whereNotNull('one_collection')
      .select('many_collection', 'many_field', 'one_collection', 'junction_field')
      .limit(2000),
    db('nivaro_workflow_bindings as b')
      .join('nivaro_workflow_templates as t', 't.id', 'b.template')
      .select('b.collection', 't.name as pipeline')
      .limit(100)
  ])) as [
    Array<Record<string, unknown>>,
    Array<Record<string, unknown>>,
    Array<Record<string, unknown>>
  ]
  const names = new Set(collections.map((c) => String(c.collection)))
  const rel = relations.filter(
    (r) => names.has(String(r.many_collection)) && names.has(String(r.one_collection))
  )
  const degree = new Map<string, number>()
  for (const r of rel)
    for (const k of [r.many_collection, r.one_collection])
      degree.set(String(k), (degree.get(String(k)) ?? 0) + 1)
  const ranked = [...collections]
    .sort(
      (a, b) => (degree.get(String(b.collection)) ?? 0) - (degree.get(String(a.collection)) ?? 0)
    )
    .slice(0, 60)
  const keep = new Set(ranked.map((c) => String(c.collection)))
  return {
    title: 'The data model',
    facts: {
      collection_count: collections.length,
      main_collections: ranked.map((c) => ({
        name: c.collection,
        label: c.display_name,
        links: degree.get(String(c.collection)) ?? 0
      })),
      relations: rel
        .filter((r) => keep.has(String(r.many_collection)) && keep.has(String(r.one_collection)))
        .slice(0, 150)
        .map(
          (r) =>
            `${r.many_collection}.${r.many_field} -> ${r.one_collection}${r.junction_field ? ' (many-to-many)' : ''}`
        ),
      pipelines: bindings
    },
    instructions:
      'Describe the data model for a new admin or partner developer: the main records, how they relate (parent/child, many-to-many), and the life cycle of the main ones using the pipelines given. Plain words, short paragraphs in "summary"; steps may be a short reading order ("start with ..."), at most 6.',
    links: [{ label: 'Open the ERD', href: '/data-model/erd' }]
  }
}

export const GATHERERS: Record<string, Gatherer> = {
  issue: gatherIssue,
  trace: gatherTrace,
  'import-run': gatherImportRun,
  'job-run': gatherJobRun,
  readiness: gatherReadiness,
  'signal-row': gatherSignalRow,
  'webhook-delivery': gatherWebhookDelivery,
  'rum-route': gatherRumRoute,
  config: gatherConfig,
  'data-model': gatherDataModel
}

export async function explainKind(
  kind: string,
  params: Record<string, unknown>,
  user: User,
  opts: ExplainOptions = {}
): Promise<ExplainAnswer> {
  const g = GATHERERS[kind]
  if (!g) throw new ExplainError(404, `Unknown explain kind: ${kind}`)
  const facts = await g(params, user)
  return explainFacts(kind, facts, opts)
}
