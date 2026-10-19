import type Anthropic from '@anthropic-ai/sdk'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { scrubText } from './ai-explain.js'
import { parseRoom } from './chat.js'
import { executeTelemetryTool, TELEMETRY_TOOL_NAMES, TELEMETRY_TOOLS } from './telemetry-ai.js'
import { storeEnabled } from './telemetry-store.js'

/**
 * The chat assistant's ops tools (#1967, #2015).
 *
 * In an admin-only channel — a channel (never a DM, a record room or an open
 * channel) whose every member is an active administrator, checked against
 * the database at the moment of each call — an administrator can ask the
 * assistant "anything failing right now?" and it answers from the request
 * log, issues, background jobs, imports, partner pushes and readiness. It
 * may also PROPOSE an action (services/ops-proposals.ts); nothing runs until
 * an administrator approves the card. Everywhere else the tools are not
 * offered, and a call that slips through is refused.
 *
 * What reaches the AI provider: counts, method + path patterns, job ids and
 * labels, issue titles, collection names and submission ids — scrubbed with
 * scrubText. Never request bodies, record values or people's names.
 */

export const OPS_REFUSAL =
  'Ops tools are only available to administrators in an admin-only channel (every member an administrator).'

/**
 * Fresh read: status exactly 'active' (not merely "not suspended" — a
 * provisional or pending account is not an administrator yet), unredacted,
 * and the CURRENT role has admin_access.
 */
export async function isActiveAdmin(userId: string | null | undefined): Promise<boolean> {
  if (!userId) return false
  const { activeAdminIds } = await import('./ops-room-guard.js')
  return (await activeAdminIds([String(userId)])).has(String(userId).toUpperCase())
}

/**
 * Whether a room is an admin-only channel right now. Reads the channel and
 * its memberships straight from the database (no cache): a channel opened
 * up, or a non-admin added, stops the tools at the next question.
 */
export async function opsRoomVerdict(room: string): Promise<{ ok: boolean; reason?: string }> {
  const parsed = parseRoom(room)
  if (parsed.kind !== 'channel' || !parsed.channelKey) return { ok: false, reason: 'not a channel' }
  const ch = (await db('nivaro_chat_channels')
    .where({ key: parsed.channelKey })
    .first('id', 'visibility', 'role', 'is_archived')
    .catch(() => undefined)) as
    | { visibility?: string; role?: string | null; is_archived?: boolean | number }
    | undefined
  if (!ch || ch.is_archived) return { ok: false, reason: 'no such channel' }
  if (ch.visibility !== 'private' && ch.visibility !== 'role')
    return { ok: false, reason: 'the channel is open to everyone' }
  if (ch.visibility === 'role') {
    const role = (await db('nivaro_roles')
      .where({ id: ch.role ?? null })
      .first('admin_access')
      .catch(() => undefined)) as { admin_access?: boolean | number } | undefined
    if (!role?.admin_access) return { ok: false, reason: 'the channel is open to a non-admin role' }
  }
  const members = (
    (await db('nivaro_chat_memberships')
      .where({ room })
      .select('user')
      .catch(() => [])) as Array<{ user: string }>
  ).map((m) => String(m.user))
  if (members.length === 0) return { ok: false, reason: 'the channel has no members' }
  const { activeAdminIds } = await import('./ops-room-guard.js')
  const admins = await activeAdminIds(members)
  if (members.some((m) => !admins.has(m.toUpperCase())))
    return { ok: false, reason: 'a member is not an administrator' }
  return { ok: true }
}

/** Both halves, at call time: the asker is an admin AND the room is admin-only. */
export async function opsToolsAllowed(asker: User, room: string | null | undefined) {
  if (!room) return false
  if (!(await isActiveAdmin(String(asker.id)))) return false
  return (await opsRoomVerdict(room)).ok
}

// ── Facts ────────────────────────────────────────────────────────────────────

export const OPS_SECTIONS = [
  'overview',
  'traffic',
  'issues',
  'jobs',
  'imports',
  'pushes',
  'readiness'
] as const
export type OpsSection = (typeof OPS_SECTIONS)[number]

const iso = (d: unknown) => {
  const t = d ? new Date(d as string).getTime() : Number.NaN
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}
const clip = (s: unknown, n = 160) => scrubText(String(s ?? '')).slice(0, n)

