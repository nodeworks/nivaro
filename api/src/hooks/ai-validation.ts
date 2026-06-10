import Anthropic from '@anthropic-ai/sdk'
import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { emitNotification } from '../plugins/socketio.js'
import { embedText, getEmbeddableFields, searchEmbeddings } from '../services/embeddings.js'
import { hooks } from './registry.js'

// ---------------------------------------------------------------------------
// AI Content Validation + Duplicate Detection hooks
//
// Per-collection configuration lives in nivaro_ai_collection_settings.
// - Validation runs as a before-hook on create/update. 'hard' mode throws an
//   error with statusCode 422 (rethrown by the hook registry → 422 response);
//   'soft' mode inserts an in-app notification for the acting user and never
//   blocks the save.
// - Duplicate detection runs as a fire-and-forget after-create hook using the
//   embeddings service; matches produce a notification for the creator.
// - When no Anthropic key is configured validation is a no-op (logged once).
// ---------------------------------------------------------------------------

const VALIDATION_MODEL = 'claude-haiku-4-5'

let _app: FastifyInstance | null = null

export function setApp(app: FastifyInstance) {
  _app = app
}

export async function getAnthropicClient(): Promise<Anthropic | null> {
  const key =
    config.ANTHROPIC_API_KEY ||
    (await db('nivaro_settings')
      .orderBy('id', 'asc')
      .first()
      .then((s: { anthropic_api_key?: string | null }) => s?.anthropic_api_key ?? null)
      .catch(() => null))
  if (!key) return null
  return new Anthropic({ apiKey: key })
}

// ─── Per-collection AI settings (60s cache) ──────────────────────────────────

export interface AiCollectionSettings {
  collection: string
  validation_enabled: boolean
  validation_mode: 'soft' | 'hard'
  validation_rules: string[]
  duplicate_detection_enabled: boolean
  duplicate_threshold: number
}

const CACHE_TTL_MS = 60_000
const settingsCache = new Map<string, { value: AiCollectionSettings; expires: number }>()

export const AI_SETTINGS_DEFAULTS: Omit<AiCollectionSettings, 'collection'> = {
  validation_enabled: false,
  validation_mode: 'soft',
  validation_rules: [],
  duplicate_detection_enabled: false,
  duplicate_threshold: 0.85
}

function parseRules(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
      : []
  } catch {
    return []
  }
}

/** Invalidate the cached settings for one collection (or all when omitted). */
export function invalidateAiSettingsCache(collection?: string) {
  if (collection) settingsCache.delete(collection)
  else settingsCache.clear()
}

export async function getAiCollectionSettings(collection: string): Promise<AiCollectionSettings> {
  const cached = settingsCache.get(collection)
  if (cached && cached.expires > Date.now()) return cached.value

  const row = await db('nivaro_ai_collection_settings')
    .where({ collection })
    .first()
    .catch(() => null)

  const value: AiCollectionSettings = row
    ? {
        collection,
        validation_enabled: row.validation_enabled === true || row.validation_enabled === 1,
        validation_mode: row.validation_mode === 'hard' ? 'hard' : 'soft',
        validation_rules: parseRules(row.validation_rules),
        duplicate_detection_enabled:
          row.duplicate_detection_enabled === true || row.duplicate_detection_enabled === 1,
        duplicate_threshold: Number(row.duplicate_threshold) || 0.85
      }
    : { collection, ...AI_SETTINGS_DEFAULTS }

  settingsCache.set(collection, { value, expires: Date.now() + CACHE_TTL_MS })
  return value
}

// ─── Validation evaluation ────────────────────────────────────────────────────

export interface AiViolation {
  rule: string
  explanation: string
}

export class AiValidationError extends Error {
  statusCode = 422
  code = 'AI_VALIDATION_FAILED'
  violations: AiViolation[]

  constructor(violations: AiViolation[]) {
    super(
      `AI validation failed: ${violations
        .map((v) => `${v.rule} — ${v.explanation}`)
        .join('; ')
        .slice(0, 1000)}`
    )
    this.violations = violations
  }
}

// Extract a JSON object from a model response — strips code fences and prose.
function extractJson(text: string): unknown {
  let t = text.trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence?.[1]) t = fence[1].trim()
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start >= 0 && end > start) t = t.slice(start, end + 1)
  return JSON.parse(t)
}

