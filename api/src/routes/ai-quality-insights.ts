import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  catalogueTableOk,
  lastCatalogueCheck,
  readCatalogue,
  registerCatalogueReadiness,
  runCatalogueCheck
} from '../services/ai-catalogue.js'
import { settingsRow } from '../services/ai-client.js'
import { setPriceOverrides } from '../services/ai-log.js'
import {
  PART_LABELS,
  PROMPT_PARTS,
  type PromptPart,
  parseStored
} from '../services/ai-prompt-parts.js'
import {
  mergeQualityIntoModels,
  normalizeBills,
  normalizeCatalogue,
  normalizePrices,
  parseQualityConfig,
  type QualityConfig
} from '../services/ai-quality.js'
import {
  buildForecast,
  buildReconciliation,
  notifyForecastAlerts,
  parseBillsCsv,
  spendTableOk
} from '../services/ai-spend.js'
import { loadToolReliability } from '../services/ai-tool-reliability.js'

/**
 * AI quality analytics (#2473 forecast, #2731 prompt cost, #2732 model
 * catalogue, #2733 tool reliability, #2764 reconciliation). All admin-only;
 * everything reads the call log and the tables from migration 470, and
 * degrades to an empty answer while those are missing.
 */

async function readCfg(): Promise<{ raw: string | null; id: unknown; cfg: QualityConfig }> {
  const row = (await settingsRow()) as Record<string, unknown> | null
  const raw = (row?.ai_models as string | null | undefined) ?? null
  return { raw, id: row?.id, cfg: parseQualityConfig(raw) }
}

async function saveCfg(next: QualityConfig): Promise<boolean> {
  // settingsRow() overlays per-instance settings; the stored row is the first one
  const row = (await db('nivaro_settings').orderBy('id', 'asc').first()) as
    | Record<string, unknown>
    | undefined
  if (!row) return false
  await db('nivaro_settings')
    .where({ id: row.id })
    .update({ ai_models: mergeQualityIntoModels((row.ai_models as string | null) ?? null, next) })
  setPriceOverrides(next.prices)
  return true
}

const clampDays = (v: unknown, def: number, max: number) =>
  Math.min(max, Math.max(1, Math.round(Number(v)) || def))

let partsColumn: boolean | null = null

