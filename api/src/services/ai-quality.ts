import { db } from '../db/index.js'
import type { AiSettingsRow } from './ai-client.js'
import { costOf, featureFromRoute } from './ai-log.js'
import { getIo } from './io-holder.js'
import { currentTraceMeta } from './request-trace.js'
import { currentStoreId } from './traffic-taps.js'
import { watchRoomId } from './watch-rooms.js'

/**
 * AI quality and cost controls — budgets (#1817), the provider failure
 * fallback (#1821), cost estimates for compare/replay (#1866, #1916) and the
 * cause triage for poor answers (#1862).
 *
 * The configuration lives inside the existing `nivaro_settings.ai_models`
 * JSON under the reserved key `_quality`, so it needs no migration. The
 * settings PATCH preserves that key when the model map is saved from the
 * Settings page (see routes/settings.ts), and `parseAiModels` ignores it.
 *
 * Everything here is OFF until an admin sets it: no budgets means no limit
 * (today's behaviour), no fallback model means a provider failure reports
 * "AI is unavailable" instead of a raw error.
 */

// ─── configuration ───────────────────────────────────────────────────────────

export type BudgetWho = 'everyone' | 'person' | 'role'

export interface BudgetCap {
  id: string
  /** everyone = each person; person = one named person; role = each member of a role. */
  who: BudgetWho
  /** user id (person) or role id (role); null for everyone. */
  who_id: string | null
  /** Limit to one AI feature (chat, generate, …); null = all features. */
  feature: string | null
  /** true = one shared pool across everyone matched, false = each person has the cap. */
  pooled: boolean
  daily_usd: number
  /** Used instead of stopping once the cap is reached. */
  cheaper_model: string | null
}

export interface QualityConfig {
  budgets: { enabled: boolean; caps: BudgetCap[] }
  /** Second model on the SAME configured provider, tried when a call fails. */
  fallback_model: string | null
}

export const DEFAULT_QUALITY: QualityConfig = {
  budgets: { enabled: false, caps: [] },
  fallback_model: null
}

const str = (v: unknown, max = 120): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null

/** Lenient read — anything malformed degrades to "no limit", never an error. */
export function parseQualityConfig(raw: unknown): QualityConfig {
  let obj: unknown = raw
  if (typeof raw === 'string') {
    try {
      obj = raw ? JSON.parse(raw) : null
    } catch {
      obj = null
    }
  }
  const q =
    obj && typeof obj === 'object' && !Array.isArray(obj)
      ? (obj as Record<string, unknown>)._quality
      : null
  if (!q || typeof q !== 'object') return structuredClone(DEFAULT_QUALITY)
  const qq = q as Record<string, unknown>
  const b = (qq.budgets && typeof qq.budgets === 'object' ? qq.budgets : {}) as Record<
    string,
    unknown
  >
  const caps: BudgetCap[] = []
  for (const c of Array.isArray(b.caps) ? b.caps : []) {
    const cap = normalizeCap(c)
    if (cap) caps.push(cap)
  }
  return {
    budgets: { enabled: b.enabled === true, caps },
    fallback_model: str(qq.fallback_model, 100)
  }
}

/** Strict read of one cap; null when it cannot be understood. */
export function normalizeCap(c: unknown): BudgetCap | null {
  if (!c || typeof c !== 'object') return null
  const o = c as Record<string, unknown>
  const who: BudgetWho = o.who === 'person' || o.who === 'role' ? o.who : 'everyone'
  const usd = Number(o.daily_usd)
  if (!Number.isFinite(usd) || usd < 0) return null
  const whoId = who === 'everyone' ? null : str(o.who_id, 64)
  if (who !== 'everyone' && !whoId) return null
  return {
    id: str(o.id, 40) ?? Math.random().toString(36).slice(2, 10),
    who,
    who_id: whoId,
    feature: str(o.feature, 60),
    pooled: o.pooled === true,
    daily_usd: Math.round(usd * 10_000) / 10_000,
    cheaper_model: str(o.cheaper_model, 100)
  }
}

/** Merge a quality block into the stored ai_models JSON, keeping the model map. */
export function mergeQualityIntoModels(
  rawModels: string | null | undefined,
  quality: QualityConfig
): string {
  let base: Record<string, unknown> = {}
  try {
    const p = rawModels ? JSON.parse(rawModels) : null
    if (p && typeof p === 'object' && !Array.isArray(p)) base = p as Record<string, unknown>
  } catch {
    base = {}
  }
  base._quality = quality
  return JSON.stringify(base)
}