async function trafficFacts() {
  const { instanceScope } = await import('./api-log-instances.js')
  const { normalizePath } = await import('./log-rule-suggest.js')
  const sc = await instanceScope({})
  const now = Date.now()
  const window = async (minutes: number) => {
    const row = (await sc
      .apply(db('nivaro_api_logs as l'), 'l.instance')
      .where('l.created_at', '>=', new Date(now - minutes * 60_000))
      .count('* as total')
      .select(
        db.raw('SUM(CASE WHEN l.status >= 500 THEN 1 ELSE 0 END) as e5'),
        db.raw('SUM(CASE WHEN l.status >= 400 AND l.status < 500 THEN 1 ELSE 0 END) as e4')
      )
      .avg({ avg_ms: 'l.latency_ms' })
      .max({ max_ms: 'l.latency_ms' })
      .first()
      .catch(() => undefined)) as Record<string, unknown> | undefined
    return {
      minutes,
      requests: Number(row?.total ?? 0),
      server_errors: Number(row?.e5 ?? 0),
      client_errors: Number(row?.e4 ?? 0),
      avg_ms: Math.round(Number(row?.avg_ms ?? 0)),
      max_ms: Number(row?.max_ms ?? 0)
    }
  }
  const failing = (await sc
    .apply(db('nivaro_api_logs as l'), 'l.instance')
    .where('l.created_at', '>=', new Date(now - 60 * 60_000))
    .where('l.status', '>=', 500)
    .orderBy('l.created_at', 'desc')
    .limit(1000)
    .select('l.method', 'l.path', 'l.status')
    .catch(() => [])) as Array<{ method: string; path: string; status: number }>
  const byPath = new Map<string, number>()
  for (const r of failing) {
    const k = `${r.method} ${normalizePath(r.path)} ${r.status}`
    byPath.set(k, (byPath.get(k) ?? 0) + 1)
  }
  const slow = (await sc
    .apply(db('nivaro_api_logs as l'), 'l.instance')
    .where('l.created_at', '>=', new Date(now - 15 * 60_000))
    .groupBy('l.method', 'l.path')
    .havingRaw('COUNT(*) >= 3')
    .select('l.method', 'l.path')
    .avg({ avg_ms: 'l.latency_ms' })
    .count('* as calls')
    .orderBy('avg_ms', 'desc')
    .limit(5)
    .catch(() => [])) as Array<Record<string, unknown>>
  const { activeBreakers } = await import('./traffic-breaker.js')
  return {
    last_15_min: await window(15),
    last_60_min: await window(60),
    top_failing_last_hour: [...byPath.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([k, n]) => ({ request: k, count: n })),
    slowest_last_15_min: slow.map((r) => ({
      request: `${r.method} ${normalizePath(String(r.path))}`,
      avg_ms: Math.round(Number(r.avg_ms) || 0),
      calls: Number(r.calls) || 0
    })),
    circuit_breakers: activeBreakers().map((b) => ({
      kind: b.kind,
      target: b.target,
      mode: b.mode,
      until: iso(b.until)
    }))
  }
}

async function issueFacts() {
  const rows = (await db('nivaro_issues')
    .whereIn('status', ['open', 'acknowledged'])
    .orderBy('last_seen_at', 'desc')
    .limit(12)
    .select('id', 'title', 'severity', 'status', 'occurrence_count', 'last_seen_at')
    .catch(() => [])) as Array<Record<string, unknown>>
  const counts = (await db('nivaro_issues')
    .whereIn('status', ['open', 'acknowledged'])
    .groupBy('severity')
    .select('severity')
    .count('* as n')
    .catch(() => [])) as Array<{ severity: string; n: number | string }>
  return {
    open_by_severity: Object.fromEntries(counts.map((c) => [c.severity, Number(c.n)])),
    latest: rows.map((r) => ({
      id: Number(r.id),
      title: clip(r.title),
      severity: r.severity,
      status: r.status,
      occurrences: Number(r.occurrence_count) || 1,
      last_seen: iso(r.last_seen_at)
    }))
  }
}