let loggedNoKey = false

/**
 * Evaluate a record against the collection's validation rules via Claude.
 * Returns the list of violations (empty when valid, key missing, or rules unset).
 */
export async function runAiValidation(
  collection: string,
  data: Record<string, unknown>,
  rules: string[]
): Promise<AiViolation[]> {
  if (rules.length === 0) return []

  const client = await getAnthropicClient()
  if (!client) {
    if (!loggedNoKey) {
      loggedNoKey = true
      console.warn(
        '[ai-validation] No Anthropic API key configured — AI content validation is disabled'
      )
    }
    return []
  }

  const system = [
    `You validate records of the "${collection}" collection against content rules.`,
    'Evaluate the record against each rule. A rule is violated only when the record clearly fails it.',
    'Return ONLY a JSON object, no prose and no code fences, with this exact shape:',
    '{"violations":[{"rule":"<the rule text>","explanation":"<one-sentence explanation of the violation>"}]}',
    'Return {"violations":[]} when every rule passes.'
  ].join('\n')

  const userContent = [
    'Rules:',
    ...rules.map((r, i) => `${i + 1}. ${r}`),
    '',
    `Record: ${JSON.stringify(data).slice(0, 8000)}`
  ].join('\n')

  const message = await client.messages.create({
    model: VALIDATION_MODEL,
    max_tokens: 600,
    system,
    messages: [{ role: 'user', content: userContent }]
  })
  const raw = message.content[0]?.type === 'text' ? message.content[0].text : ''

  let parsed: { violations?: unknown }
  try {
    parsed = extractJson(raw) as { violations?: unknown }
  } catch {
    console.warn('[ai-validation] Unparseable validation response — treating as valid')
    return []
  }

  const rawViolations = Array.isArray(parsed.violations) ? parsed.violations : []
  const violations: AiViolation[] = []
  for (const v of rawViolations) {
    if (v && typeof v === 'object') {
      const { rule, explanation } = v as { rule?: unknown; explanation?: unknown }
      violations.push({
        rule: typeof rule === 'string' ? rule.slice(0, 300) : 'Unknown rule',
        explanation: typeof explanation === 'string' ? explanation.slice(0, 500) : ''
      })
    }
  }
  return violations
}

async function notifyUser(
  recipient: string,
  subject: string,
  message: string,
  collection: string,
  item: string | null
) {
  const now = new Date()
  try {
    const rows = (await db('nivaro_notifications')
      .insert({
        recipient,
        subject,
        status: 'inbox',
        timestamp: now,
        sender: null,
        message: message.slice(0, 500),
        collection,
        item
      })
      .returning('*')) as unknown as Array<{ id: number } | undefined>

    if (_app?.io) {
      emitNotification(_app.io, recipient, {
        id: rows[0]?.id ?? null,
        subject,
        message: message.slice(0, 200),
        collection,
        item,
        sender: null,
        timestamp: now
      })
    }
  } catch (err) {
    console.error({ err, recipient, collection }, 'AI feature notification failed')
  }
}

// ─── Duplicate detection ──────────────────────────────────────────────────────

export interface DuplicateMatch {
  id: string
  score: number
  label: string
  fields: Record<string, unknown>
}

const LABELISH_FIELDS = ['title', 'name', 'label', 'subject', 'description', 'email', 'status']

function buildRecordText(data: Record<string, unknown>, preferredFields: string[]): string {
  const parts: string[] = []
  const source = preferredFields.length > 0 ? preferredFields : Object.keys(data)
  for (const key of source) {
    const v = data[key]
    if (typeof v === 'string' && v.trim()) parts.push(v.trim())
  }
  // Fall back to every string value when the preferred fields were all empty
  if (parts.length === 0 && preferredFields.length > 0) {
    for (const v of Object.values(data)) {
      if (typeof v === 'string' && v.trim()) parts.push(v.trim())
    }
  }
  return parts.join('\n').slice(0, 8000)
}

/**
 * Find likely duplicates of a record via the embeddings index.
 * Returns up to 5 matches at or above the given similarity threshold.
 */