/** A new model map from the Settings page must not wipe the hidden quality block. */
export function preserveQuality(
  incoming: unknown,
  existingRaw: string | null | undefined
): string | null {
  if (incoming == null) return null
  let obj: Record<string, unknown> = {}
  if (typeof incoming === 'string') {
    try {
      const p = JSON.parse(incoming)
      if (p && typeof p === 'object' && !Array.isArray(p)) obj = p as Record<string, unknown>
    } catch {
      return incoming
    }
  } else if (typeof incoming === 'object' && !Array.isArray(incoming)) {
    obj = { ...(incoming as Record<string, unknown>) }
  } else return null
  if (obj._quality === undefined) {
    try {
      const prev = existingRaw ? JSON.parse(existingRaw) : null
      if (prev && typeof prev === 'object' && prev._quality) obj._quality = prev._quality
    } catch {
      // nothing to keep
    }
  }
  return JSON.stringify(obj)
}

// ─── budgets ─────────────────────────────────────────────────────────────────

/** Start of the current budget day (UTC) and when it next resets. */
export function budgetDay(now = new Date()): { start: Date; resets_at: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  return { start, resets_at: new Date(start.getTime() + 86_400_000) }
}

export interface BudgetSubject {
  userId: string | null
  roleId: string | null
  feature: string
}

/** Does this cap apply to the subject at all? */
export function capApplies(cap: BudgetCap, s: BudgetSubject): boolean {
  if (cap.feature && cap.feature !== s.feature) return false
  if (cap.who === 'person')
    return !!s.userId && s.userId.toUpperCase() === cap.who_id?.toUpperCase()
  if (cap.who === 'role') return !!s.roleId && s.roleId.toUpperCase() === cap.who_id?.toUpperCase()
  // everyone: a per-person cap needs a person; a pooled cap does not
  return cap.pooled || !!s.userId
}

export interface CapStatus {
  cap: BudgetCap
  used_usd: number
  remaining_usd: number
  over: boolean
}

export interface BudgetVerdict {
  /** A cap with no cheaper model has been reached: the call must stop. */
  blocked: CapStatus | null
  /** A cap with a cheaper model has been reached: use this model instead. */
  cheaper_model: string | null
  /** The tightest remaining allowance across the caps that apply (null = no cap). */
  remaining_usd: number | null
  statuses: CapStatus[]
}

/** Pure: caps + a spend lookup -> what the call may do. */
export async function evaluateBudgets(
  cfg: QualityConfig,
  subject: BudgetSubject,
  spend: (cap: BudgetCap) => Promise<number>
): Promise<BudgetVerdict> {
  const out: BudgetVerdict = {
    blocked: null,
    cheaper_model: null,
    remaining_usd: null,
    statuses: []
  }
  if (!cfg.budgets.enabled) return out
  for (const cap of cfg.budgets.caps) {
    if (!capApplies(cap, subject)) continue
    const used = await spend(cap)
    const remaining = cap.daily_usd - used
    const over = remaining <= 0
    out.statuses.push({
      cap,
      used_usd: used,
      remaining_usd: Math.max(0, remaining),
      over
    })
    if (out.remaining_usd == null || Math.max(0, remaining) < out.remaining_usd)
      out.remaining_usd = Math.max(0, remaining)
    if (over) {
      if (cap.cheaper_model) out.cheaper_model ??= cap.cheaper_model
      else out.blocked ??= out.statuses[out.statuses.length - 1]
    }
  }
  return out
}

export class AiBudgetError extends Error {
  statusCode = 429
  code = 'AI_BUDGET_EXCEEDED'
  constructor(
    public cap: BudgetCap,
    public resets_at: Date
  ) {
    super(budgetMessage(cap, resets_at))
  }
}

export function budgetMessage(cap: BudgetCap, resetsAt: Date): string {
  const scope =
    cap.who === 'person'
      ? 'your daily AI budget'
      : cap.who === 'role'
        ? "your role's daily AI budget"
        : cap.feature
          ? `the daily AI budget for ${cap.feature}`
          : 'the daily AI budget'
  return `AI is paused: ${scope} of $${cap.daily_usd.toFixed(2)} has been reached. It resets at ${resetsAt.toISOString().slice(0, 16).replace('T', ' ')} UTC.`
}

const spendCache = new Map<string, { at: number; value: number }>()
const roleCache = new Map<string, { at: number; role: string | null }>()
const SPEND_TTL_MS = 15_000

export function bustAiBudgetCache(): void {
  spendCache.clear()
  roleCache.clear()
}