async function jobFacts(app: FastifyInstance) {
  const since = new Date(Date.now() - 24 * 3_600_000)
  const [running, failed] = await Promise.all([
    db('nivaro_job_runs')
      .where('status', 'running')
      .orderBy('started_at', 'asc')
      .limit(15)
      .select('job_id', 'label', 'kind', 'started_at')
      .catch(() => []) as Promise<Array<Record<string, unknown>>>,
    db('nivaro_job_runs')
      .whereIn('status', ['error', 'interrupted'])
      .where('started_at', '>=', since)
      .orderBy('started_at', 'desc')
      .limit(15)
      .select('job_id', 'label', 'kind', 'status', 'started_at', 'error')
      .catch(() => []) as Promise<Array<Record<string, unknown>>>
  ])
  const crons = (app as FastifyInstance & { cron?: { list(): Array<Record<string, unknown>> } })
    .cron
  const list = crons?.list() ?? []
  return {
    running: running.map((r) => ({
      job_id: r.job_id,
      label: r.label ? clip(r.label, 80) : null,
      running_minutes: Math.round((Date.now() - new Date(r.started_at as Date).getTime()) / 60_000)
    })),
    failed_last_24h: failed.map((r) => ({
      job_id: r.job_id,
      status: r.status,
      at: iso(r.started_at),
      error: r.error ? clip(r.error, 200) : null
    })),
    paused: list.filter((j) => j.paused).map((j) => j.id),
    scheduled_job_ids: list.map((j) => j.id).slice(0, 200)
  }
}

async function importFacts() {
  const since = new Date(Date.now() - 24 * 3_600_000)
  const rows = (await db('nivaro_import_jobs')
    .where('created_at', '>=', since)
    .orderBy('created_at', 'desc')
    .limit(20)
    .select('id', 'collection', 'status', 'created_at')
    .catch(() => [])) as Array<Record<string, unknown>>
  const byStatus: Record<string, number> = {}
  for (const r of rows) byStatus[String(r.status)] = (byStatus[String(r.status)] ?? 0) + 1
  return {
    last_24h_by_status: byStatus,
    latest: rows.slice(0, 8).map((r) => ({
      id: String(r.id),
      collection: r.collection,
      status: r.status,
      at: iso(r.created_at)
    }))
  }
}

async function pushFacts() {
  const since = new Date(Date.now() - 48 * 3_600_000)
  const rows = (await db('nivaro_erp_submissions')
    .whereIn('status', ['failed', 'rejected'])
    .where('updated_at', '>=', since)
    .orderBy('updated_at', 'desc')
    .limit(15)
    .select('id', 'collection', 'status', 'attempts', 'last_error', 'updated_at')
    .catch(() => [])) as Array<Record<string, unknown>>
  return {
    failed_or_rejected_last_48h: rows.map((r) => ({
      submission_id: Number(r.id),
      collection: r.collection,
      status: r.status,
      attempts: Number(r.attempts) || 0,
      error: r.last_error ? clip(r.last_error, 160) : null,
      at: iso(r.updated_at)
    }))
  }
}

async function readinessFacts() {
  const { runReadinessChecks } = await import('./readiness.js')
  const timeout = new Promise<null>((r) => setTimeout(() => r(null), 10_000))
  const report = await Promise.race([runReadinessChecks().catch(() => null), timeout])
  if (!report) return { unavailable: 'Readiness checks did not finish in 10 seconds' }
  return {
    score: report.score,
    counts: report.counts,
    not_passing: report.checks
      .filter((c) => c.status !== 'pass' && c.status !== 'skip')
      .slice(0, 12)
      .map((c) => ({ id: c.id, label: c.label, status: c.status, detail: clip(c.detail, 160) }))
  }
}

export async function opsFacts(app: FastifyInstance, section: OpsSection) {
  switch (section) {
    case 'traffic':
      return { traffic: await trafficFacts() }
    case 'issues':
      return { issues: await issueFacts() }
    case 'jobs':
      return { jobs: await jobFacts(app) }
    case 'imports':
      return { imports: await importFacts() }
    case 'pushes':
      return { pushes: await pushFacts() }
    case 'readiness':
      return { readiness: await readinessFacts() }
    default: {
      const [traffic, issues, jobs, pushes] = await Promise.all([
        trafficFacts(),
        issueFacts(),
        jobFacts(app),
        pushFacts()
      ])
      const { currentIncident } = await import('./ops-incidents.js')
      const incident = await currentIncident().catch(() => null)
      return {
        traffic,
        issues,
        jobs: { ...jobs, scheduled_job_ids: undefined },
        pushes,
        incident_mode: incident
          ? { on: true, title: incident.title, since: incident.started_at }
          : { on: false }
      }
    }
  }
}