export async function findDuplicates(
  collection: string,
  data: Record<string, unknown>,
  threshold: number,
  excludeId?: string | null
): Promise<DuplicateMatch[]> {
  const embeddable = await getEmbeddableFields(collection).catch(() => [] as string[])
  const text = buildRecordText(data, embeddable)
  if (!text) return []

  const queryVec = await embedText(text)
  const scored = await searchEmbeddings(collection, queryVec, 50)

  // Multiple embedded fields per item — keep the best score per item.
  const bestByItem = new Map<string, number>()
  for (const s of scored) {
    if (s.score < threshold) continue
    if (excludeId != null && s.item === String(excludeId)) continue
    const prev = bestByItem.get(s.item)
    if (prev == null || s.score > prev) bestByItem.set(s.item, s.score)
  }

  const top = [...bestByItem.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  if (top.length === 0) return []

  const rows = (await db(collection)
    .whereIn(
      'id',
      top.map(([item]) => item)
    )
    .select('*')
    .catch(() => [])) as Array<Record<string, unknown>>
  const rowById = new Map(rows.map((r) => [String(r.id), r]))

  return top
    .map(([item, score]) => {
      const row = rowById.get(item)
      if (!row) return null
      const labelField = LABELISH_FIELDS.find((f) => typeof row[f] === 'string' && row[f])
      const label = labelField ? String(row[labelField]) : `#${item}`
      const fieldKeys = LABELISH_FIELDS.filter((f) => row[f] != null).slice(0, 3)
      const fields: Record<string, unknown> = {}
      for (const k of fieldKeys) fields[k] = row[k]
      return { id: item, score: Math.round(score * 1000) / 1000, label, fields }
    })
    .filter((d): d is DuplicateMatch => d !== null)
}

// ─── Hook registration ────────────────────────────────────────────────────────

export function registerAiValidationHooks() {
  // Content validation — before create/update
  const validate = async (ctx: {
    collection: string
    payload?: Record<string, unknown>
    user?: { id: string }
    keys?: Array<string | number>
  }) => {
    if (ctx.collection.startsWith('nivaro_')) return
    if (!ctx.payload || Object.keys(ctx.payload).length === 0) return

    const settings = await getAiCollectionSettings(ctx.collection).catch(() => null)
    if (!settings?.validation_enabled || settings.validation_rules.length === 0) return

    let violations: AiViolation[]
    try {
      violations = await runAiValidation(ctx.collection, ctx.payload, settings.validation_rules)
    } catch (err) {
      // AI/provider failure must never block saves
      console.warn({ err, collection: ctx.collection }, '[ai-validation] evaluation failed')
      return
    }
    if (violations.length === 0) return

    if (settings.validation_mode === 'hard') {
      throw new AiValidationError(violations)
    }

    // Soft mode — warn the acting user without blocking
    if (ctx.user?.id) {
      const item = ctx.keys?.[0] != null ? String(ctx.keys[0]) : null
      const message = violations.map((v) => `${v.rule}: ${v.explanation}`).join(' | ')
      notifyUser(
        ctx.user.id,
        `Content warnings: ${ctx.collection}`,
        message,
        ctx.collection,
        item
      ).catch(() => {})
    }
  }

  hooks.before('*', 'create', validate)
  hooks.before('*', 'update', validate)

  // Duplicate detection — after create, fire-and-forget
  hooks.after('*', 'create', async (ctx) => {
    if (ctx.collection.startsWith('nivaro_')) return
    const record = (ctx.result ?? ctx.payload) as Record<string, unknown> | null
    if (!record) return
    const itemId = ctx.keys?.[0] != null ? String(ctx.keys[0]) : null
    const creator = ctx.user?.id ?? null
    if (!creator) return

    void (async () => {
      try {
        const settings = await getAiCollectionSettings(ctx.collection)
        if (!settings.duplicate_detection_enabled) return

        const duplicates = await findDuplicates(
          ctx.collection,
          record,
          settings.duplicate_threshold,
          itemId
        )
        if (duplicates.length === 0) return

        const first = duplicates[0]
        const message = duplicates
          .map((d) => `${d.label} (#${d.id}, ${(d.score * 100).toFixed(0)}% similar)`)
          .join(', ')
        await notifyUser(
          creator,
          `Possible duplicate of ${first.label}`,
          `New ${ctx.collection} record looks similar to: ${message}`,
          ctx.collection,
          itemId
        )
      } catch (err) {
        console.warn({ err, collection: ctx.collection }, '[ai-validation] duplicate check failed')
      }
    })()
  })
}
