import { db } from '../db/index.js'
import { instanceKey } from './instance-key.js'
import {
  type JargonTerm,
  type LintStyle,
  MAX_LABEL_LENGTH_RANGE,
  STYLE_RULES
} from './layout-lint.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Label house style for the layout lint (#3184): which style rules are off,
 * the longest label, extra abbreviations and words that keep their capital.
 * Per instance, under the `layout_style` key of this instance's
 * `nivaro_settings_overrides` row (next to `huddle`, `chaos`, `recovery`) —
 * no migration. The editors live where forms are designed, so the setting
 * does too; another environment keeps its own.
 */

export const LAYOUT_STYLE_KEY = 'layout_style'

/** Most extra jargon terms / allowed words one instance keeps. */
export const MAX_STYLE_TERMS = 200

export class LayoutStyleError extends Error {
  statusCode = 400
}

export interface StoredLayoutStyle {
  off: string[]
  max_label_length: number | null
  jargon: JargonTerm[]
  allow_words: string[]
}

export const LAYOUT_STYLE_DEFAULTS: StoredLayoutStyle = {
  off: [],
  max_label_length: null,
  jargon: [],
  allow_words: []
}

function obj(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
}

const clean = (v: unknown, max = 60) =>
  String(v ?? '')
    .trim()
    .slice(0, max)

/** Stored JSON → settings (pure; anything unreadable falls back to its default). */
export function normalizeLayoutStyle(raw: unknown): StoredLayoutStyle {
  const src = obj(raw)
  const rules = STYLE_RULES as readonly string[]
  const n = Number(src.max_label_length)
  const seen = new Set<string>()
  const jargon: JargonTerm[] = []
  for (const t of Array.isArray(src.jargon) ? src.jargon : []) {
    const term = clean(obj(t).term)
    const say = clean(obj(t).say)
    if (!term || !say || seen.has(term.toLowerCase())) continue
    seen.add(term.toLowerCase())
    jargon.push({ term, say })
    if (jargon.length >= MAX_STYLE_TERMS) break
  }
  return {
    off: [...new Set((Array.isArray(src.off) ? src.off : []).map(String))].filter((r) =>
      rules.includes(r)
    ),
    max_label_length:
      Number.isInteger(n) && n >= MAX_LABEL_LENGTH_RANGE[0] && n <= MAX_LABEL_LENGTH_RANGE[1]
        ? n
        : null,
    jargon,
    allow_words: [
      ...new Set(
        (Array.isArray(src.allow_words) ? src.allow_words : []).map((w) => clean(w)).filter(Boolean)
      )
    ].slice(0, MAX_STYLE_TERMS)
  }
}

/** An admin's PATCH: every bad field is named, never dropped. Keys not sent keep their value. */
export function mergeLayoutStylePatch(
  stored: StoredLayoutStyle,
  patch: unknown
): StoredLayoutStyle {
  const p = obj(patch)
  const bad: string[] = []
  for (const k of Object.keys(p))
    if (!(k in LAYOUT_STYLE_DEFAULTS)) bad.push(`${k} is not a setting`)
  if (p.off !== undefined) {
    if (!Array.isArray(p.off)) bad.push('off must be a list of rules')
    else
      for (const r of p.off)
        if (!(STYLE_RULES as readonly string[]).includes(String(r)))
          bad.push(`${String(r)} is not a label style rule`)
  }
  if (p.max_label_length !== undefined && p.max_label_length !== null) {
    const n = Number(p.max_label_length)
    if (!Number.isInteger(n) || n < MAX_LABEL_LENGTH_RANGE[0] || n > MAX_LABEL_LENGTH_RANGE[1])
      bad.push(
        `max_label_length must be a whole number from ${MAX_LABEL_LENGTH_RANGE[0]} to ${MAX_LABEL_LENGTH_RANGE[1]}`
      )
  }
  for (const k of ['jargon', 'allow_words'] as const) {
    if (p[k] === undefined) continue
    if (!Array.isArray(p[k])) bad.push(`${k} must be a list`)
    else if ((p[k] as unknown[]).length > MAX_STYLE_TERMS)
      bad.push(`${k} holds ${(p[k] as unknown[]).length} entries; at most ${MAX_STYLE_TERMS}`)
  }
  if (Array.isArray(p.jargon))
    for (const t of p.jargon)
      if (!clean(obj(t).term) || !clean(obj(t).say))
        bad.push('each jargon entry needs a term and what to say instead')
  if (bad.length) throw new LayoutStyleError([...new Set(bad)].join('; '))
  return normalizeLayoutStyle({ ...stored, ...p })
}

/** The lint's view of the stored settings. */
export function lintStyleOf(s: StoredLayoutStyle): LintStyle {
  return {
    off: s.off,
    ...(s.max_label_length != null ? { max_label_length: s.max_label_length } : {}),
    jargon: s.jargon,
    allow_words: s.allow_words
  }
}

async function readRow(): Promise<{ id: number; data: Record<string, unknown> } | null> {
  const row = (await db('nivaro_settings_overrides')
    .where({ instance_key: instanceKey() })
    .first('id', 'data')) as { id: number; data?: string | null } | undefined
  if (!row) return null
  try {
    return { id: row.id, data: obj(row.data ? JSON.parse(row.data) : {}) }
  } catch {
    return { id: row.id, data: {} }
  }
}

// Per tenant: a cloud process serves many tenants' databases.
const cache = new Map<string, { at: number; value: StoredLayoutStyle }>()
const TTL_MS = 30_000

export function bustLayoutStyleCache(): void {
  cache.clear()
}

/** This instance's label style (defaults when the table is missing or unreadable). */
export async function getLayoutStyle(): Promise<StoredLayoutStyle> {
  const tenant = currentTenantKey()
  const hit = cache.get(tenant)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value
  let value = LAYOUT_STYLE_DEFAULTS
  try {
    value = normalizeLayoutStyle((await readRow())?.data[LAYOUT_STYLE_KEY])
  } catch {
    value = LAYOUT_STYLE_DEFAULTS
  }
  cache.set(tenant, { at: Date.now(), value })
  if (cache.size > 500) cache.delete(cache.keys().next().value as string)
  return value
}

export async function saveLayoutStyle(patch: unknown): Promise<StoredLayoutStyle> {
  const row = await readRow()
  const next = mergeLayoutStylePatch(normalizeLayoutStyle(row?.data[LAYOUT_STYLE_KEY]), patch)
  const data = { ...(row?.data ?? {}), [LAYOUT_STYLE_KEY]: next }
  if (row) {
    await db('nivaro_settings_overrides')
      .where({ id: row.id })
      .update({ data: JSON.stringify(data), updated_at: new Date() })
  } else {
    await db('nivaro_settings_overrides').insert({
      instance_key: instanceKey(),
      data: JSON.stringify(data),
      updated_at: new Date()
    })
  }
  bustLayoutStyleCache()
  return next
}
