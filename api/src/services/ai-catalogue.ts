import { randomUUID } from 'node:crypto'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { logActivity } from './activity.js'
import {
  gatewayBearer,
  gatewayFromSettings,
  getAiClient,
  getAiModelSettings,
  parseAiModels,
  settingsRow
} from './ai-client.js'
import { costOf } from './ai-log.js'
import { parseQualityConfig, type QualityConfig } from './ai-quality.js'
import { executeReplay, loadReplayCandidates, type ReplayRun, replayRuns } from './ai-replay.js'
import { notifyAdminsOnce } from './ai-spend.js'
import { registerReadinessCheck } from './readiness.js'
import { runInTrace } from './request-trace.js'

/**
 * Model catalogue watch (#2732). Once a night: which models does the
 * provider or gateway answer for? A list endpoint where there is one,
 * otherwise a one-token probe per id we know of (the configured ones plus
 * any seen before). New and retired ids are written to
 * `nivaro_ai_model_catalogue` and shown on AI quality. A new id runs the
 * existing Compare (#1866) and replay of saved questions (#1916) once so the
 * side-by-side is waiting for an admin; nothing here ever switches a model.
 * A retired id still named in the settings raises a readiness warning.
 */

const NOT_CHAT = /embed|whisper|tts|audio|speech|image|moderation|rerank|transcri|dall|vision-only/i
export const looksLikeChatModel = (id: string) => !NOT_CHAT.test(id)

export interface CatalogueRow {
  model_id: string
  source: 'list' | 'probe'
  status: 'available' | 'retired'
  first_seen: string
  last_seen: string
  retired_at: string | null
  trial_at: string | null
  trial: TrialSummary | null
}

export interface TrialSummary {
  at: string
  baseline_model: string
  skipped?: string
  compare?: Array<{
    model: string
    text?: string
    error?: string
    cost_usd: number | null
    latency_ms: number
  }>
  replay?: {
    run_id: string
    model: string
    done: number
    total: number
    items: Array<{
      question: string
      original: string
      replay: string
      original_cost: number | null
      replay_cost: number | null
      error?: string
    }>
  }
}

let tableProbe: { ok: boolean; at: number } | null = null
export async function catalogueTableOk(): Promise<boolean> {
  if (tableProbe && (tableProbe.ok || Date.now() - tableProbe.at < 60_000)) return tableProbe.ok
  const ok = await db.schema.hasTable('nivaro_ai_model_catalogue').catch(() => false)
  tableProbe = { ok, at: Date.now() }
  return ok
}

/** Every model id the settings name — the ones a retirement would break. */
export function configuredModelIds(
  s: Record<string, unknown> | null,
  cfg: QualityConfig
): string[] {
  const out = new Set<string>()
  const row = (s ?? {}) as Parameters<typeof parseAiModels>[0]
  for (const v of Object.values(parseAiModels(row))) if (v) out.add(v)
  for (const k of ['ai_model', 'ai_gateway_model'] as const) {
    const v = (s as Record<string, unknown> | null)?.[k]
    if (typeof v === 'string' && v.trim()) out.add(v.trim())
  }
  if (cfg.fallback_model) out.add(cfg.fallback_model)
  for (const c of cfg.budgets.caps) if (c.cheaper_model) out.add(c.cheaper_model)
  return [...out]
}

// ─── asking the provider ─────────────────────────────────────────────────────

const MODEL_REFUSED = /model|not found|unsupported|unknown|does not exist|not available|forbidden/i

export function idsFromListBody(body: unknown): string[] {
  const arr = Array.isArray(body)
    ? body
    : body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data)
      ? (body as { data: unknown[] }).data
      : []
  const ids = arr
    .map((m) => (typeof m === 'string' ? m : (m as { id?: unknown })?.id))
    .filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 120)
  return [...new Set(ids)]
}

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`${res.status}`)
  return res.json()
}

/** The ids the list endpoint names, or null when there is none to ask. */
export async function listProviderModels(
  s: Record<string, unknown> | null
): Promise<string[] | null> {
  try {
    if (s?.ai_provider === 'gateway') {
      const api = gatewayFromSettings(s as never)
      if (!api.base_url || !api.token_url) return null
      const bearer = await gatewayBearer(api)
      const body = await fetchJson(`${api.base_url}/models`, { Authorization: `Bearer ${bearer}` })
      const ids = idsFromListBody(body)
      return ids.length ? ids : null
    }
    const key = config.ANTHROPIC_API_KEY || (s?.anthropic_api_key as string | undefined)
    if (!key) return null
    const body = await fetchJson('https://api.anthropic.com/v1/models?limit=1000', {
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    })
    const ids = idsFromListBody(body)
    return ids.length ? ids : null
  } catch {
    return null
  }
}

