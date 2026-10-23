import { createHash } from 'node:crypto'
import { db } from '../../db/index.js'
import { logActivity } from '../activity.js'
import { parseJson, toJsonStr } from '../pipeline-engine.js'
import { currentTenantKey } from '../tenant-rooms.js'
import { validateSpec } from './evaluate.js'
import { blockingProblems, renderBody } from './render.js'
import type { Problem } from './types.js'

// ─── Partner payload templates: the service ──────────────────────────────────
// Spec 2026-10-22 §4, §6.1, §7.2. A template has a working draft (draft_rev =
// optimistic concurrency) and a published body senders use; every publish also
// writes an immutable row in nivaro_payload_template_versions.
//
//   - Seed, never overwrite: register inserts a missing template (draft =
//     published = the shipped default, version 1); an existing row's draft and
//     published bodies are never touched. A changed shipped default only shows
//     as hasNewerDefault() until someone resets the draft to it.
//   - Published bodies are cached per tenant (60 s), busted here on publish and
//     by the config epoch (cache-registrations.ts) when another process writes.
//   - Registered defs (scope / recent / senders functions) live in process, per
//     tenant; a def registered at boot (no tenant) answers for every tenant.

const T = 'nivaro_payload_templates'
const V = 'nivaro_payload_template_versions'
const KEY_RE = /^[a-z0-9-]+$/
const CACHE_MS = 60_000

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

/** A template row with its JSON columns parsed. Bodies stay text (map spec JSON or Liquid). */
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
  lookups: Record<string, unknown> | null
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

export type TemplateVersion = TemplateVersionSummary & { body: string }

export type PayloadTemplateErrorCode = 'unknown_key' | 'unpublished' | 'invalid'

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

function toRow(r: Record<string, unknown>): TemplateRow {
  const locked = parseJson((r.locked_keys as string | null) ?? null)
  const lookups = parseJson((r.lookups as string | null) ?? null)
  const num = (v: unknown): number | null => (v == null ? null : Number(v))
  return {
    id: Number(r.id),
    key: String(r.key),
    label: String(r.label ?? r.key),
    description: (r.description as string | null) ?? null,
    external_api: (r.external_api as string | null) ?? null,
    endpoint_path: (r.endpoint_path as string | null) ?? null,
    collection: String(r.collection ?? ''),
    owner: (r.owner as string | null) ?? null,
    draft_mode: isMode(r.draft_mode) ? r.draft_mode : 'map',
    draft_body: (r.draft_body as string | null) ?? null,
    draft_rev: Number(r.draft_rev ?? 1),
    draft_updated_by: (r.draft_updated_by as string | null) ?? null,
    draft_updated_at: (r.draft_updated_at as Date | null) ?? null,
    published_mode: isMode(r.published_mode) ? r.published_mode : null,
    published_body: (r.published_body as string | null) ?? null,
    published_version: num(r.published_version),
    published_at: (r.published_at as Date | null) ?? null,
    published_by: (r.published_by as string | null) ?? null,
    locked_keys: Array.isArray(locked)
      ? locked.filter((k): k is string => typeof k === 'string')
      : [],
    lookups:
      lookups && typeof lookups === 'object' && !Array.isArray(lookups)
        ? (lookups as Record<string, unknown>)
        : null,
    default_hash: (r.default_hash as string | null) ?? null,
    created_at: (r.created_at as Date | null) ?? null,
    updated_at: (r.updated_at as Date | null) ?? null
  }
}

