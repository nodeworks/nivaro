/**
 * Masking rules for session recordings (#1361).
 *
 * The recorders always masked every input; text on the page went out as is.
 * These rules mask the text of every FIELD of a record layout too — the edit
 * form's field rows (`[data-field]`, FieldRow) and the read view's values
 * (`[data-replay-field]`, RecordReadView) — with an allow-list an admin uses
 * to show a field that is safe to see (a status, a code) while everything
 * else stays masked. Rich text editors and file names are masked by their own
 * switches, wherever they appear and even inside an allowed field: allowing a
 * field says its plain value is safe, not that a document or an uploaded
 * file's name is.
 *
 * The rules live in nivaro_settings.replay_masking and reach both recorders
 * with the `/session-recordings/enabled` answer. One implementation for the
 * admin recorder (imported by path) and @nivaro/react's (bundled from source).
 *
 * rrweb only calls `maskTextFn` for text under `maskTextSelector`, so the
 * selector is the widest net (every field, every editor, every file name)
 * and the functions decide — which also means a rules change applies to the
 * next mutation without restarting the recorder.
 */

export interface ReplayMaskingRules {
  /** Mask rich text editors (tiptap / contenteditable), even in an allowed field. */
  mask_rich_text: boolean
  /** Mask file names (and file thumbnails), even in an allowed file field. */
  mask_file_names: boolean
  /** `collection.field` (or `*.field`) whose value shows unmasked. */
  allow_fields: string[]
}

export const DEFAULT_REPLAY_MASKING: ReplayMaskingRules = {
  mask_rich_text: true,
  mask_file_names: true,
  allow_fields: []
}

export const REPLAY_ALLOW_FIELDS_MAX = 200

/** `collection.field` or `*.field` — identifiers only, so a key is safe inside a CSS selector. */
export const REPLAY_FIELD_KEY = /^(\*|[A-Za-z0-9_-]{1,64})\.([A-Za-z0-9_-]{1,64})$/

/** Field hosts: the edit form's field row and the read view's value cell. */
export const REPLAY_FIELD_SELECTOR = '[data-field], [data-replay-field]'
export const REPLAY_RICH_TEXT_SELECTOR =
  '.ProseMirror, .tiptap, [contenteditable=""], [contenteditable="true"], [data-rich-text]'
export const REPLAY_FILE_NAME_SELECTOR = '[data-file-name]'
/** Field interfaces whose value is a file. */
export const REPLAY_FILE_INTERFACES = ['file', 'file-image', 'files', 'files-m2m', 'image'] as const
/** Always blocked (replaced by a placeholder box): the historic class plus an attribute hook. */
export const REPLAY_BLOCK_SELECTOR = '.nvr-no-record, [data-replay-block]'

/**
 * Rules from whatever the server (or a settings row) holds: an object or its
 * JSON text. Missing switches default to masked; allow-list entries that are
 * not `collection.field` are dropped.
 */
export function normalizeReplayMasking(raw: unknown): ReplayMaskingRules {
  let v: unknown = raw
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      v = null
    }
  }
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const allow = Array.isArray(o.allow_fields) ? o.allow_fields : []
  const seen = new Set<string>()
  for (const a of allow) {
    if (typeof a !== 'string') continue
    const k = a.trim()
    if (REPLAY_FIELD_KEY.test(k)) seen.add(k)
    if (seen.size >= REPLAY_ALLOW_FIELDS_MAX) break
  }
  return {
    mask_rich_text: o.mask_rich_text !== false,
    mask_file_names: o.mask_file_names !== false,
    allow_fields: [...seen]
  }
}

function fieldHost(el: Element): Element | null {
  try {
    return el.closest(REPLAY_FIELD_SELECTOR)
  } catch {
    return null
  }
}

/**
 * Which field a host is. The collection rides on the host itself
 * (`data-field-collection`) or on an ancestor (`data-collection`).
 */
export function replayFieldOf(host: Element): { collection: string | null; field: string } | null {
  const field = host.getAttribute('data-field') ?? host.getAttribute('data-replay-field')
  if (!field) return null
  const collection =
    host.getAttribute('data-field-collection') ??
    host.closest('[data-collection]')?.getAttribute('data-collection') ??
    null
  return { collection, field }
}