async function roleOf(userId: string): Promise<string | null> {
  const hit = roleCache.get(userId)
  if (hit && Date.now() - hit.at < 300_000) return hit.role
  const row = (await db('nivaro_users')
    .where({ id: userId })
    .select('role')
    .first()
    .catch(() => null)) as { role?: string | null } | null
  const role = row?.role ? String(row.role) : null
  roleCache.set(userId, { at: Date.now(), role })
  return role
}

/** Today's spend (USD, UTC day) for a cap, from the call log. */
async function spendFor(cap: BudgetCap, subject: BudgetSubject, start: Date): Promise<number> {
  const key = `${cap.id}|${cap.pooled ? '*' : subject.userId}|${start.getTime()}`
  const hit = spendCache.get(key)
  if (hit && Date.now() - hit.at < SPEND_TTL_MS) return hit.value
  const q = db('nivaro_ai_calls').where('created_at', '>=', start).sum({ total: 'cost_usd' })
  if (cap.feature) q.where({ feature: cap.feature })
  if (cap.pooled) {
    if (cap.who === 'person' && cap.who_id) q.where({ user: cap.who_id })
    else if (cap.who === 'role' && cap.who_id)
      q.whereIn('user', db('nivaro_users').select('id').where({ role: cap.who_id }))
  } else if (subject.userId) q.where({ user: subject.userId })
  const row = (await q.first().catch(() => null)) as { total?: unknown } | null
  const value = Number(row?.total ?? 0) || 0
  spendCache.set(key, { at: Date.now(), value })
  return value
}

export async function subjectFromTrace(): Promise<BudgetSubject> {
  const meta = currentTraceMeta()
  const userId = meta?.userId ?? null
  return {
    userId,
    roleId: userId ? await roleOf(userId) : null,
    feature: featureFromRoute(meta?.urlHint ?? null)
  }
}

/** The verdict for the call being made right now (the request trace names who). */
export async function budgetVerdict(
  cfg: QualityConfig,
  subject?: BudgetSubject
): Promise<BudgetVerdict & { resets_at: Date }> {
  const { start, resets_at } = budgetDay()
  if (!cfg.budgets.enabled || cfg.budgets.caps.length === 0)
    return { blocked: null, cheaper_model: null, remaining_usd: null, statuses: [], resets_at }
  const s = subject ?? (await subjectFromTrace())
  const v = await evaluateBudgets(cfg, s, (cap) => spendFor(cap, s, start))
  return { ...v, resets_at }
}

/** Raised by getAiClient: either a cheaper model, or a stop with a clear message. */
export async function applyBudget(
  cfg: QualityConfig,
  requestedModel: string | null | undefined
): Promise<{ model: string | null | undefined; downgraded: boolean }> {
  const v = await budgetVerdict(cfg)
  if (v.blocked) throw new AiBudgetError(v.blocked.cap, v.resets_at)
  if (v.cheaper_model && v.cheaper_model !== requestedModel)
    return { model: v.cheaper_model, downgraded: true }
  return { model: requestedModel, downgraded: false }
}

export function qualityFromSettings(s: AiSettingsRow | null | undefined): QualityConfig {
  return parseQualityConfig(s?.ai_models)
}

// ─── provider failure + fallback ─────────────────────────────────────────────

export class AiUnavailableError extends Error {
  statusCode = 503
  code = 'AI_UNAVAILABLE'
  constructor(detail?: string) {
    super(
      `AI is unavailable right now${detail ? ` (${detail})` : ''}. Try again in a few minutes; the rest of Nivaro keeps working.`
    )
  }
}

/** A failure of the provider itself — not a bad request, bad key or refused model. */
export function isProviderFailure(err: unknown): boolean {
  if (err instanceof AiBudgetError) return false
  const e = err as { status?: number; statusCode?: number; message?: string; code?: string }
  const msg = String(e?.message ?? '')
  const status =
    e?.status ??
    e?.statusCode ??
    (/AI gateway (\d{3})/.exec(msg)?.[1] ? Number(/AI gateway (\d{3})/.exec(msg)?.[1]) : undefined)
  if (typeof status === 'number') return status >= 500 || status === 429 || status === 408
  return /ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|timed? ?out|socket hang up|network/i.test(
    `${e?.code ?? ''} ${msg}`
  )
}

const fallbackNotes = new Map<string, { from: string; to: string; at: number }>()

