import { createHash } from 'node:crypto'
import { db } from '../../db/index.js'
import { logActivity } from '../activity.js'
import { bodySecretNames } from '../body-secrets.js'
import { parseJson, toJsonStr } from '../pipeline-engine.js'
import { currentTenantKey } from '../tenant-rooms.js'
import { validateSpec } from './evaluate.js'
import { blockingProblems, renderBody } from './render.js'
import type { Problem } from './types.js'
import type { ValidateMode } from './validate.js'

// ─── Partner payload templates: the service ──────────────────────────────────
// Spec 2026-10-22 §4, §6.1, §7.2. A template has a published body senders use
// (nivaro_payload_templates.published_*) and a working draft in
// nivaro_payload_template_drafts (rev = optimistic concurrency); every publish
// also writes an immutable row in nivaro_payload_template_versions.
//
//   - Draft writes touch ONLY the drafts table, which config-epoch does not watch,
//     so editor autosaves never move the config epoch (every process would clear
//     every cache). Publish, seed and registrar metadata write the templates
//     table, which is watched.
//   - Seed, never overwrite: register inserts a missing template (draft =
//     published = the shipped default, version 1); an existing row's draft and
//     published bodies are never touched. A changed shipped default shows as
//     hasNewerDefault() until a body equal to it is published.
//   - Published bodies are cached per tenant (60 s): a publish here clears this
//     tenant's entries; another process's write clears them all through the
//     config epoch (cache-registrations.ts).
//   - Registered defs (scope / recent / senders functions) live in process, per
//     tenant; a def registered at boot (no tenant) answers for every tenant.

const T = 'nivaro_payload_templates'
const V = 'nivaro_payload_template_versions'
const D = 'nivaro_payload_template_drafts'
const KEY_RE = /^[a-z0-9-]+$/
/** A record collection name: a plain identifier (the same rule context queries use). */
const COLLECTION_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const CACHE_MS = 60_000
const DRAFT_RETRIES = 5
export const MODE_CHANGE_MESSAGE = 'Mode can only change through Convert to Liquid'

export type PayloadMode = 'map' | 'code'

export type PayloadTemplateDef = {
  key: string
  label: string
  description?: string
  external_api: string
  endpoint_path?: string
  collection: string
  default: { mode: PayloadMode; body: string }
  locked_keys?: string[]
  lookups?: Record<string, unknown>
  scope?: (id: string) => Promise<Record<string, unknown>>
  recent?: (limit: number) => Promise<string[]>
  /** Human labels for "Used by", e.g. `efp-ops: Push to Fusion button`. */
  senders?: string[]
}

export type RegisteredPayloadTemplate = PayloadTemplateDef & { owner: string }

/**
 * A template with its draft joined in and its JSON columns parsed. Bodies stay text (map spec
 * JSON or Liquid). With no draft row yet, the draft mirrors the published body and
 * `draft_rev` is 0 (the first save sends base_rev 0).
 */
export type TemplateRow = {
  id: number
  key: string
  label: string
  description: string | null
  external_api: string | null
  endpoint_path: string | null
  collection: string
  owner: string | null
  draft_mode: PayloadMode
  draft_body: string | null
  draft_rev: number
  draft_updated_by: string | null
  draft_updated_at: Date | string | null
  published_mode: PayloadMode | null
  published_body: string | null
  published_version: number | null
  published_at: Date | string | null
  published_by: string | null
  locked_keys: string[]
  /** The PUBLISHED lookups — what senders (erp_submit pushes, published renders) read. */
  lookups: Record<string, unknown> | null
  /** The draft's lookups (mirrors `lookups` until a draft row exists); previews of the draft. */
  draft_lookups: Record<string, unknown> | null
  default_hash: string | null
  created_at: Date | string | null
  updated_at: Date | string | null
}

export type TemplateVersionSummary = {
  id: number
  version: number
  mode: PayloadMode
  note: string
  published_by: string | null
  published_at: Date | string | null
}

export type TemplateVersion = TemplateVersionSummary & {
  body: string
  /** The lookups this version published. */
  lookups: Record<string, unknown> | null
}

export type PayloadTemplateErrorCode = 'unknown_key' | 'unpublished' | 'invalid' | 'conflict'

export class PayloadTemplateError extends Error {
  readonly code: PayloadTemplateErrorCode
  readonly problems: Problem[]
  constructor(code: PayloadTemplateErrorCode, message: string, problems: Problem[] = []) {
    super(message)
    this.name = 'PayloadTemplateError'
    this.code = code
    this.problems = problems
  }
}

/** Body secret names on an external API; undefined = unknown (no missing-secret check). */
export type SecretNamesResolver = (apiName: string) => Promise<string[] | undefined>

export type RenderTemplateOpts = {
  /** Render the saved draft instead of the published body (previews). Never throws on problems. */
  draft?: boolean
  /** Render this unsaved body instead (previews of an edit in progress). Implies draft. */
  draftBody?: { mode: PayloadMode; body: string }
  /** Defaults to body-secrets.ts `bodySecretNames` when that module is present. */
  secretNames?: SecretNamesResolver
}