export function isReplayFieldAllowed(
  rules: ReplayMaskingRules,
  collection: string | null,
  field: string
): boolean {
  for (const key of rules.allow_fields) {
    const dot = key.indexOf('.')
    if (key.slice(dot + 1) !== field) continue
    const c = key.slice(0, dot)
    if (c === '*' || (collection != null && c === collection)) return true
  }
  return false
}

function hostAllowed(rules: ReplayMaskingRules, host: Element): boolean {
  const f = replayFieldOf(host)
  return !!f && isReplayFieldAllowed(rules, f.collection, f.field)
}

function isFileField(host: Element): boolean {
  const i = host.getAttribute('data-field-interface')
  return !!i && (REPLAY_FILE_INTERFACES as readonly string[]).includes(i)
}

function within(el: Element, selector: string): boolean {
  try {
    return !!el.closest(selector)
  } catch {
    return false
  }
}

/** Should this element's text be masked? `el` is the text node's parent. */
export function shouldMaskReplayText(el: Element | null, rules: ReplayMaskingRules): boolean {
  if (!el) return true
  if (rules.mask_rich_text && within(el, REPLAY_RICH_TEXT_SELECTOR)) return true
  if (rules.mask_file_names && within(el, REPLAY_FILE_NAME_SELECTOR)) return true
  const host = fieldHost(el)
  if (!host) return false
  // The field's own label says WHICH field this is — it is layout, not data.
  const label = el.closest('[data-field-label]')
  if (label && host.contains(label)) return false
  if (rules.mask_file_names && isFileField(host)) return true
  return !hostAllowed(rules, host)
}

/**
 * Should this input's value be masked? Inputs are masked everywhere
 * (maskAllInputs) except inside an allowed field — and a password never shows.
 */
export function shouldMaskReplayInput(el: Element | null, rules: ReplayMaskingRules): boolean {
  if (!el) return true
  if ((el as HTMLInputElement).type === 'password') return true
  if (el.getAttribute?.('autocomplete')?.includes('password')) return true
  if (rules.mask_rich_text && within(el, REPLAY_RICH_TEXT_SELECTOR)) return true
  const host = fieldHost(el)
  if (!host) return true
  if (rules.mask_file_names && isFileField(host)) return true
  return !hostAllowed(rules, host)
}

const maskChars = (text: string) => text.replace(/\S/g, '*')

export interface ReplayMaskingOptions {
  maskAllInputs: true
  blockClass: string
  blockSelector: string
  maskTextSelector: string
  maskTextFn: (text: string, element: HTMLElement | null) => string
  maskInputFn: (text: string, element: HTMLElement) => string
}

/**
 * rrweb `record()` options for a set of rules. `getRules` is read on every
 * call, so a recorder can hand over a ref and pick up a rules change live;
 * only the block selector (file thumbnails) is fixed when recording starts.
 */
export function buildReplayMaskingOptions(
  getRules: ReplayMaskingRules | (() => ReplayMaskingRules)
): ReplayMaskingOptions {
  const rules = typeof getRules === 'function' ? getRules : () => getRules
  const initial = rules()
  const block = [REPLAY_BLOCK_SELECTOR]
  if (initial.mask_file_names) {
    // A thumbnail shows what the file is as plainly as its name.
    block.push('[data-file-thumb]')
    for (const i of REPLAY_FILE_INTERFACES) block.push(`[data-field-interface="${i}"] img`)
  }
  return {
    maskAllInputs: true,
    blockClass: 'nvr-no-record',
    blockSelector: block.join(', '),
    maskTextSelector: [
      REPLAY_FIELD_SELECTOR,
      REPLAY_RICH_TEXT_SELECTOR,
      REPLAY_FILE_NAME_SELECTOR
    ].join(', '),
    maskTextFn: (text, element) =>
      shouldMaskReplayText(element, rules()) ? maskChars(text) : text,
    maskInputFn: (text, element) =>
      shouldMaskReplayInput(element, rules()) ? '*'.repeat(text.length) : text
  }
}