// ── Tools ────────────────────────────────────────────────────────────────────

export const OPS_STATUS_TOOL: Anthropic.Tool = {
  name: 'ops_status',
  description:
    'Live operations facts for administrators: overview (everything below at once), traffic (request volume, errors, slow paths, circuit breakers), issues (open errors), jobs (running, failed, paused background jobs), imports, pushes (failed partner submissions), readiness. Use for "anything failing right now?", "why is it slow?", "did the import run?".',
  input_schema: {
    type: 'object',
    properties: { section: { type: 'string', enum: [...OPS_SECTIONS] } },
    required: ['section']
  }
}

export const OPS_PROPOSE_TOOL: Anthropic.Tool = {
  name: 'propose_ops_action',
  description:
    'Propose ONE operations action as an approval card in this channel. Nothing runs until an administrator approves it. Actions: pause_job (job_id from ops_status jobs), open_breaker (refuse or rate-limit one noisy caller or entity for some minutes: target_kind caller with target "k<keyId>" or "u<USER-UUID>", or target_kind entity with "<lane>/<entity>"), retry_push (submission_id of a failed partner push), incident_mode (incident_on true/false, title). Always give a short reason.',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['pause_job', 'open_breaker', 'retry_push', 'incident_mode']
      },
      reason: { type: 'string' },
      job_id: { type: 'string' },
      target_kind: { type: 'string', enum: ['caller', 'entity'] },
      target: { type: 'string' },
      mode: { type: 'string', enum: ['refuse', 'limit'] },
      minutes: { type: 'integer' },
      limit: { type: 'integer', description: 'Requests per minute, for mode limit.' },
      submission_id: { type: 'integer' },
      incident_on: { type: 'boolean' },
      title: { type: 'string' }
    },
    required: ['action', 'reason']
  }
}

export const OPS_TOOL_NAMES = new Set([
  OPS_STATUS_TOOL.name,
  OPS_PROPOSE_TOOL.name,
  ...TELEMETRY_TOOL_NAMES
])

/** #2544 — the telemetry tools join the ops tools when this instance has a telemetry store. */
export function opsTelemetryTools(): Anthropic.Tool[] {
  return storeEnabled() ? TELEMETRY_TOOLS : []
}

export const OPS_PROMPT =
  'This channel is an admin-only operations channel. You may use ops_status for live facts and propose_ops_action to suggest an action; proposals become approval cards that an administrator must approve — never say an action ran until it is approved. When telemetry tools are offered (telemetry_status, request_stats, find_requests, slow_traces, get_trace, metric_series, search_logs), use them for history and "why was it slow at …" questions: they reach weeks back, cite trace ids and times (UTC), and never guess numbers.'

/**
 * Run an ops tool for the asker. Re-checks the asker and the room on EVERY
 * call (a tool list built a moment ago is not a permission).
 */
export async function executeOpsTool(
  app: FastifyInstance,
  asker: User,
  room: string | null | undefined,
  name: string,
  input: Record<string, unknown>
): Promise<unknown> {
  if (!(await opsToolsAllowed(asker, room))) throw new Error(OPS_REFUSAL)
  if (name === OPS_STATUS_TOOL.name) {
    const section = (OPS_SECTIONS as readonly string[]).includes(String(input.section))
      ? (input.section as OpsSection)
      : 'overview'
    return opsFacts(app, section)
  }
  if (TELEMETRY_TOOL_NAMES.has(name)) return executeTelemetryTool(name, input)
  if (name === OPS_PROPOSE_TOOL.name) {
    const { createProposal } = await import('./ops-proposals.js')
    const p = await createProposal(app, asker, room as string, input)
    return {
      proposal_id: p.id,
      status: 'awaiting approval',
      card: 'An approval card was posted in this channel; nothing has run.',
      summary: p.summary
    }
  }
  throw new Error(`Unknown ops tool ${name}`)
}