/** One-token probe: true = answered, false = the provider refused the id, null = could not tell. */
export async function probeModel(model: string): Promise<boolean | null> {
  try {
    const client = await getAiClient({ model, fallback: false, guard: false })
    if (!client) return null
    await client.messages.create({
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ok' }]
    })
    return true
  } catch (err) {
    const msg = String((err as Error)?.message ?? '')
    const status =
      /AI gateway (\d{3})/.exec(msg)?.[1] ?? String((err as { status?: number })?.status ?? '')
    if (['400', '403', '404', '422'].includes(status) && MODEL_REFUSED.test(msg)) return false
    return null
  }
}

// ─── the check ───────────────────────────────────────────────────────────────

export interface CheckResult {
  at: string
  source: 'list' | 'probe' | 'none'
  checked: number
  new_models: string[]
  retired_models: string[]
  trial: string | null
  note?: string
}
let lastCheck: CheckResult | null = null
export const lastCatalogueCheck = () => lastCheck
const finish = (r: CheckResult): CheckResult => {
  lastCheck = r
  return r
}

const iso = (d: Date) => d.toISOString()

/** Apply a list/probe outcome to the stored rows; returns what changed. */
export async function recordCatalogue(
  seen: Map<string, boolean>,
  source: 'list' | 'probe',
  now: Date,
  opts: { fullList: boolean }
): Promise<{ newIds: string[]; retiredIds: string[]; baseline: boolean }> {
  const rows = (await db('nivaro_ai_model_catalogue').select('model_id', 'status')) as Array<{
    model_id: string
    status: string
  }>
  const known = new Map(rows.map((r) => [r.model_id, r.status]))
  const baseline = rows.length === 0
  const newIds: string[] = []
  const retiredIds: string[] = []
  for (const [id, available] of seen) {
    const status = known.get(id)
    if (available) {
      if (status === undefined) {
        await db('nivaro_ai_model_catalogue').insert({
          model_id: id,
          source,
          status: 'available',
          first_seen: now,
          last_seen: now
        })
        if (!baseline) newIds.push(id)
      } else {
        await db('nivaro_ai_model_catalogue')
          .where({ model_id: id })
          .update({ status: 'available', last_seen: now, retired_at: null, source })
      }
    } else if (status === 'available') {
      await db('nivaro_ai_model_catalogue')
        .where({ model_id: id })
        .update({ status: 'retired', retired_at: now })
      retiredIds.push(id)
    } else if (status === undefined) {
      // a configured id that never answered: record it as retired so readiness can say so
      await db('nivaro_ai_model_catalogue').insert({
        model_id: id,
        source,
        status: 'retired',
        first_seen: now,
        last_seen: now,
        retired_at: now
      })
      retiredIds.push(id)
    }
  }
  // a full list also retires ids that vanished from it
  if (opts.fullList) {
    for (const [id, status] of known) {
      if (status === 'available' && !seen.has(id)) {
        await db('nivaro_ai_model_catalogue')
          .where({ model_id: id })
          .update({ status: 'retired', retired_at: now })
        retiredIds.push(id)
      }
    }
  }
  return { newIds, retiredIds, baseline }
}