export function noteFallbackUsed(from: string, to: string): void {
  const id = currentTraceMeta()?.id
  if (!id) return
  fallbackNotes.set(id, { from, to, at: Date.now() })
  if (fallbackNotes.size > 500) {
    const cutoff = Date.now() - 600_000
    for (const [k, v] of fallbackNotes) if (v.at < cutoff) fallbackNotes.delete(k)
  }
}

/** The sentence an answer carries when a fallback model wrote it; consumed once. */
export function takeFallbackNote(requestId: string | null | undefined): string | null {
  if (!requestId) return null
  const n = fallbackNotes.get(requestId)
  if (!n) return null
  fallbackNotes.delete(requestId)
  return `\n\n_Note: the usual AI model could not answer, so this answer was written by the fallback model (${n.to})._`
}

// ─── cost estimates (compare / replay) ───────────────────────────────────────

/** Roughly four characters per token — an estimate, labelled as one. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export interface CostEstimate {
  model: string
  calls: number
  input_tokens: number
  output_tokens: number
  /** null when the model has no known price. */
  cost_usd: number | null
}

export function estimateRun(
  model: string,
  perCall: { inputTokens: number; outputTokens: number },
  calls: number
): CostEstimate {
  const input = perCall.inputTokens * calls
  const output = perCall.outputTokens * calls
  return {
    model,
    calls,
    input_tokens: input,
    output_tokens: output,
    cost_usd: costOf(model, { input, output })
  }
}

// ─── poor-answer triage (#1862) ──────────────────────────────────────────────

export const CAUSES = [
  'wrong_tool',
  'wrong_filter',
  'missing_data',
  'permission',
  'misunderstood',
  'unclassified'
] as const
export type Cause = (typeof CAUSES)[number]

export interface TriageInput {
  question: string
  answer: string
  comment: string | null
  /** Tool names in call order. */
  tools: string[]
  /** Error messages tool calls returned. */
  toolErrors: string[]
}

/**
 * Cause of a thumbs-down answer, from the evidence in the log. A rules-based
 * guess in a fixed order (the strongest signal first): the admin can always
 * reassign it; the point is to sort the queue so common causes surface.
 */
export function classifyCause(i: TriageInput): Cause {
  const errs = i.toolErrors.join(' \n ').toLowerCase()
  const ans = i.answer.toLowerCase()
  const note = (i.comment ?? '').toLowerCase()
  if (
    /not allowed|permission|forbidden|cannot read|no access|can't see|do not have access|not found or you/.test(
      `${errs} ${ans}`
    ) ||
    /permission|access|not allowed|can't see|cannot see/.test(note)
  )
    return 'permission'
  if (/unknown tool|to-many relation|use .* instead of|wrong (tool|collection)/.test(errs))
    return 'wrong_tool'
  if (/wrong tool|should have (used|looked)|use the .* tool/.test(note)) return 'wrong_tool'
  if (
    /filter|operator|unknown field|invalid field|not a field|text operator|unplannable|cannot filter/.test(
      errs
    ) ||
    /wrong (filter|number|count|total|zone|region|year)|filter/.test(note)
  )
    return 'wrong_filter'
  if (
    /no (records|rows|results|matches|data)|couldn't find|could not find|nothing found|not available|no such|isn't any|is no data/.test(
      ans
    ) ||
    /missing|no data|empty|not there|should (exist|be there)/.test(note)
  )
    return 'missing_data'
  if (
    i.tools.length === 0 ||
    /not what i asked|misunderst|didn't answer|did not answer|wrong question|different question|not asking/.test(
      note
    )
  )
    return 'misunderstood'
  return 'unclassified'
}

export const CAUSE_LABELS: Record<Cause, string> = {
  wrong_tool: 'Wrong tool',
  wrong_filter: 'Wrong filter',
  missing_data: 'Missing data',
  permission: 'Permission',
  misunderstood: 'Misunderstood the question',
  unclassified: 'Unclassified'
}