export async function aiQualityInsightRoutes(app: FastifyInstance) {
  registerCatalogueReadiness()

  // ─── spend forecast + reconciliation (#2473, #2764) ───────────────────────
  app.get('/spend/forecast', { preHandler: requireAdmin }, async () => {
    const { cfg } = await readCfg()
    setPriceOverrides(cfg.prices)
    return {
      data: {
        ...(await buildForecast(cfg)),
        alert_pct: cfg.forecast_alert_pct,
        history_ready: await spendTableOk()
      }
    }
  })

  app.get<{ Querystring: { months?: string } }>(
    '/spend/reconcile',
    { preHandler: requireAdmin },
    async (req) => {
      const { cfg } = await readCfg()
      setPriceOverrides(cfg.prices)
      const months = await buildReconciliation(cfg, clampDays(req.query?.months, 3, 12))
      return { data: { months, prices: cfg.prices, history_ready: await spendTableOk() } }
    }
  )

  /** Prices per model, the over-last-month alert and the catalogue switches. */
  app.put('/spend/settings', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const { cfg } = await readCfg()
    const next: QualityConfig = { ...cfg }
    if (body.prices !== undefined) next.prices = normalizePrices(body.prices)
    if ('forecast_alert_pct' in body) {
      const v = body.forecast_alert_pct
      if (v == null || v === '') next.forecast_alert_pct = null
      else {
        const n = Number(v)
        if (!Number.isFinite(n) || n < 0 || n > 10_000)
          return reply.code(400).send({ error: 'The alert percentage must be between 0 and 10000' })
        next.forecast_alert_pct = n
      }
    }
    if (body.catalogue !== undefined)
      next.catalogue = normalizeCatalogue({ ...cfg.catalogue, ...(body.catalogue as object) })
    if (!(await saveCfg(next))) return reply.code(500).send({ error: 'No settings row' })
    await logActivity({
      action: 'ai-spend-settings',
      user: req.user!.id,
      comment: `${Object.keys(next.prices).length} price(s) · alert ${next.forecast_alert_pct ?? 'off'} · catalogue ${next.catalogue.enabled ? 'on' : 'off'}`,
      req
    })
    return reply.send({
      data: {
        prices: next.prices,
        forecast_alert_pct: next.forecast_alert_pct,
        catalogue: next.catalogue
      }
    })
  })

  /** Enter a month's bill: `bills` {month:{model:usd}} or `csv` lines `month,model,usd`. */
  app.put('/spend/bills', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as { bills?: unknown; csv?: unknown; replace_months?: unknown }
    let incoming = normalizeBills(body.bills)
    if (typeof body.csv === 'string' && body.csv.trim()) {
      if (body.csv.length > 100_000) return reply.code(400).send({ error: 'That CSV is too large' })
      incoming = { ...incoming, ...parseBillsCsv(body.csv) }
    }
    if (Object.keys(incoming).length === 0 && body.replace_months === undefined)
      return reply.code(400).send({
        error: 'Nothing to save: send bills, or CSV lines like 2026-09,claude-4-6-sonnet,412.50'
      })
    const { cfg } = await readCfg()
    const bills = { ...cfg.bills }
    // a month sent again replaces that month; an empty month removes it
    for (const [month, row] of Object.entries(incoming)) bills[month] = row
    if (Array.isArray(body.replace_months))
      for (const m of body.replace_months)
        if (typeof m === 'string' && !incoming[m]) delete bills[m]
    // keep two years of bills
    const keep = Object.keys(bills).sort().slice(-24)
    const trimmed: Record<string, Record<string, number>> = {}
    for (const m of keep) trimmed[m] = bills[m]
    if (!(await saveCfg({ ...cfg, bills: trimmed })))
      return reply.code(500).send({ error: 'No settings row' })
    await logActivity({
      action: 'ai-spend-bills',
      user: req.user!.id,
      comment: `bills for ${Object.keys(incoming).join(', ') || 'removed months'}`,
      req
    })
    return reply.send({ data: { bills: trimmed } })
  })

  /** Run the over-limit checks now and tell admins (the nightly job does the same). */
  app.post('/spend/alerts/run', { preHandler: requireAdmin }, async (req, reply) => {
    const { cfg } = await readCfg()
    const f = await buildForecast(cfg)
    const told = await notifyForecastAlerts(f.alerts)
    await logActivity({
      action: 'ai-spend-alerts-run',
      user: req.user!.id,
      comment: `${f.alerts.length} alert(s), ${told} admin(s) told`,
      req
    })
    return reply.send({ data: { alerts: f.alerts, told } })
  })

  // ─── prompt cost breakdown (#2731) ────────────────────────────────────────
  app.get<{ Querystring: { days?: string } }>(
    '/prompt-cost',
    { preHandler: requireAdmin },
    async (req) => {
      const days = clampDays(req.query?.days, 14, 30)
      if (partsColumn !== true)
        partsColumn = await db.schema
          .hasColumn('nivaro_ai_calls', 'prompt_parts')
          .catch(() => false)
      const empty = { days, ready: !!partsColumn, calls_measured: 0, features: [], releases: [] }
      if (!partsColumn) return { data: empty }
      const since = new Date(Date.now() - days * 86_400_000)
      const rows = (await db('nivaro_ai_calls')
        .where('created_at', '>=', since)
        .whereNotNull('prompt_parts')
        .orderBy('id', 'desc')
        .limit(20_000)
        .select('feature', 'prompt_parts')) as Array<{ feature: string; prompt_parts: string }>
      type Sum = Record<PromptPart, { tokens: number; cached: number }>
      const blank = (): Sum =>
        Object.fromEntries(PROMPT_PARTS.map((p) => [p, { tokens: 0, cached: 0 }])) as Sum
      const byFeature = new Map<string, { calls: number; sum: Sum }>()
      const byRelease = new Map<string, { calls: number; sum: Sum }>()
      for (const r of rows) {
        const { version, parts } = parseStored(r.prompt_parts)
        if (parts.length === 0) continue
        for (const [map, key] of [
          [byFeature, r.feature],
          [byRelease, version ?? 'unknown']
        ] as const) {
          const cur = map.get(key) ?? { calls: 0, sum: blank() }
          cur.calls++
          for (const p of parts) {
            cur.sum[p.part].tokens += p.tokens
            cur.sum[p.part].cached += p.cached
          }
          map.set(key, cur)
        }
      }
      const shape = (calls: number, sum: Sum) => {
        const total = PROMPT_PARTS.reduce((n, p) => n + sum[p].tokens, 0)
        const cached = PROMPT_PARTS.reduce((n, p) => n + sum[p].cached, 0)
        const parts = PROMPT_PARTS.filter((p) => sum[p].tokens > 0)
          .map((p) => ({
            part: p,
            label: PART_LABELS[p],
            avg_tokens: Math.round(sum[p].tokens / calls),
            avg_cached: Math.round(sum[p].cached / calls),
            share: total ? Math.round((sum[p].tokens / total) * 1000) / 10 : 0,
            cached_share: sum[p].tokens ? Math.round((sum[p].cached / sum[p].tokens) * 100) : 0
          }))
          .sort((a, b) => b.avg_tokens - a.avg_tokens)
        return {
          avg_total: Math.round(total / calls),
          cached_pct: total ? Math.round((cached / total) * 100) : 0,
          parts
        }
      }
      const features = [...byFeature.entries()]
        .map(([feature, v]) => {
          const s = shape(v.calls, v.sum)
          return { feature, calls: v.calls, ...s, biggest: s.parts.slice(0, 3).map((p) => p.label) }
        })
        .sort((a, b) => b.calls * b.avg_total - a.calls * a.avg_total)
      const releases = [...byRelease.entries()]
        .map(([version, v]) => ({ version, calls: v.calls, ...shape(v.calls, v.sum) }))
        .sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }))
      return {
        data: { days, ready: true, calls_measured: rows.length, features, releases }
      }
    }
  )

  // ─── tool reliability (#2733) ─────────────────────────────────────────────
  app.get<{ Querystring: { days?: string } }>(
    '/tool-reliability',
    { preHandler: requireAdmin },
    async (req) => ({ data: await loadToolReliability(clampDays(req.query?.days, 14, 90)) })
  )

  // ─── model catalogue (#2732) ──────────────────────────────────────────────
  app.get('/catalogue', { preHandler: requireAdmin }, async () => {
    const { cfg } = await readCfg()
    return {
      data: {
        ready: await catalogueTableOk(),
        settings: cfg.catalogue,
        last_check: lastCatalogueCheck(),
        models: await readCatalogue()
      }
    }
  })

  let checking = false
  /** Check now — answers 202 and runs behind the response (a new model also runs its trial). */
  app.post('/catalogue/check', { preHandler: requireAdmin }, async (req, reply) => {
    if (checking) return reply.code(409).send({ error: 'A check is already running' })
    checking = true
    await logActivity({ action: 'ai-catalogue-check-now', user: req.user!.id, req })
    void runCatalogueCheck()
      .catch(() => undefined)
      .finally(() => {
        checking = false
      })
    return reply.code(202).send({ data: { started: true } })
  })
}