export async function runCatalogueCheck(now = new Date()): Promise<CheckResult> {
  const base: CheckResult = {
    at: iso(now),
    source: 'none',
    checked: 0,
    new_models: [],
    retired_models: [],
    trial: null
  }
  if (!(await catalogueTableOk()))
    return finish({ ...base, note: 'Catalogue table not created yet.' })
  const s = (await settingsRow()) as Record<string, unknown> | null
  const cfg = parseQualityConfig(s?.ai_models)
  if (!cfg.catalogue.enabled) return finish({ ...base, note: 'Switched off.' })
  const seen = new Map<string, boolean>()
  let source: 'list' | 'probe' = 'list'
  const listed = await listProviderModels(s)
  if (listed) {
    for (const id of listed) seen.set(id, true)
    // an id the settings name that the list omits is retired, even if the list is partial
    for (const id of configuredModelIds(s, cfg)) if (!seen.has(id)) seen.set(id, false)
  } else {
    source = 'probe'
    const stored = (await db('nivaro_ai_model_catalogue')
      .where('status', 'available')
      .select('model_id')) as Array<{ model_id: string }>
    const ids = new Set([...configuredModelIds(s, cfg), ...stored.map((r) => r.model_id)])
    for (const id of ids) {
      const r = await probeModel(id)
      if (r != null) seen.set(id, r)
    }
  }
  if (seen.size === 0) return finish({ ...base, note: 'The provider could not be reached.' })
  const { newIds, retiredIds, baseline } = await recordCatalogue(seen, source, now, {
    fullList: source === 'list'
  })
  const result: CheckResult = {
    ...base,
    source,
    checked: seen.size,
    new_models: newIds,
    retired_models: retiredIds,
    note: baseline ? 'First check: every model found is the starting list.' : undefined
  }
  const configured = new Set(configuredModelIds(s, cfg))
  const breaking = retiredIds.filter((id) => configured.has(id))
  if (breaking.length)
    await notifyAdminsOnce(`catalogue:retired:${breaking.sort().join(',')}`, {
      subject: 'A configured AI model is no longer offered',
      message: `${breaking.join(', ')} ${breaking.length === 1 ? 'is' : 'are'} named in the AI settings but the provider no longer answers for ${breaking.length === 1 ? 'it' : 'them'}. Calls will fall over to another model until you pick a new one.`,
      url: '/ai-quality?tab=models',
      label: 'AI model catalogue',
      why: 'You are an administrator and a model your AI settings use has been retired.'
    }).catch(() => 0)
  await logActivity({
    action: 'ai-catalogue-check',
    user: null,
    comment: `${source} · ${seen.size} model(s) · new: ${newIds.join(', ') || 'none'} · retired: ${retiredIds.join(', ') || 'none'}`
  })
  const candidate = newIds.filter(looksLikeChatModel).sort().reverse()[0]
  if (candidate && cfg.catalogue.auto_trial) {
    result.trial = candidate
    await runTrialAndStore(candidate, cfg, now).catch(() => undefined)
  }
  return finish(result)
}

// ─── the side-by-side for a new model ────────────────────────────────────────

const COMPARE_PROMPT =
  'In three sentences, explain what a headless CMS is and name one risk of letting staff edit live data without a review step.'
const TRIAL_QUESTIONS = 5
const clip = (s: string, n = 700) => (s.length > n ? `${s.slice(0, n)}…` : s)

async function firstAdminId(): Promise<string | null> {
  const row = (await db('nivaro_users as u')
    .join('nivaro_roles as r', 'r.id', 'u.role')
    .where('r.admin_access', true)
    .where('u.status', 'active')
    .whereNull('u.account_kind')
    .orderBy('u.date_created', 'asc')
    .first('u.id')
    .catch(() => null)) as { id: string } | null
  return row ? String(row.id) : null
}

/** Compare + replay on the new id, billed to the first admin; saved on the catalogue row. */
export async function runTrial(
  model: string,
  cfg: QualityConfig,
  now = new Date()
): Promise<TrialSummary> {
  const baseline = (await getAiModelSettings()).chatModel
  const out: TrialSummary = { at: iso(now), baseline_model: baseline }
  const admin = await firstAdminId()
  if (!admin) return { ...out, skipped: 'No active administrator to bill the trial to.' }
  out.compare = await runInTrace('/api/ai/catalogue-trial', admin, async () =>
    Promise.all(
      [model, baseline].map(async (m) => {
        const t0 = Date.now()
        try {
          const client = await getAiClient({ model: m, fallback: false })
          if (!client) throw new Error('AI is not configured')
          const res = await client.messages.create({
            model: m,
            max_tokens: 300,
            messages: [{ role: 'user', content: COMPARE_PROMPT }]
          })
          const input = res.usage?.input_tokens ?? null
          const output = res.usage?.output_tokens ?? null
          return {
            model: m,
            text: clip(
              res.content
                .map((b) => (b.type === 'text' ? b.text : ''))
                .join('')
                .trim()
            ),
            cost_usd: costOf(res.model || m, { input, output }),
            latency_ms: Date.now() - t0
          }
        } catch (err) {
          return {
            model: m,
            error: String((err as Error)?.message ?? err).slice(0, 300),
            cost_usd: null,
            latency_ms: Date.now() - t0
          }
        }
      })
    )
  )
  const cands = await loadReplayCandidates(TRIAL_QUESTIONS)
  if (cands.length === 0) return { ...out, skipped: 'No saved Ask AI questions to replay.' }
  const inTok = cands.reduce((n, c) => n + c.input_tokens, 0)
  const outTok = cands.reduce((n, c) => n + c.output_tokens, 0)
  const estimate = costOf(model, { input: inTok, output: outTok })
  if (estimate != null && estimate > cfg.catalogue.auto_trial_max_usd)
    return {
      ...out,
      skipped: `The replay would cost about $${estimate.toFixed(2)}, over the $${cfg.catalogue.auto_trial_max_usd.toFixed(2)} limit for automatic runs. Run it from the Replay tab.`
    }
  const run: ReplayRun = {
    id: randomUUID(),
    user: admin,
    store: '',
    model,
    status: 'running',
    started_at: iso(new Date()),
    total: cands.length,
    done: 0,
    items: []
  }
  replayRuns.set(run.id, run)
  await executeReplay(run, cands, model, admin)
  out.replay = {
    run_id: run.id,
    model,
    done: run.done,
    total: run.total,
    items: run.items.map((i) => ({
      question: clip(i.question, 300),
      original: clip(i.original.answer),
      replay: clip(i.replay?.answer ?? ''),
      original_cost: i.original.cost_usd,
      replay_cost: i.replay?.cost_usd ?? null,
      ...(i.replay?.error ? { error: i.replay.error } : {})
    }))
  }
  return out
}