/** Pull tool names and tool errors out of a request's logged calls. */
export function evidenceFromCalls(
  calls: Array<{ request: string | null; response: string | null }>
): { question: string; tools: string[]; toolErrors: string[]; answer: string } {
  let question = ''
  const tools: string[] = []
  const toolErrors: string[] = []
  let answer = ''
  const parse = (s: string | null): unknown => {
    if (!s) return null
    try {
      return JSON.parse(s)
    } catch {
      // a capped body is cut mid-JSON; the tail is lost, the head is not needed
      return null
    }
  }
  const textOf = (c: unknown): string =>
    typeof c === 'string'
      ? c
      : Array.isArray(c)
        ? c
            .map((b) =>
              b && typeof b === 'object' ? String((b as { text?: unknown }).text ?? '') : ''
            )
            .join(' ')
        : ''
  for (const c of calls) {
    const req = parse(c.request) as {
      messages?: Array<{ role?: string; content?: unknown }>
    } | null
    const msgs = req?.messages ?? []
    if (!question) {
      const first = msgs.find((m) => m.role === 'user')
      if (first) question = textOf(first.content).slice(0, 2000)
    }
    for (const m of msgs) {
      if (!Array.isArray(m.content)) continue
      for (const b of m.content as Array<Record<string, unknown>>) {
        if (
          b?.type === 'tool_result' &&
          (b.is_error === true || String(b.content ?? '').startsWith('Error:'))
        )
          toolErrors.push(String(b.content ?? '').slice(0, 300))
      }
    }
    const res = parse(c.response) as Array<Record<string, unknown>> | null
    if (Array.isArray(res)) {
      for (const b of res) {
        if (b?.type === 'tool_use' && typeof b.name === 'string') tools.push(b.name)
        if (b?.type === 'text') answer = String(b.text ?? '')
      }
    }
  }
  return { question, tools, toolErrors: [...new Set(toolErrors)], answer }
}

// ─── live feed (#1921) ───────────────────────────────────────────────────────

export interface LiveAiCall {
  at: string
  request_id: string | null
  feature: string
  model: string
  provider: string
  user: string | null
  status: 'ok' | 'error'
  latency_ms: number
  cost_usd: number | null
  input_tokens: number | null
  output_tokens: number | null
  error?: string | null
}

const nameCache = new Map<string, { at: number; name: string }>()

async function nameOf(userId: string): Promise<string> {
  const hit = nameCache.get(userId)
  if (hit && Date.now() - hit.at < 600_000) return hit.name
  const r = (await db('nivaro_users')
    .where({ id: userId })
    .select('first_name', 'last_name', 'email')
    .first()
    .catch(() => null)) as { first_name?: string; last_name?: string; email?: string } | null
  const name = r ? [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || '' : ''
  nameCache.set(userId, { at: Date.now(), name })
  return name
}

/** Push one finished call to admins watching the `ai-calls` room — a no-op
 *  (no lookups, no emit) when nobody is watching, like the Traffic Map feed. */
export function emitAiCallLive(call: LiveAiCall): void {
  const io = getIo()
  if (!io) return
  const cloud = !!process.env.CLOUD_META_DB_URL
  // Cloud: the room is per tenant; outside a tenant request there is nowhere safe to send.
  const room = watchRoomId('ai-calls', cloud ? currentStoreId() || null : null, cloud)
  if (!room) return
  const watchers = io.sockets?.adapter?.rooms?.get(room)?.size ?? 0
  if (!watchers) return
  void (async () => {
    const user_name = call.user ? await nameOf(call.user) : null
    io.to(room).emit('ai:call', { ...call, user_name })
  })().catch(() => undefined)
}

// ─── logged request bodies ───────────────────────────────────────────────────

/**
 * The first user message of a logged call. The log caps request bodies, and
 * the system prompt comes first, so a long prompt can cut the JSON before
 * `messages` — fall back to reading the first user turn straight out of the
 * text. Null when the question is not recoverable.
 */
export function extractQuestion(requestJson: string | null): string | null {
  if (!requestJson) return null
  try {
    const p = JSON.parse(requestJson) as { messages?: Array<{ role?: string; content?: unknown }> }
    const m = p.messages?.find((x) => x.role === 'user')
    if (m) {
      const c = m.content
      const t =
        typeof c === 'string'
          ? c
          : Array.isArray(c)
            ? c.map((b) => String((b as { text?: unknown })?.text ?? '')).join(' ')
            : ''
      return t.trim() ? t.slice(0, 2000) : null
    }
  } catch {
    // cut mid-JSON — read it out of the text below
  }
  const idx = requestJson.indexOf('"messages":[')
  const tail = idx >= 0 ? requestJson.slice(idx) : requestJson
  const m = /"role":"user","content":"((?:[^"\\]|\\.)*)"/.exec(tail)
  if (!m) return null
  try {
    return (JSON.parse(`"${m[1]}"`) as string).slice(0, 2000)
  } catch {
    return m[1].slice(0, 2000)
  }
}

/** A replay run is visible only to the admin who started it, inside the tenant that started it. */
export function canSeeReplay(
  run: { user: string; store: string },
  userId: string,
  store: string
): boolean {
  return run.user === userId && run.store === store
}