export type RenderTemplateResult = {
  body: Record<string, unknown> | null
  problems: Problem[]
  values: Record<string, unknown>
  version: number | null
}

// ─── helpers ─────────────────────────────────────────────────────────────────

export const hashBody = (body: string): string =>
  createHash('sha256').update(body, 'utf8').digest('hex')

const problem = (message: string): Problem => ({
  field_id: '',
  path: '',
  message,
  severity: 'error'
})

const affected = (n: unknown): number => {
  if (typeof n === 'number') return n
  if (Array.isArray(n)) return n.length
  return Number(n) || 0
}

const isMode = (m: unknown): m is PayloadMode => m === 'map' || m === 'code'

const parseLocked = (raw: unknown): string[] => {
  const v = parseJson((raw as string | null) ?? null)
  return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : []
}

/** A lookups column (JSON text) as an object, or null. */
export function parseLookups(raw: unknown): Record<string, unknown> | null {
  const v = typeof raw === 'string' ? parseJson(raw) : raw
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** Same lookups (JSON-equal; null and {} both mean none). */
export function sameLookups(a: unknown, b: unknown): boolean {
  const norm = (x: unknown) => {
    const o = parseLookups(x)
    return o && Object.keys(o).length ? JSON.stringify(o) : 'null'
  }
  return norm(a) === norm(b)
}

/** `r` = a templates row with the draft columns aliased `draft_*` (null when no draft row). */
function toRow(r: Record<string, unknown>): TemplateRow {
  const lookups = parseLookups(r.lookups)
  const num = (v: unknown): number | null => (v == null ? null : Number(v))
  const publishedMode = isMode(r.published_mode) ? r.published_mode : null
  const hasDraft = r.draft_rev != null
  return {
    id: Number(r.id),
    key: String(r.key),
    label: String(r.label ?? r.key),
    description: (r.description as string | null) ?? null,
    external_api: (r.external_api as string | null) ?? null,
    endpoint_path: (r.endpoint_path as string | null) ?? null,
    collection: String(r.collection ?? ''),
    owner: (r.owner as string | null) ?? null,
    draft_mode: hasDraft && isMode(r.draft_mode) ? r.draft_mode : (publishedMode ?? 'map'),
    draft_body: hasDraft
      ? ((r.draft_body as string | null) ?? null)
      : ((r.published_body as string | null) ?? null),
    draft_rev: hasDraft ? Number(r.draft_rev) : 0,
    draft_updated_by: (r.draft_updated_by as string | null) ?? null,
    draft_updated_at: (r.draft_updated_at as Date | null) ?? null,
    published_mode: publishedMode,
    published_body: (r.published_body as string | null) ?? null,
    published_version: num(r.published_version),
    published_at: (r.published_at as Date | null) ?? null,
    published_by: (r.published_by as string | null) ?? null,
    locked_keys: parseLocked(r.locked_keys),
    lookups,
    draft_lookups: hasDraft ? parseLookups(r.draft_lookups) : lookups,
    default_hash: (r.default_hash as string | null) ?? null,
    created_at: (r.created_at as Date | null) ?? null,
    updated_at: (r.updated_at as Date | null) ?? null
  }
}

/**
 * Structural check of a body: map = valid field-map JSON; code = any text.
 * `strength` 'draft' lets incomplete rows through (drafts always save);
 * 'publish' requires every row complete.
 */
function checkBody(
  mode: unknown,
  body: unknown,
  what: string,
  strength: ValidateMode = 'publish'
): void {
  if (!isMode(mode)) {
    throw new PayloadTemplateError('invalid', `${what}: mode must be map or code`, [
      problem('mode must be map or code')
    ])
  }
  if (typeof body !== 'string') {
    throw new PayloadTemplateError('invalid', `${what}: body must be text`, [
      problem('body must be text')
    ])
  }
  if (mode === 'code') return
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch (e) {
    const msg = `Invalid field map JSON: ${e instanceof Error ? e.message : String(e)}`
    throw new PayloadTemplateError('invalid', `${what}: ${msg}`, [problem(msg)])
  }
  const v = validateSpec(parsed, { mode: strength })
  if (!v.ok) {
    throw new PayloadTemplateError(
      'invalid',
      `${what}: ${v.errors.join('; ')}`,
      v.errors.map(problem)
    )
  }
}

// ─── registry (in process, per tenant) ───────────────────────────────────────

const registries = new Map<string, Map<string, RegisteredPayloadTemplate>>()

function tenantRegistry(): Map<string, RegisteredPayloadTemplate> {
  const t = currentTenantKey()
  let m = registries.get(t)
  if (!m) {
    m = new Map()
    registries.set(t, m)
  }
  return m
}

/** The def a registrar registered for this key (this tenant first, then the boot-time one). */
export function registeredDef(key: string): RegisteredPayloadTemplate | null {
  return registries.get(currentTenantKey())?.get(key) ?? registries.get('')?.get(key) ?? null
}

/**
 * True when the registrar ships a default that differs from the one this row was seeded with —
 * or, given the row's published lookups, when the lookups it declares differ from them (a
 * declaration changed after someone published; registration leaves those alone). Reset to
 * default + publish clears both.
 */
export function hasNewerDefault(
  row: Pick<TemplateRow, 'key' | 'default_hash'> & Partial<Pick<TemplateRow, 'lookups'>>
): boolean {
  const def = registeredDef(row.key)
  if (!def) return false
  if (hashBody(def.default.body) !== row.default_hash) return true
  return 'lookups' in row && !sameLookups(row.lookups, def.lookups ?? null)
}

function validateDef(owner: string, def: PayloadTemplateDef): void {
  const bad = (m: string) => {
    throw new PayloadTemplateError('invalid', `Payload template '${def?.key}': ${m}`, [problem(m)])
  }
  if (typeof owner !== 'string' || !owner.trim()) bad('owner is required')
  if (!def || typeof def !== 'object') bad('definition is required')
  if (typeof def.key !== 'string' || def.key.length > 120 || !KEY_RE.test(def.key)) {
    bad('key must be lowercase letters, digits and dashes (at most 120)')
  }
  if (typeof def.label !== 'string' || !def.label.trim()) bad('label is required')
  if (typeof def.collection !== 'string' || !def.collection.trim()) bad('collection is required')
  if (typeof def.external_api !== 'string' || !def.external_api.trim()) {
    bad('external_api is required')
  }
  if (def.locked_keys !== undefined) {
    if (!Array.isArray(def.locked_keys) || def.locked_keys.some((k) => typeof k !== 'string')) {
      bad('locked_keys must be a list of output paths')
    }
  }
  if (
    def.lookups !== undefined &&
    (def.lookups === null || typeof def.lookups !== 'object' || Array.isArray(def.lookups))
  ) {
    bad('lookups must be an object')
  }
  for (const fn of ['scope', 'recent'] as const) {
    if (def[fn] !== undefined && typeof def[fn] !== 'function') bad(`${fn} must be a function`)
  }
  if (def.senders !== undefined) {
    if (!Array.isArray(def.senders) || def.senders.some((s) => typeof s !== 'string')) {
      bad('senders must be a list of labels')
    }
  }
  if (!def.default || typeof def.default !== 'object') bad('default is required')
  checkBody(def.default.mode, def.default.body, `Payload template '${def.key}' default`)
}

const sameJson = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/**
 * Register a shipped template. Validates before any side effect (throws PayloadTemplateError);
 * a database failure while seeding is reported and swallowed so it never kills the
 * registrar's register().
 */
export async function registerPayloadTemplate(
  owner: string,
  def: PayloadTemplateDef
): Promise<void> {
  validateDef(owner, def)
  tenantRegistry().set(def.key, { ...def, owner })
  try {
    await seed(owner, def)
  } catch (e) {
    // biome-ignore lint/suspicious/noConsole: a seed failure must be visible in the server log
    console.warn(
      `[payload-templates] could not seed '${def.key}': ${e instanceof Error ? e.message : e}`
    )
  }
}

/** Whether the template's live version is still its seed: version 1 and no version row a person
 *  published (seed / registrar rows carry published_by null). */
async function onlySeedPublished(row: TemplateRow): Promise<boolean> {
  if (row.published_version !== 1) return false
  const versions = (await db(V).where({ template_id: row.id }).select('published_by')) as Array<{
    published_by: string | null
  }>
  return versions.every((v) => v.published_by == null)
}

async function seed(owner: string, def: PayloadTemplateDef): Promise<void> {
  const meta = {
    label: def.label,
    description: def.description ?? null,
    external_api: def.external_api,
    endpoint_path: def.endpoint_path ?? null,
    collection: def.collection,
    owner,
    locked_keys: toJsonStr(def.locked_keys ?? []),
    lookups: toJsonStr(def.lookups ?? null)
  }
  const existing = await getTemplate(def.key)
  if (existing) {
    // Registrar-owned metadata follows the code. Draft and published bodies never do, and the
    // draft row (its body AND its lookups) is never touched here. The PUBLISHED lookups follow
    // the code only while the template still holds its seed (never published from the UI): once
    // someone published, a changed declaration waits behind hasNewerDefault() like a changed
    // body — pushes read published lookups, and a boot must not change what a person published.
    const { lookups, ...rest } = meta
    const lookupsDrift = !sameLookups(existing.lookups, def.lookups ?? null)
    const followLookups = lookupsDrift && (await onlySeedPublished(existing))
    const drift =
      existing.label !== meta.label ||
      existing.description !== meta.description ||
      existing.external_api !== meta.external_api ||
      existing.endpoint_path !== meta.endpoint_path ||
      existing.collection !== meta.collection ||
      existing.owner !== owner ||
      !sameJson(existing.locked_keys, def.locked_keys ?? []) ||
      followLookups
    if (drift) {
      await db(T)
        .where({ id: existing.id })
        .update({ ...rest, ...(followLookups ? { lookups } : {}), updated_at: new Date() })
      bustTenantCache()
    }
    return
  }
  const now = new Date()
  try {
    await db.transaction(async (trx) => {
      await trx(T).insert({
        key: def.key,
        ...meta,
        published_mode: def.default.mode,
        published_body: def.default.body,
        published_version: 1,
        published_at: now,
        published_by: null,
        default_hash: hashBody(def.default.body),
        created_at: now,
        updated_at: now
      })
      // Insert-then-select: `.returning('id')` shapes differ on this stack.
      const row = (await trx(T).where({ key: def.key }).first('id')) as { id: number } | undefined
      if (!row) throw new Error('seeded row not found')
      const id = Number(row.id)
      await trx(D).insert({
        template_id: id,
        mode: def.default.mode,
        body: def.default.body,
        lookups: meta.lookups,
        rev: 1,
        updated_by: null,
        updated_at: now
      })
      await trx(V).insert({
        template_id: id,
        version: 1,
        mode: def.default.mode,
        body: def.default.body,
        lookups: meta.lookups,
        note: `Seeded from ${owner}`.slice(0, 1000),
        published_by: null,
        published_at: now
      })
    })
  } catch (e) {
    // Another process seeded it first (unique key): that row stands.
    if (await getTemplate(def.key)) return
    throw e
  }
  bustTenantCache()
}

// ─── reads ───────────────────────────────────────────────────────────────────

const ROW_COLUMNS = [
  't.*',
  'd.mode as draft_mode',
  'd.body as draft_body',
  'd.lookups as draft_lookups',
  'd.rev as draft_rev',
  'd.updated_by as draft_updated_by',
  'd.updated_at as draft_updated_at'
]

const joined = () =>
  db(`${T} as t`).leftJoin(`${D} as d`, 't.id', 'd.template_id') as ReturnType<typeof db>

export async function getTemplate(key: string): Promise<TemplateRow | null> {
  const r = (await joined()
    .where({ 't.key': key })
    .first(...ROW_COLUMNS)) as Record<string, unknown> | undefined
  return r ? toRow(r) : null
}

export async function listTemplates(
  filter: { external_api?: string } = {}
): Promise<TemplateRow[]> {
  const q = joined()
  if (filter.external_api) q.where({ 't.external_api': filter.external_api })
  const rows = (await q.orderBy('t.label', 'asc').select(...ROW_COLUMNS)) as Record<
    string,
    unknown
  >[]
  return rows.map(toRow)
}

async function requireTemplate(key: string): Promise<TemplateRow> {
  const row = await getTemplate(key)
  if (!row) {
    throw new PayloadTemplateError('unknown_key', `Payload template '${key}' does not exist`)
  }
  return row
}

const summaryOf = (r: Record<string, unknown>): TemplateVersionSummary => ({
  id: Number(r.id),
  version: Number(r.version),
  mode: isMode(r.mode) ? r.mode : 'map',
  note: String(r.note ?? ''),
  published_by: (r.published_by as string | null) ?? null,
  published_at: (r.published_at as Date | null) ?? null
})

/** Every published version, newest first (no bodies). */
export async function listVersions(key: string): Promise<TemplateVersionSummary[]> {
  const row = await requireTemplate(key)
  const rows = (await db(V)
    .where({ template_id: row.id })
    .orderBy('version', 'desc')
    .select('id', 'version', 'mode', 'note', 'published_by', 'published_at')) as Record<
    string,
    unknown
  >[]
  return rows.map(summaryOf)
}

async function versionOf(templateId: number, version: number): Promise<TemplateVersion | null> {
  const r = (await db(V).where({ template_id: templateId, version }).first()) as
    | Record<string, unknown>
    | undefined
  return r
    ? { ...summaryOf(r), body: String(r.body ?? ''), lookups: parseLookups(r.lookups) }
    : null
}

export async function getVersion(key: string, version: number): Promise<TemplateVersion | null> {
  const row = await requireTemplate(key)
  return versionOf(row.id, version)
}

// ─── draft / publish ─────────────────────────────────────────────────────────

/** The mode the draft has now, or null when the template has never had a body. */
const currentMode = (row: TemplateRow): PayloadMode | null =>
  row.draft_rev > 0 ? row.draft_mode : row.published_mode

/** What one draft write sets; a field left out keeps its current value. */
type DraftPatch = { mode?: PayloadMode; body?: string; lookups?: Record<string, unknown> | null }

/** Thrown inside writeDraft's transaction to roll it back when the published version moved. */
const STALE_PUBLISHED = Symbol('stale-published')

/**
 * Write the draft at `base` (0 = no draft row yet → insert, starting from the published body
 * and lookups). Touches the drafts table only. False = `base` is not the current revision, or
 * (`basePublishedVersion` given) a publish moved the template past the version the editor saw —
 * nothing written either way.
 *
 * With `basePublishedVersion` the draft write and the published-version check share one
 * transaction, in publishDraft's lock order (draft row, then template row): a publish that got
 * the draft row first has committed before this reads the template row (stale), and one that
 * comes after finds the draft rev moved (stale for it). A check outside the write would let a
 * publish land in between.
 */
async function writeDraft(
  row: TemplateRow,
  base: number,
  patch: DraftPatch,
  userId: string | null,
  basePublishedVersion?: number | null
): Promise<boolean> {
  const now = new Date()
  const fields: Record<string, unknown> = {}
  if (patch.mode !== undefined) fields.mode = patch.mode
  if (patch.body !== undefined) fields.body = patch.body
  if (patch.lookups !== undefined) fields.lookups = toJsonStr(patch.lookups)
  let insert: Record<string, unknown> | null = null
  if (base === 0) {
    const mode = patch.mode ?? row.draft_mode
    const body = patch.body ?? row.draft_body
    if (body == null) {
      throw new PayloadTemplateError('invalid', `Payload template '${row.key}' has no body yet`, [
        problem('Save a body before changing the lookups')
      ])
    }
    insert = {
      template_id: row.id,
      mode,
      body,
      lookups: toJsonStr(patch.lookups !== undefined ? patch.lookups : row.lookups),
      rev: 1,
      updated_by: userId ?? null,
      updated_at: now
    }
  }
  const write = async (q: typeof db): Promise<boolean> => {
    if (insert) {
      // No id: the drafts table's id is an identity column.
      await q(D).insert(insert)
      return true
    }
    const n = await q(D)
      .where({ template_id: row.id, rev: base })
      .update({ ...fields, rev: base + 1, updated_by: userId ?? null, updated_at: now })
    return affected(n) > 0
  }
  try {
    if (basePublishedVersion === undefined) return await write(db)
    const seen = basePublishedVersion == null ? null : Number(basePublishedVersion)
    return await db.transaction(async (trx) => {
      if (!(await write(trx as unknown as typeof db))) return false
      const live = (await trx(T).where({ id: row.id }).first('published_version')) as
        | { published_version: number | null }
        | undefined
      const current = live?.published_version == null ? null : Number(live.published_version)
      // Someone published since the editor loaded: roll the draft write back.
      if (current !== seen) throw STALE_PUBLISHED
      return true
    })
  } catch (e) {
    if (e === STALE_PUBLISHED) return false
    if (insert) {
      // A draft row appeared in between (unique template_id): stale. Anything else is real.
      const exists = await db(D).where({ template_id: row.id }).first('template_id')
      if (exists) return false
    }
    throw e
  }
}

/**
 * Save the working draft. Stale `base_rev` → `{ ok: false, current }` and nothing written.
 * The mode never changes here; `{ convert: true }` (the Convert to Liquid route) allows
 * map → code only.
 */
export async function saveDraft(
  key: string,
  input: {
    mode: PayloadMode
    body: string
    base_rev: number
    /** The published version the editor last saw (null = unpublished); a publish since = stale.
     *  Checked inside the draft write's transaction. Omitted = not checked. */
    base_published_version?: number | null
  },
  userId: string | null,
  opts: { convert?: boolean } = {}
): Promise<{ ok: true; rev: number } | { ok: false; current: TemplateRow }> {
  const row = await requireTemplate(key)
  checkBody(input?.mode, input?.body, `Payload template '${key}' draft`, 'draft')
  const base = Number(input.base_rev)
  if (!Number.isInteger(base) || base < 0) {
    throw new PayloadTemplateError('invalid', 'base_rev must be a whole number', [
      problem('base_rev must be a whole number')
    ])
  }
  const was = currentMode(row)
  if (was && was !== input.mode && !(opts.convert && was === 'map' && input.mode === 'code')) {
    throw new PayloadTemplateError('invalid', MODE_CHANGE_MESSAGE, [problem(MODE_CHANGE_MESSAGE)])
  }
  const patch = { mode: input.mode, body: input.body }
  if (await writeDraft(row, base, patch, userId, input.base_published_version)) {
    return { ok: true, rev: base + 1 }
  }
  return { ok: false, current: await requireTemplate(key) }
}

/**
 * Save the draft's lookups (validated by the caller) under the same revision guard as the body:
 * stale `base_rev` → `{ ok: false, current }`, otherwise rev + 1. Published lookups — what pushes
 * read — change only on publish.
 */
export async function saveDraftLookups(
  key: string,
  input: {
    lookups: Record<string, unknown> | null
    base_rev: number
    /** As saveDraft: a publish since this version = stale, checked inside the write. */
    base_published_version?: number | null
  },
  userId: string | null
): Promise<{ ok: true; rev: number } | { ok: false; current: TemplateRow }> {
  const row = await requireTemplate(key)
  const base = Number(input?.base_rev)
  if (!Number.isInteger(base) || base < 0) {
    throw new PayloadTemplateError('invalid', 'base_rev must be a whole number', [
      problem('base_rev must be a whole number')
    ])
  }
  const lookups = parseLookups(input.lookups)
  if (await writeDraft(row, base, { lookups }, userId, input.base_published_version)) {
    return { ok: true, rev: base + 1 }
  }
  return { ok: false, current: await requireTemplate(key) }
}

const STALE = Symbol('stale')

/** Publish the saved draft as the next version. Stale `base_rev` → `{ ok: false, current }`. */
export async function publishDraft(
  key: string,
  input: { base_rev: number; note: string },
  userId: string | null
): Promise<{ ok: true; version: number } | { ok: false; current: TemplateRow }> {
  const row = await requireTemplate(key)
  const base = Number(input?.base_rev)
  if (row.draft_rev !== base) return { ok: false, current: row }
  if (row.draft_rev === 0) {
    throw new PayloadTemplateError('invalid', `Payload template '${key}' has no draft to publish`, [
      problem('There is no draft to publish')
    ])
  }
  const note = String(input.note ?? '')
    .trim()
    .slice(0, 1000)
  const def = registeredDef(key)
  const defaultHash = def ? hashBody(def.default.body) : null
  const now = new Date()
  const result = await db.transaction(async (trx) => {
    // A guarded no-op update takes the draft row's update lock until commit: a draft save in
    // between either landed first (rev moved → stale) or waits for this publish.
    const locked = await trx(D).where({ template_id: row.id, rev: base }).update({ rev: base })
    if (affected(locked) === 0) return STALE
    const draft = (await trx(D).where({ template_id: row.id }).first('mode', 'body', 'lookups')) as
      | { mode: string; body: string | null; lookups: string | null }
      | undefined
    if (!draft?.body?.trim()) {
      throw new PayloadTemplateError('invalid', `Payload template '${key}' has an empty draft`, [
        problem('The draft is empty')
      ])
    }
    // Publishing needs every row complete (a draft may be half-built).
    checkBody(draft.mode, draft.body, `Payload template '${key}' draft`, 'publish')
    const mode = draft.mode as PayloadMode
    // The draft's lookups go live with its body (null and {} both mean none).
    const lookups = toJsonStr(parseLookups(draft.lookups))
    const newest = (await trx(V)
      .where({ template_id: row.id })
      .orderBy('version', 'desc')
      .first('version')) as { version: number } | undefined
    const version = Math.max(row.published_version ?? 0, Number(newest?.version ?? 0)) + 1
    // The shipped-default baseline moves only when that default goes live.
    const adopt = defaultHash && hashBody(draft.body) === defaultHash ? defaultHash : null
    // Guarded on the version this caller saw: a publish that landed since makes this stale
    // (the draft lock alone would let two publishes of the same rev both go through).
    const n = await trx(T)
      .where({ id: row.id, published_version: row.published_version })
      .update({
        published_mode: mode,
        published_body: draft.body,
        published_version: version,
        published_at: now,
        published_by: userId ?? null,
        lookups,
        updated_at: now,
        ...(adopt ? { default_hash: adopt } : {})
      })
    if (affected(n) === 0) return STALE
    await trx(V).insert({
      template_id: row.id,
      version,
      mode,
      body: draft.body,
      lookups,
      note,
      published_by: userId ?? null,
      published_at: now
    })
    return version
  })
  if (result === STALE) return { ok: false, current: await requireTemplate(key) }
  bustTenantCache()
  await logActivity({
    action: 'payload-template-publish',
    user: userId,
    collection: T,
    item: key,
    comment: note ? `Published v${result}: ${note}` : `Published v${result}`
  })
  return { ok: true, version: result }
}

/** Write a draft (body, and lookups when given) on top of whatever revision is current (rev + 1). */
async function replaceDraft(
  row: TemplateRow,
  mode: PayloadMode,
  body: string,
  userId: string | null,
  lookups?: Record<string, unknown> | null
): Promise<number> {
  let current = row
  const patch: DraftPatch = { mode, body, ...(lookups !== undefined ? { lookups } : {}) }
  for (let attempt = 0; attempt < DRAFT_RETRIES; attempt++) {
    if (await writeDraft(current, current.draft_rev, patch, userId)) {
      return current.draft_rev + 1
    }
    current = await requireTemplate(row.key)
  }
  throw new PayloadTemplateError(
    'conflict',
    `Payload template '${row.key}' draft kept changing; try again`
  )
}

/** Put a published version's body into the draft. Null when that version does not exist. */
export async function restoreVersion(
  key: string,
  version: number,
  userId: string | null
): Promise<{ rev: number } | null> {
  const row = await requireTemplate(key)
  const v = await versionOf(row.id, version)
  if (!v) return null
  // The version's lookups come back with its body.
  const rev = await replaceDraft(row, v.mode, v.body, userId, v.lookups)
  await logActivity({
    action: 'payload-template-restore',
    user: userId,
    collection: T,
    item: key,
    comment: `Draft restored from v${version}`
  })
  return { rev }
}

/**
 * Put the registrar's shipped default into the draft. The newer-default flag stays until a
 * body equal to the default is published.
 */
export async function resetToDefault(key: string, userId: string | null): Promise<{ rev: number }> {
  const row = await requireTemplate(key)
  const def = registeredDef(key)
  if (!def) {
    throw new PayloadTemplateError('invalid', `Payload template '${key}' has no shipped default`, [
      problem('No extension registers a default for this template')
    ])
  }
  // The registrar's declared lookups are the default's.
  const rev = await replaceDraft(
    row,
    def.default.mode,
    def.default.body,
    userId,
    def.lookups ?? null
  )
  await logActivity({
    action: 'payload-template-reset',
    user: userId,
    collection: T,
    item: key,
    comment: `Draft reset to the ${def.owner} default`
  })
  return { rev }
}

// ─── install as draft (blueprints) ───────────────────────────────────────────

/** A template carried to another instance: its published body plus its row metadata. */
export type PayloadTemplateBundle = {
  key: string
  label: string
  description: string | null
  external_api: string | null
  endpoint_path: string | null
  collection: string
  mode: PayloadMode
  body: string
  locked_keys: string[]
  lookups: Record<string, unknown> | null
}

/**
 * Bring a template in from elsewhere (a blueprint) AS A DRAFT — never as a published version, so
 * nothing a sender uses changes until someone publishes it here.
 *   - Missing: the row is created unpublished (senders refuse it until it is published) with the
 *     bundle's metadata, and the body becomes its draft.
 *   - Existing: only the draft changes (the row's metadata stays the registrar's / the row's); a
 *     draft already equal to the body is left alone. The mode lock holds: map → code is allowed
 *     (the direction Convert to Liquid allows), code → map is refused.
 * Validates before any write (throws PayloadTemplateError).
 */
export async function installTemplateDraft(
  bundle: PayloadTemplateBundle,
  userId: string | null,
  note = 'Draft installed'
): Promise<'created' | 'drafted' | 'unchanged'> {
  const key = bundle?.key
  const bad = (m: string) => {
    throw new PayloadTemplateError('invalid', `Payload template '${key}': ${m}`, [problem(m)])
  }
  if (typeof key !== 'string' || key.length > 120 || !KEY_RE.test(key)) {
    bad('key must be lowercase letters, digits and dashes (at most 120)')
  }
  if (typeof bundle.label !== 'string' || !bundle.label.trim()) bad('label is required')
  if (typeof bundle.collection !== 'string' || !COLLECTION_RE.test(bundle.collection)) {
    bad('collection must be a plain collection name')
  }
  checkBody(bundle.mode, bundle.body, `Payload template '${key}' draft`, 'draft')
  const locked = Array.isArray(bundle.locked_keys)
    ? bundle.locked_keys.filter((k): k is string => typeof k === 'string')
    : []
  const lookups =
    bundle.lookups && typeof bundle.lookups === 'object' && !Array.isArray(bundle.lookups)
      ? bundle.lookups
      : null

  let row = await getTemplate(key)
  if (!row) {
    const now = new Date()
    let created = false
    try {
      await db.transaction(async (trx) => {
        await trx(T).insert({
          key,
          label: bundle.label,
          description: bundle.description ?? null,
          external_api: bundle.external_api ?? null,
          endpoint_path: bundle.endpoint_path ?? null,
          collection: bundle.collection,
          owner: null,
          published_mode: null,
          published_body: null,
          published_version: null,
          published_at: null,
          published_by: null,
          locked_keys: toJsonStr(locked),
          // Unpublished: nothing is live, lookups included; the bundle's go to the draft.
          lookups: null,
          default_hash: null,
          created_at: now,
          updated_at: now
        })
        // Insert-then-select: `.returning('id')` shapes differ on this stack.
        const r = (await trx(T).where({ key }).first('id')) as { id: number } | undefined
        if (!r) throw new Error('installed row not found')
        await trx(D).insert({
          template_id: Number(r.id),
          mode: bundle.mode,
          body: bundle.body,
          lookups: toJsonStr(lookups),
          rev: 1,
          updated_by: userId ?? null,
          updated_at: now
        })
      })
      created = true
    } catch (e) {
      // Another writer created it first (unique key): install over that row as a draft.
      row = await getTemplate(key)
      if (!row) throw e
    }
    if (created) {
      bustTenantCache()
      await logInstall(key, userId, `${note} (new, unpublished)`)
      return 'created'
    }
  }
  // Only reached with a row (found, or the one another writer created); narrows the type.
  if (!row)
    throw new PayloadTemplateError('conflict', `Payload template '${key}' could not be installed`)

  if (
    row.draft_mode === bundle.mode &&
    row.draft_body === bundle.body &&
    sameLookups(row.draft_lookups, lookups)
  )
    return 'unchanged'
  const was = currentMode(row)
  if (was && was !== bundle.mode && !(was === 'map' && bundle.mode === 'code')) {
    throw new PayloadTemplateError('invalid', `Payload template '${key}': ${MODE_CHANGE_MESSAGE}`, [
      problem(MODE_CHANGE_MESSAGE)
    ])
  }
  await replaceDraft(row, bundle.mode, bundle.body, userId, lookups)
  await logInstall(key, userId, note)
  return 'drafted'
}

/** The install's activity line. Best-effort: the write already happened, so a failed log never
 *  turns it into an error (or a created template into "unchanged"). */
async function logInstall(key: string, userId: string | null, comment: string): Promise<void> {
  try {
    await logActivity({
      action: 'payload-template-install',
      user: userId,
      collection: T,
      item: key,
      comment
    })
  } catch {
    /* activity is decoration here */
  }
}

// ─── published cache (per tenant) ────────────────────────────────────────────

/** What a published render needs — the cache never holds a draft. */
type PublishedTemplate = {
  key: string
  external_api: string | null
  locked_keys: string[]
  published_mode: PayloadMode | null
  published_body: string | null
  published_version: number | null
  /** The published lookups (never the draft's). */
  lookups: Record<string, unknown> | null
}
type CacheEntry = { at: number; row: PublishedTemplate | null }
const publishedCache = new Map<string, Map<string, CacheEntry>>()

/** Drop every tenant's cached published bodies (another process wrote; the config epoch). */
export function bustPayloadTemplateCache(): void {
  publishedCache.clear()
}

/** Drop this tenant's cached published bodies (a write made here). */
function bustTenantCache(): void {
  publishedCache.delete(currentTenantKey())
}

async function publishedTemplate(key: string): Promise<PublishedTemplate | null> {
  const r = (await db(T)
    .where({ key })
    .first(
      'key',
      'external_api',
      'locked_keys',
      'published_mode',
      'published_body',
      'published_version',
      'lookups'
    )) as Record<string, unknown> | undefined
  if (!r) return null
  return {
    key: String(r.key),
    external_api: (r.external_api as string | null) ?? null,
    locked_keys: parseLocked(r.locked_keys),
    published_mode: isMode(r.published_mode) ? r.published_mode : null,
    published_body: (r.published_body as string | null) ?? null,
    published_version: r.published_version == null ? null : Number(r.published_version),
    lookups: parseLookups(r.lookups)
  }
}

/**
 * What a sender (an erp_submit push) reads of a template besides its body: the PUBLISHED
 * lookups and the external API name, from the published cache. Null = unknown key.
 */
export async function publishedTemplateInfo(
  key: string
): Promise<{ lookups: Record<string, unknown> | null; external_api: string | null } | null> {
  const row = await cachedPublished(key)
  return row ? { lookups: row.lookups, external_api: row.external_api } : null
}

async function cachedPublished(key: string): Promise<PublishedTemplate | null> {
  const tenant = currentTenantKey()
  let m = publishedCache.get(tenant)
  if (!m) {
    m = new Map()
    publishedCache.set(tenant, m)
  }
  const hit = m.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.row
  const row = await publishedTemplate(key)
  m.set(key, { at: Date.now(), row })
  return row
}

// ─── render ──────────────────────────────────────────────────────────────────

const defaultSecretNames: SecretNamesResolver = (apiName) => bodySecretNames(apiName)

async function secretNamesFor(
  apiName: string | null,
  resolver: SecretNamesResolver
): Promise<string[] | undefined> {
  if (!apiName) return undefined
  try {
    const names = await resolver(apiName)
    return Array.isArray(names) ? names : undefined
  } catch (e) {
    // biome-ignore lint/suspicious/noConsole: a failed secret lookup must be visible in the server log
    console.warn(
      `[payload-templates] could not read body secrets of '${apiName}': ${e instanceof Error ? e.message : e}`
    )
    return undefined
  }
}

const unknownKey = (key: string) =>
  new PayloadTemplateError('unknown_key', `Payload template '${key}' does not exist`)

/**
 * Render a template for a scope. Published (default): cached body; throws PayloadTemplateError
 * for an unknown key, no published version, or blocking problems. Draft / draftBody: the
 * working copy, problems returned, never thrown (only an unknown key throws).
 */
export async function renderPayloadTemplate(
  key: string,
  scope: Record<string, unknown>,
  opts: RenderTemplateOpts = {}
): Promise<RenderTemplateResult> {
  const resolver = opts.secretNames ?? defaultSecretNames

  if (opts.draft || opts.draftBody) {
    const row = await getTemplate(key)
    if (!row) throw unknownKey(key)
    const secretNames = await secretNamesFor(row.external_api, resolver)
    const mode = opts.draftBody?.mode ?? row.draft_mode
    const body = opts.draftBody?.body ?? row.draft_body
    if (!isMode(mode)) {
      return {
        body: null,
        problems: [problem('mode must be map or code')],
        values: {},
        version: null
      }
    }
    if (body == null) {
      return { body: null, problems: [problem('The draft is empty')], values: {}, version: null }
    }
    const r = await renderBody(mode, body, scope, { lockedKeys: row.locked_keys, secretNames })
    return { ...r, version: null }
  }

  const row = await cachedPublished(key)
  if (!row) throw unknownKey(key)
  if (row.published_version == null || row.published_body == null || !row.published_mode) {
    throw new PayloadTemplateError(
      'unpublished',
      `Payload template '${key}' has no published version`
    )
  }
  const secretNames = await secretNamesFor(row.external_api, resolver)
  const r = await renderBody(row.published_mode, row.published_body, scope, {
    lockedKeys: row.locked_keys,
    secretNames
  })
  const blocking = blockingProblems(r.problems)
  if (blocking.length) {
    throw new PayloadTemplateError(
      'invalid',
      `Payload template '${key}' v${row.published_version} cannot be sent: ${blocking
        .map((p) => (p.path ? `${p.path}: ${p.message}` : p.message))
        .join('; ')}`,
      r.problems
    )
  }
  return { ...r, version: row.published_version }
}
