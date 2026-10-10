/**
 * Session replay masking rules (#1361) — the server half.
 *
 * nivaro_settings.replay_masking holds JSON text
 *   { mask_rich_text: boolean, mask_file_names: boolean, allow_fields: string[] }
 * and GET /session-recordings/enabled hands it to both recorders, which build
 * rrweb's mask options from it (packages/shared/src/lib/replay-masking.ts).
 * A missing or unreadable value means everything masked: the rules only ever
 * UNMASK something an admin named.
 */

export interface ReplayMaskingRules {
  mask_rich_text: boolean
  mask_file_names: boolean
  allow_fields: string[]
}

export const DEFAULT_REPLAY_MASKING: ReplayMaskingRules = {
  mask_rich_text: true,
  mask_file_names: true,
  allow_fields: []
}

export const ALLOW_FIELDS_MAX = 200
/** `collection.field` or `*.field` — identifiers only (they end up in a CSS selector). */
const FIELD_KEY = /^(\*|[A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{1,64})$/

function parse(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** Lenient read of the stored value: bad entries drop, missing switches mask. */
export function parseReplayMasking(raw: unknown): ReplayMaskingRules {
  const v = parse(raw)
  const o = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Record<string, unknown>
  const allow = Array.isArray(o.allow_fields) ? o.allow_fields : []
  const keys = new Set<string>()
  for (const a of allow) {
    if (typeof a !== 'string') continue
    const k = a.trim()
    if (FIELD_KEY.test(k)) keys.add(k)
    if (keys.size >= ALLOW_FIELDS_MAX) break
  }
  return {
    mask_rich_text: o.mask_rich_text !== false,
    mask_file_names: o.mask_file_names !== false,
    allow_fields: [...keys]
  }
}

/**
 * Strict check for a settings PATCH: the stored text, or an error naming the
 * entry that is wrong — a typo in the allow-list should be said, not dropped.
 */
export function validateReplayMasking(raw: unknown): { value: string | null } | { error: string } {
  if (raw == null || raw === '') return { value: null }
  const v = parse(raw)
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    return { error: 'replay_masking must be an object' }
  }
  const o = v as Record<string, unknown>
  for (const k of ['mask_rich_text', 'mask_file_names'] as const) {
    if (k in o && typeof o[k] !== 'boolean')
      return { error: `replay_masking.${k} must be true or false` }
  }
  if ('allow_fields' in o && !Array.isArray(o.allow_fields)) {
    return { error: 'replay_masking.allow_fields must be a list of collection.field' }
  }
  const allow = (o.allow_fields as unknown[] | undefined) ?? []
  if (allow.length > ALLOW_FIELDS_MAX) {
    return { error: `replay_masking.allow_fields takes at most ${ALLOW_FIELDS_MAX} fields` }
  }
  for (const a of allow) {
    if (typeof a !== 'string' || !FIELD_KEY.test(a.trim())) {
      return { error: `replay_masking.allow_fields: "${String(a)}" is not collection.field` }
    }
  }
  return { value: JSON.stringify(parseReplayMasking(o)) }
}