/** Structural check of a body: map = valid field-map JSON; code = any text. */
function checkBody(mode: unknown, body: unknown, what: string): void {
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
  const v = validateSpec(parsed)
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

/** True when the registrar ships a default that differs from the one this row was seeded with. */
export function hasNewerDefault(row: Pick<TemplateRow, 'key' | 'default_hash'>): boolean {
  const def = registeredDef(row.key)
  if (!def) return false
  return hashBody(def.default.body) !== row.default_hash
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
    // Registrar-owned metadata follows the code; draft and published bodies never do.
    const drift =
      existing.label !== meta.label ||
      existing.description !== meta.description ||
      existing.external_api !== meta.external_api ||
      existing.endpoint_path !== meta.endpoint_path ||
      existing.collection !== meta.collection ||
      existing.owner !== owner ||
      !sameJson(existing.locked_keys, def.locked_keys ?? []) ||
      !sameJson(existing.lookups, def.lookups ?? null)
    if (drift) {
      await db(T)
        .where({ id: existing.id })
        .update({ ...meta, updated_at: new Date() })
      bustPayloadTemplateCache()
    }
    return
  }
  const now = new Date()
  try {
    await db.transaction(async (trx) => {
      await trx(T).insert({
        key: def.key,
        ...meta,
        draft_mode: def.default.mode,
        draft_body: def.default.body,
        draft_rev: 1,
        draft_updated_by: null,
        draft_updated_at: now,
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
      await trx(V).insert({
        template_id: Number(row.id),
        version: 1,
        mode: def.default.mode,
        body: def.default.body,
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
  bustPayloadTemplateCache()
}

// ─── reads ───────────────────────────────────────────────────────────────────

export async function getTemplate(key: string): Promise<TemplateRow | null> {
  const r = (await db(T).where({ key }).first()) as Record<string, unknown> | undefined
  return r ? toRow(r) : null
}

export async function listTemplates(
  filter: { external_api?: string } = {}
): Promise<TemplateRow[]> {
  const q = db(T)
  if (filter.external_api) q.where({ external_api: filter.external_api })
  const rows = (await q.orderBy('label', 'asc').select()) as Record<string, unknown>[]
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

export async function getVersion(key: string, version: number): Promise<TemplateVersion | null> {
  const row = await requireTemplate(key)
  const r = (await db(V).where({ template_id: row.id, version }).first()) as
    | Record<string, unknown>
    | undefined
  return r ? { ...summaryOf(r), body: String(r.body ?? '') } : null
}

// ─── draft / publish ─────────────────────────────────────────────────────────

/** Save the working draft. Stale `base_rev` → `{ ok: false, current }` and nothing written. */
export async function saveDraft(
  key: string,
  input: { mode: PayloadMode; body: string; base_rev: number },
  userId: string | null
): Promise<{ ok: true; rev: number } | { ok: false; current: TemplateRow }> {
  checkBody(input?.mode, input?.body, `Payload template '${key}' draft`)
  const base = Number(input.base_rev)
  if (!Number.isInteger(base)) {
    throw new PayloadTemplateError('invalid', 'base_rev must be a whole number', [
      problem('base_rev must be a whole number')
    ])
  }
  const now = new Date()
  const n = await db(T)
    .where({ key, draft_rev: base })
    .update({
      draft_mode: input.mode,
      draft_body: input.body,
      draft_rev: base + 1,
      draft_updated_by: userId ?? null,
      draft_updated_at: now,
      updated_at: now
    })
  if (affected(n) > 0) return { ok: true, rev: base + 1 }
  return { ok: false, current: await requireTemplate(key) }
}

/** Publish the saved draft as the next version. Stale `base_rev` → `{ ok: false, current }`. */
export async function publishDraft(
  key: string,
  input: { base_rev: number; note: string },
  userId: string | null
): Promise<{ ok: true; version: number } | { ok: false; current: TemplateRow }> {
  const row = await requireTemplate(key)
  if (row.draft_rev !== Number(input?.base_rev)) return { ok: false, current: row }
  if (row.draft_body == null || !row.draft_body.trim()) {
    throw new PayloadTemplateError('invalid', `Payload template '${key}' has an empty draft`, [
      problem('The draft is empty')
    ])
  }
  checkBody(row.draft_mode, row.draft_body, `Payload template '${key}' draft`)
  const newest = (await db(V)
    .where({ template_id: row.id })
    .orderBy('version', 'desc')
    .first('version')) as { version: number } | undefined
  const version = Math.max(row.published_version ?? 0, Number(newest?.version ?? 0)) + 1
  const note = String(input.note ?? '')
    .trim()
    .slice(0, 1000)
  const now = new Date()
  const published = await db.transaction(async (trx) => {
    // Guarded on both numbers: a draft save or another publish in between makes this a no-op.
    const n = await trx(T)
      .where({ id: row.id, draft_rev: row.draft_rev, published_version: row.published_version })
      .update({
        published_mode: row.draft_mode,
        published_body: row.draft_body,
        published_version: version,
        published_at: now,
        published_by: userId ?? null,
        updated_at: now
      })
    if (affected(n) === 0) return false
    await trx(V).insert({
      template_id: row.id,
      version,
      mode: row.draft_mode,
      body: row.draft_body,
      note,
      published_by: userId ?? null,
      published_at: now
    })
    return true
  })
  if (!published) return { ok: false, current: await requireTemplate(key) }
  bustPayloadTemplateCache()
  await logActivity({
    action: 'payload-template-publish',
    user: userId,
    collection: T,
    item: key,
    comment: note ? `Published v${version}: ${note}` : `Published v${version}`
  })
  return { ok: true, version }
}

/** Write a draft body unconditionally on top of whatever revision is current (rev + 1). */
async function replaceDraft(
  row: TemplateRow,
  mode: PayloadMode,
  body: string,
  userId: string | null,
  extra: Record<string, unknown> = {}
): Promise<number> {
  let current = row
  for (let attempt = 0; attempt < 5; attempt++) {
    const now = new Date()
    const n = await db(T)
      .where({ id: current.id, draft_rev: current.draft_rev })
      .update({
        draft_mode: mode,
        draft_body: body,
        draft_rev: current.draft_rev + 1,
        draft_updated_by: userId ?? null,
        draft_updated_at: now,
        updated_at: now,
        ...extra
      })
    if (affected(n) > 0) return current.draft_rev + 1
    current = await requireTemplate(row.key)
  }
  throw new Error(`Payload template '${row.key}' draft kept changing; try again`)
}

/** Put a published version's body into the draft. Null when that version does not exist. */
export async function restoreVersion(
  key: string,
  version: number,
  userId: string | null
): Promise<{ rev: number } | null> {
  const row = await requireTemplate(key)
  const v = await getVersion(key, version)
  if (!v) return null
  const rev = await replaceDraft(row, v.mode, v.body, userId)
  await logActivity({
    action: 'payload-template-restore',
    user: userId,
    collection: T,
    item: key,
    comment: `Draft restored from v${version}`
  })
  return { rev }
}

/** Put the registrar's shipped default into the draft (and adopt its hash as the baseline). */
export async function resetToDefault(key: string, userId: string | null): Promise<{ rev: number }> {
  const row = await requireTemplate(key)
  const def = registeredDef(key)
  if (!def) {
    throw new PayloadTemplateError('invalid', `Payload template '${key}' has no shipped default`, [
      problem('No extension registers a default for this template')
    ])
  }
  const rev = await replaceDraft(row, def.default.mode, def.default.body, userId, {
    default_hash: hashBody(def.default.body)
  })
  await logActivity({
    action: 'payload-template-reset',
    user: userId,
    collection: T,
    item: key,
    comment: `Draft reset to the ${def.owner} default`
  })
  return { rev }
}

// ─── published cache (per tenant) ────────────────────────────────────────────

type CacheEntry = { at: number; row: TemplateRow | null }
const publishedCache = new Map<string, Map<string, CacheEntry>>()

/** Drop every tenant's cached published bodies. */
export function bustPayloadTemplateCache(): void {
  publishedCache.clear()
}

async function cachedTemplate(key: string): Promise<TemplateRow | null> {
  const tenant = currentTenantKey()
  let m = publishedCache.get(tenant)
  if (!m) {
    m = new Map()
    publishedCache.set(tenant, m)
  }
  const hit = m.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.row
  const row = await getTemplate(key)
  m.set(key, { at: Date.now(), row })
  return row
}

// ─── render ──────────────────────────────────────────────────────────────────

// Body secrets (Task 6) live in ../body-secrets.ts; looked up lazily so this module works
// with or without it. A variable specifier keeps tsc from requiring the file.
const BODY_SECRETS_MODULE = '../body-secrets.js'
let bodySecretNamesFn: Promise<SecretNamesResolver | null> | null = null

const defaultSecretNames: SecretNamesResolver = async (apiName) => {
  bodySecretNamesFn ??= import(BODY_SECRETS_MODULE)
    .then((m: Record<string, unknown>) =>
      typeof m?.bodySecretNames === 'function' ? (m.bodySecretNames as SecretNamesResolver) : null
    )
    .catch(() => null)
  const fn = await bodySecretNamesFn
  return fn ? fn(apiName) : undefined
}

async function secretNamesFor(
  apiName: string | null,
  resolver: SecretNamesResolver
): Promise<string[] | undefined> {
  if (!apiName) return undefined
  try {
    const names = await resolver(apiName)
    return Array.isArray(names) ? names : undefined
  } catch {
    return undefined
  }
}

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
  const preview = !!opts.draft || !!opts.draftBody
  const row = preview ? await getTemplate(key) : await cachedTemplate(key)
  if (!row) {
    throw new PayloadTemplateError('unknown_key', `Payload template '${key}' does not exist`)
  }
  const resolver = opts.secretNames ?? defaultSecretNames
  const secretNames = await secretNamesFor(row.external_api, resolver)
  const renderOpts = { lockedKeys: row.locked_keys, secretNames }

  if (preview) {
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
    const r = await renderBody(mode, body, scope, renderOpts)
    return { ...r, version: null }
  }

  if (row.published_version == null || row.published_body == null || !row.published_mode) {
    throw new PayloadTemplateError(
      'unpublished',
      `Payload template '${key}' has no published version`
    )
  }
  const r = await renderBody(row.published_mode, row.published_body, scope, renderOpts)
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
