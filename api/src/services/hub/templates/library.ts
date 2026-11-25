// Hub app templates (Hub enhancement 24): the template library. One row per uploaded App
// Blueprint (Promotion → Blueprints: Export or Publish), stored as a published package
// ({type:'nivaro-blueprint-package', manifest, blueprint}) with a name, description and version.
// The bundle and its digest never change after upload (a new version is a new upload); name and
// description can be edited, a template archived (hidden from Create app) or deleted while no
// creation has used it. Reads answer the manifest (counts, collections), never the bundle unless
// asked (`withBundle`, the creation step and the download route).
import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import {
  type SanitizeReview,
  sanitizeBlueprint,
  TemplateShapeError
} from '../../blueprint-sanitize.js'
import {
  type BlueprintManifest,
  buildManifest,
  isPublishedBlueprint,
  type PublishedBlueprint,
  unwrapBlueprint
} from '../../blueprints.js'

export const TEMPLATES = 'nivaro_hub_app_templates'
export const TEMPLATE_INSTALLS = 'nivaro_hub_template_installs'

/**
 * Largest bundle the library keeps (the JSON as stored). 8 MB stays well inside MySQL/MariaDB's
 * default max_allowed_packet (16 MB) with protocol overhead, and inside the app's body limit.
 */
export const TEMPLATE_MAX_BYTES = 8 * 1024 * 1024
export const TEMPLATE_NAME_MAX = 120
export const TEMPLATE_DESCRIPTION_MAX = 1000
export const TEMPLATE_VERSION_RE = /^[0-9A-Za-z._-]{1,40}$/

export class TemplateError extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status = 400) {
    super(message)
    this.name = 'TemplateError'
    this.code = code
    this.status = status
  }
}

export interface HubTemplate {
  id: number
  name: string
  version: string
  description: string | null
  digest: string
  size_bytes: number
  /** The export's manifest, plus `review`: what upload removed or left out (blueprint-sanitize). */
  manifest: (BlueprintManifest & { review?: SanitizeReview }) | null
  archived: boolean
  archived_at: string | null
  created_by: string | null
  created_at: string | null
  updated_at: string | null
  /** Environments a creation installed (or is installing) it into. */
  used: number
}

export interface HubTemplateWithBundle extends HubTemplate {
  bundle: PublishedBlueprint
}

const iso = (v: unknown): string | null => {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function parseJson<T>(v: unknown): T | null {
  if (v == null) return null
  if (typeof v === 'object') return v as T
  try {
    return JSON.parse(String(v)) as T
  } catch {
    return null
  }
}

function fromRow(r: Record<string, unknown>, used = 0): HubTemplate {
  return {
    id: Number(r.id),
    name: String(r.name ?? ''),
    version: String(r.version ?? ''),
    description: r.description == null ? null : String(r.description),
    digest: String(r.digest ?? ''),
    size_bytes: Number(r.size_bytes ?? 0),
    manifest: parseJson<BlueprintManifest & { review?: SanitizeReview }>(r.manifest),
    archived: r.archived_at != null,
    archived_at: iso(r.archived_at),
    created_by: r.created_by == null ? null : String(r.created_by),
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
    used
  }
}

const LIST_COLS = [
  'id',
  'name',
  'version',
  'description',
  'digest',
  'size_bytes',
  'manifest',
  'archived_at',
  'created_by',
  'created_at',
  'updated_at'
]

async function usage(ids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  if (!ids.length) return out
  // Rows of environments that no longer exist (a creation thrown away) do not count (review L5).
  const rows = (await db(`${TEMPLATE_INSTALLS} as i`)
    .join('nivaro_hub_environments as e', 'e.id', 'i.environment_id')
    .whereIn('i.template_id', ids)
    .groupBy('i.template_id')
    .select('i.template_id as template_id')
    .count({ n: '*' })) as Array<{ template_id: number; n: number | string }>
  for (const r of rows) out.set(Number(r.template_id), Number(r.n))
  return out
}

export async function listTemplates(opts: { archived?: boolean } = {}): Promise<HubTemplate[]> {
  const q = db(TEMPLATES).select(LIST_COLS).orderBy('name', 'asc').orderBy('id', 'desc')
  if (!opts.archived) q.whereNull('archived_at')
  const rows = (await q) as Array<Record<string, unknown>>
  const used = await usage(rows.map((r) => Number(r.id)))
  return rows.map((r) => fromRow(r, used.get(Number(r.id)) ?? 0))
}

export async function readTemplate(
  id: number,
  k: Knex | Knex.Transaction = db
): Promise<HubTemplate | null> {
  const r = (await k(TEMPLATES).where({ id }).first(LIST_COLS)) as
    | Record<string, unknown>
    | undefined
  if (!r) return null
  return fromRow(r, (await usage([id])).get(id) ?? 0)
}

export async function readTemplateBundle(id: number): Promise<HubTemplateWithBundle | null> {
  const r = (await db(TEMPLATES)
    .where({ id })
    .first([...LIST_COLS, 'bundle'])) as Record<string, unknown> | undefined
  if (!r) return null
  const bundle = parseJson<PublishedBlueprint>(r.bundle)
  if (!bundle || !isPublishedBlueprint(bundle))
    throw new TemplateError('TEMPLATE_UNREADABLE', 'The stored template cannot be read.', 500)
  return { ...fromRow(r), bundle }
}

/** sha256 of the stored JSON: what the app checks the bundle it receives against. */
export function templateDigest(json: string): string {
  return `sha256:${createHash('sha256').update(json).digest('hex')}`
}

function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t.slice(0, max) : null
}