async function runTrialAndStore(model: string, cfg: QualityConfig, now: Date): Promise<void> {
  const trial = await runTrial(model, cfg, now)
  await db('nivaro_ai_model_catalogue')
    .where({ model_id: model })
    .update({ trial_at: now, trial: JSON.stringify(trial) })
}

// ─── reading ─────────────────────────────────────────────────────────────────

export async function readCatalogue(): Promise<CatalogueRow[]> {
  if (!(await catalogueTableOk())) return []
  const rows = (await db('nivaro_ai_model_catalogue')
    .orderBy('first_seen', 'desc')
    .orderBy('model_id', 'asc')
    .limit(500)
    .select()) as Array<Record<string, unknown>>
  const d = (v: unknown) => (v ? new Date(v as string).toISOString() : null)
  return rows.map((r) => {
    let trial: TrialSummary | null = null
    try {
      trial = r.trial ? (JSON.parse(String(r.trial)) as TrialSummary) : null
    } catch {
      trial = null
    }
    return {
      model_id: String(r.model_id),
      source: r.source === 'probe' ? 'probe' : 'list',
      status: r.status === 'retired' ? 'retired' : 'available',
      first_seen: d(r.first_seen) as string,
      last_seen: d(r.last_seen) as string,
      retired_at: d(r.retired_at),
      trial_at: d(r.trial_at),
      trial
    }
  })
}

// ─── readiness ───────────────────────────────────────────────────────────────

let registered = false
export function registerCatalogueReadiness(): void {
  if (registered) return
  registered = true
  registerReadinessCheck({
    id: 'ai-models-offered',
    label: 'AI models in the settings are still offered',
    group: 'Operations',
    description:
      'Reads the nightly model catalogue check: a model named in the AI settings (per-feature models, the fallback, a budget cap’s cheaper model) that the provider no longer answers for is flagged before calls start failing over to another model.',
    run: async () => {
      if (!(await catalogueTableOk()))
        return { status: 'skip', detail: 'No catalogue check has run yet.' }
      const s = (await settingsRow()) as Record<string, unknown> | null
      const cfg = parseQualityConfig(s?.ai_models)
      if (!cfg.catalogue.enabled)
        return { status: 'skip', detail: 'The catalogue check is switched off.' }
      const rows = await readCatalogue()
      if (rows.length === 0) return { status: 'skip', detail: 'No catalogue check has run yet.' }
      const retired = new Set(rows.filter((r) => r.status === 'retired').map((r) => r.model_id))
      const bad = configuredModelIds(s, cfg).filter((id) => retired.has(id))
      if (bad.length === 0)
        return { status: 'pass', detail: 'Every configured model was offered at the last check.' }
      return {
        status: 'warn',
        detail: `${bad.join(', ')} ${bad.length === 1 ? 'is' : 'are'} no longer offered by the provider.`,
        blockers: [
          'Pick a replacement in Settings → AI, or set a fallback model, before calls fail over.'
        ]
      }
    }
  })
}