export interface TemplateUpload {
  bundle: unknown
  name?: unknown
  description?: unknown
  version?: unknown
}

/**
 * Pure: an upload → the package to store (the blueprint re-wrapped with a manifest that carries
 * this template's own name, description and version) and its JSON, or a TemplateError.
 */
export function packageUpload(up: TemplateUpload): {
  name: string
  version: string
  description: string | null
  pkg: PublishedBlueprint
  json: string
  review: SanitizeReview
} {
  const raw = unwrapBlueprint(up?.bundle)
  if (!raw)
    throw new TemplateError(
      'BAD_BUNDLE',
      'That is not an App Blueprint export (Promotion → Blueprints: Export or Publish).'
    )
  // Review M3/L4: kept columns only, every part inside the template's own collections, capped.
  let bp: ReturnType<typeof sanitizeBlueprint>['blueprint']
  let review: SanitizeReview
  try {
    const clean = sanitizeBlueprint(raw)
    bp = clean.blueprint
    review = clean.review
  } catch (err) {
    if (err instanceof TemplateShapeError) throw new TemplateError(err.code, err.message)
    throw err
  }
  if (!bp.collections.length)
    throw new TemplateError('EMPTY_BUNDLE', 'The blueprint brings no business collections.')
  const given = isPublishedBlueprint(up.bundle) ? up.bundle.manifest : null
  const name = cleanText(up.name, TEMPLATE_NAME_MAX) ?? cleanText(bp.name, TEMPLATE_NAME_MAX)
  if (!name) throw new TemplateError('BAD_NAME', 'Give the template a name.')
  const version = cleanText(up.version, 40) ?? cleanText(given?.version ?? null, 40) ?? '1.0.0'
  if (!TEMPLATE_VERSION_RE.test(version))
    throw new TemplateError(
      'BAD_VERSION',
      'A version is 1–40 letters, digits, dots, dashes or underscores (like 1.2.0).'
    )
  const description =
    up.description === undefined
      ? cleanText(given?.description ?? null, TEMPLATE_DESCRIPTION_MAX)
      : cleanText(up.description, TEMPLATE_DESCRIPTION_MAX)
  const pkg: PublishedBlueprint = {
    type: 'nivaro-blueprint-package',
    version: 1,
    manifest: buildManifest(bp, {
      description,
      version,
      nivaroVersion: given?.nivaro_version ?? 'unknown'
    }),
    blueprint: bp
  }
  const json = JSON.stringify(pkg)
  if (Buffer.byteLength(json) > TEMPLATE_MAX_BYTES)
    throw new TemplateError('TOO_LARGE', 'The blueprint is larger than 8 MB.', 413)
  return { name, version, description, pkg, json, review }
}

async function nameTaken(name: string, version: string, exceptId?: number): Promise<boolean> {
  const q = db(TEMPLATES).where({ name, version })
  if (exceptId != null) q.whereNot({ id: exceptId })
  return !!(await q.first('id'))
}

export async function uploadTemplate(up: TemplateUpload, by: string | null): Promise<HubTemplate> {
  const p = packageUpload(up)
  if (await nameTaken(p.name, p.version))
    throw new TemplateError(
      'TEMPLATE_EXISTS',
      `${p.name} ${p.version} is in the library already; upload it as a new version.`,
      409
    )
  const now = new Date()
  const id = Number(
    await insertReturningId(db, TEMPLATES, {
      name: p.name,
      version: p.version,
      description: p.description,
      bundle: p.json,
      digest: templateDigest(p.json),
      size_bytes: Buffer.byteLength(p.json),
      manifest: JSON.stringify({ ...p.pkg.manifest, review: p.review }),
      created_by: by || null,
      created_at: now,
      updated_at: now
    })
  )
  return (await readTemplate(id)) as HubTemplate
}

export async function patchTemplate(
  id: number,
  patch: { name?: unknown; description?: unknown; archived?: unknown }
): Promise<HubTemplate> {
  const cur = await readTemplate(id)
  if (!cur) throw new TemplateError('NOT_FOUND', 'No such template.', 404)
  const out: Record<string, unknown> = {}
  if (patch.name !== undefined) {
    const name = cleanText(patch.name, TEMPLATE_NAME_MAX)
    if (!name) throw new TemplateError('BAD_NAME', 'Give the template a name.')
    if (await nameTaken(name, cur.version, id))
      throw new TemplateError(
        'TEMPLATE_EXISTS',
        `${name} ${cur.version} is in the library already.`,
        409
      )
    out.name = name
  }
  if (patch.description !== undefined)
    out.description = cleanText(patch.description, TEMPLATE_DESCRIPTION_MAX)
  if (patch.archived !== undefined) {
    if (typeof patch.archived !== 'boolean')
      throw new TemplateError('BAD_ARCHIVED', 'archived is true or false.')
    out.archived_at = patch.archived
      ? cur.archived_at
        ? new Date(cur.archived_at)
        : new Date()
      : null
  }
  if (Object.keys(out).length) {
    out.updated_at = new Date()
    await db(TEMPLATES).where({ id }).update(out)
  }
  return (await readTemplate(id)) as HubTemplate
}

/** Deleted only while no creation used it (an install row keeps its template id): else archive. */
export async function deleteTemplate(id: number): Promise<void> {
  const cur = await readTemplate(id)
  if (!cur) throw new TemplateError('NOT_FOUND', 'No such template.', 404)
  if (cur.used > 0)
    throw new TemplateError(
      'TEMPLATE_IN_USE',
      'A creation used this template; archive it instead (it then leaves Create app).',
      409
    )
  await db(TEMPLATES).where({ id }).del()
}
