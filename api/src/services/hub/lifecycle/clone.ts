// Hub enhancement 46: app cloning. "Copy the structure of this environment's app" reads the
// source's structure export over its link (GET /api/hub-link/clone/blueprint, or the shared
// deployment's /api/hub-deployment/clone/apps/<tenant>/blueprint), keeps it in the template
// library as an ordinary template ("Clone of <app> · <env>", version clone-<UTC stamp>), and records
// where it came from (nivaro_hub_clones). Create app then installs it through the SAME template
// step every template uses (services/hub/create/template-step.ts → POST /api/hub-link/template on
// the new app, which sanitizes it again and installs it with services/blueprints.ts) — there is
// no second installer.
//
// Secrets never leave the source (services/hub-link/clone-export.ts empties them before it
// answers); the Hub checks again (scrubBlueprintSecrets finds nothing on a 0.3.215+ source, and
// anything it finds is emptied and counted) and the library's packageUpload sanitizes again.
// Flows arrive inactive and rules switched off (source, sanitizer and installer each make sure).

import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import { scrubBlueprintSecrets } from '../../blueprint-secrets.js'
import { isPublishedBlueprint, type PublishedBlueprint } from '../../blueprints.js'
import { hubLinkOrigin } from '../move/link-client.js'
import { compareVersions } from '../promote-plan.js'
import { openSecret } from '../secrets.js'
import {
  deploymentLinkBearer,
  getShared,
  linkUrlOrigin,
  openSharedToken,
  tenantIdFor
} from '../shared/store.js'
import { type HubTemplate, TemplateError, uploadTemplate } from '../templates/library.js'

export const CLONES = 'nivaro_hub_clones'
/** The first Nivaro version that answers the structure export (and installs roles + flows). */
export const CLONE_MIN_VERSION = '0.3.215'
export const CLONE_TIMEOUT_MS = 120_000
/** The answer (package + review) may be a little over the 8 MB bundle. */
export const CLONE_MAX_ANSWER_BYTES = 10 * 1024 * 1024

export class CloneError extends Error {
  code: string
  status: number
  constructor(code: string, message: string, status = 409) {
    super(message)
    this.name = 'CloneError'
    this.code = code
    this.status = status
  }
}

export interface CloneRow {
  id: number
  template_id: number
  source_app_id: number
  source_environment_id: number
  source_version: string | null
  counts: Record<string, number> | null
  scrubbed: string[]
  scrubbed_count: number
  captured_by: string | null
  captured_at: string | null
  /** Joined: the template it became (null once deleted from the library). */
  template?: { id: number; name: string; version: string; archived: boolean; used: number } | null
  source?: { app_key: string; app_name: string; env_key: string } | null
}

/** Where the Hub reads the structure export of one environment (no secret in it but the bearer). */
export interface CloneSource {
  kind: 'dedicated' | 'shared'
  url: string
  bearer: string
}

export type CloneFetch = (
  src: CloneSource,
  timeoutMs: number
) => Promise<{ status: number; body: unknown }>

export interface CloneDeps {
  fetch?: CloneFetch
  /** The version the source reports (its hub link status); default = the Hub's cached status. */
  version?: (envId: number) => Promise<string | null>
  now?: () => Date
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

async function readCapped(res: Response, max: number): Promise<string | null> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      void reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** The real call: bearer in its header only, no redirects, bounded time and size. */
export const defaultCloneFetch: CloneFetch = async (src, timeoutMs) => {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    let res: Response
    try {
      res = await fetch(src.url, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${src.bearer}` },
        redirect: 'error',
        signal: ctl.signal
      })
    } catch {
      throw new CloneError('SOURCE_UNREACHABLE', 'The source app did not answer.', 502)
    }
    const text = await readCapped(res, CLONE_MAX_ANSWER_BYTES)
    if (text === null)
      throw new CloneError('SOURCE_TOO_LARGE', 'The source answered with more than 10 MB.', 502)
    let body: unknown = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = null
    }
    return { status: res.status, body }
  } finally {
    clearTimeout(timer)
  }
}

/** Where to read an environment's structure, or a CloneError (no link, no token). */
export async function cloneSourceOf(envId: number): Promise<CloneSource> {
  const e = (await db('nivaro_hub_environments as e')
    .join('nivaro_hub_apps as a', 'a.id', 'e.app_id')
    .where('e.id', envId)
    .first('e.id', 'e.base_url', 'e.hub_token', 'e.placement_id', 'a.key as app_key')) as
    | Record<string, unknown>
    | undefined
  if (!e) throw new CloneError('NOT_FOUND', 'No such environment.', 404)
  if (e.placement_id != null) {
    const p = (await db('nivaro_hub_placements')
      .where({ id: e.placement_id })
      .first('kind', 'shared_deployment_id')) as
      | { kind: string; shared_deployment_id: number | null }
      | undefined
    if (p?.kind === 'shared' && p.shared_deployment_id != null) {
      const s = await getShared(Number(p.shared_deployment_id))
      const origin = s ? linkUrlOrigin(s.link_url) : null
      const token = s ? await openSharedToken(s.id) : null
      if (!s || !origin || !token)
        throw new CloneError(
          'LINK_NOT_SET',
          'The shared deployment’s link is not set up in the Hub.',
          409
        )
      const tenant = tenantIdFor({ key: String(e.app_key) }, { id: envId })
      return {
        kind: 'shared',
        url: `${origin}/api/hub-deployment/clone/apps/${encodeURIComponent(tenant)}/blueprint`,
        bearer: deploymentLinkBearer(token)
      }
    }
  }
  const origin = hubLinkOrigin(String(e.base_url ?? ''))
  if (!origin)
    throw new CloneError(
      'BAD_BASE_URL',
      'The app’s address is not one the Hub sends its token to (https, or plain http only to this machine).'
    )
  const token = openSecret((e.hub_token as string | null) ?? null)
  if (!token)
    throw new CloneError('HUB_TOKEN_MISSING', 'The Hub holds no hub token for this environment.')
  return { kind: 'dedicated', url: `${origin}/api/hub-link/clone/blueprint`, bearer: token }
}

const CODE_RE = /^[A-Z][A-Z0-9_]{0,63}$/

/** A refusal from the source, in the Hub's words (never the app's text). */
function sourceRefusal(status: number, body: unknown): CloneError {
  const c = (body as { code?: unknown } | null)?.code
  const code = typeof c === 'string' && CODE_RE.test(c) ? c : `HTTP_${status}`
  if (status === 401 || status === 403 || status === 429)
    return new CloneError(
      'SOURCE_REFUSED',
      'The source app refused the Hub on its link (check its HUB_TOKEN).',
      502
    )
  if (status === 404 && (code === `HTTP_404` || code === 'NOT_FOUND'))
    return new CloneError(
      'SOURCE_TOO_OLD',
      `The source app has no structure export: it runs a version older than ${CLONE_MIN_VERSION}.`
    )
  if (code === 'TOO_LARGE')
    return new CloneError('TOO_LARGE', 'The source app’s structure is larger than 8 MB.', 413)
  if (code === 'TOO_MANY_PARTS' || code === 'BAD_SHAPE')
    return new CloneError(code, 'The source app’s structure is larger than a template may hold.')
  if (code === 'NOTHING_TO_CLONE')
    return new CloneError(code, 'The source app has no collections of its own to copy.')
  return new CloneError(
    'SOURCE_SAID_NO',
    `The source app did not export its structure (${code}).`,
    502
  )
}

/** UTC stamp for a clone's template version: clone-20261125-1430 (TEMPLATE_VERSION_RE). */
export function cloneVersion(at: Date): string {
  const iso = at.toISOString()
  return `clone-${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`
}

async function cachedVersion(envId: number): Promise<string | null> {
  try {
    const row = (await db('nivaro_hub_environments')
      .where({ id: envId })
      .first('id', 'key', 'base_url', 'hub_token', 'placement_id')) as
      | {
          id: number
          key: string
          base_url: string
          hub_token: string | null
          placement_id: number | null
        }
      | undefined
    if (!row) return null
    const { readEnvironmentStatus } = await import('../status.js')
    const { getApp } = await import('../../io-holder.js')
    const redis = ((getApp() as unknown as { redis?: unknown } | null)?.redis ?? null) as never
    return (await readEnvironmentStatus({ ...row, id: Number(row.id) }, { redis })).version
  } catch {
    return null
  }
}

/**
 * Reads the structure of environment `envId`'s app and keeps it as a library template. Answers
 * the clone row (with its template). Admin-only at the route; logged there.
 */
export async function captureClone(
  envId: number,
  by: string | null,
  deps: CloneDeps = {}
): Promise<{ clone: CloneRow; template: HubTemplate }> {
  const env = (await db('nivaro_hub_environments as e')
    .join('nivaro_hub_apps as a', 'a.id', 'e.app_id')
    .where('e.id', envId)
    .first('e.id', 'e.key', 'e.status', 'e.app_id', 'a.key as app_key', 'a.name as app_name')) as
    | Record<string, unknown>
    | undefined
  if (!env) throw new CloneError('NOT_FOUND', 'No such environment.', 404)
  if (String(env.status) === 'archived')
    throw new CloneError('ENV_ARCHIVED', 'An archived environment runs nothing to copy from.')
  const version = await (deps.version ?? cachedVersion)(envId)
  if (version && /^\d+\.\d+\.\d+$/.test(version) && compareVersions(version, CLONE_MIN_VERSION) < 0)
    throw new CloneError(
      'SOURCE_TOO_OLD',
      `The source app runs ${version}; copying its structure needs ${CLONE_MIN_VERSION} or later.`
    )
  const src = await cloneSourceOf(envId)
  const got = await (deps.fetch ?? defaultCloneFetch)(src, CLONE_TIMEOUT_MS)
  if (got.status < 200 || got.status >= 300) throw sourceRefusal(got.status, got.body)
  const b = isObj(got.body) ? got.body : {}
  if (!isPublishedBlueprint(b.package))
    throw new CloneError(
      'SOURCE_BAD_ANSWER',
      'The source answered with something that is not a blueprint.',
      502
    )
  const pkg = b.package as PublishedBlueprint
  const sourceScrubbed = Array.isArray(b.scrubbed)
    ? b.scrubbed.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 300))
    : []
  // Defence in depth: the Hub empties anything a source left (a 0.3.215+ source leaves nothing).
  const again = scrubBlueprintSecrets(pkg.blueprint)
  const sourceVersion =
    typeof b.version === 'string' && /^[0-9A-Za-z._+-]{1,64}$/.test(b.version) ? b.version : version
  const now = (deps.now ?? (() => new Date()))()
  const appKey = String(env.app_key)
  const envKey = String(env.key)
  let template: HubTemplate
  try {
    template = await uploadTemplate(
      {
        bundle: { ...pkg, blueprint: again.blueprint },
        name: `Clone of ${appKey} · ${envKey}`.slice(0, 120),
        version: cloneVersion(now),
        description: `The structure of ${String(env.app_name || appKey)} (${envKey}${sourceVersion ? `, ${sourceVersion}` : ''}) copied ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC: collections, fields, relations, workflows and pipelines, layouts, queues, rules (off), roles and flows (inactive). No records, files, people or secrets.`
      },
      by
    )
  } catch (err) {
    if (err instanceof TemplateError) throw new CloneError(err.code, err.message, err.status)
    throw err
  }
  const scrubbed = [...new Set([...sourceScrubbed, ...again.scrubbed])].slice(0, 500)
  const counts = (template.manifest?.counts ?? null) as Record<string, number> | null
  const id = Number(
    await insertReturningId(db, CLONES, {
      template_id: template.id,
      source_app_id: Number(env.app_id),
      source_environment_id: envId,
      source_version: sourceVersion ?? null,
      counts: counts ? JSON.stringify(counts) : null,
      scrubbed: JSON.stringify(scrubbed),
      scrubbed_count: scrubbed.length,
      captured_by: by && /^[0-9a-f-]{36}$/i.test(by) ? by : null,
      captured_at: now
    })
  )
  const clone = (await readClone(id)) as CloneRow
  return { clone, template }
}

function parse<T>(v: unknown, fallback: T): T {
  if (v == null) return fallback
  if (typeof v === 'object') return v as T
  try {
    return JSON.parse(String(v)) as T
  } catch {
    return fallback
  }
}

const iso = (v: unknown): string | null => {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function fromRow(r: Record<string, unknown>): CloneRow {
  return {
    id: Number(r.id),
    template_id: Number(r.template_id),
    source_app_id: Number(r.source_app_id),
    source_environment_id: Number(r.source_environment_id),
    source_version: r.source_version == null ? null : String(r.source_version),
    counts: parse<Record<string, number> | null>(r.counts, null),
    scrubbed: parse<string[]>(r.scrubbed, []),
    scrubbed_count: Number(r.scrubbed_count ?? 0),
    captured_by: r.captured_by == null ? null : String(r.captured_by),
    captured_at: iso(r.captured_at),
    template:
      r.t_id == null
        ? null
        : {
            id: Number(r.t_id),
            name: String(r.t_name ?? ''),
            version: String(r.t_version ?? ''),
            archived: r.t_archived_at != null,
            used: 0
          },
    source:
      r.app_key == null
        ? null
        : {
            app_key: String(r.app_key),
            app_name: String(r.app_name ?? r.app_key),
            env_key: String(r.env_key ?? '')
          }
  }
}

function cloneQuery() {
  return db(`${CLONES} as c`)
    .leftJoin('nivaro_hub_app_templates as t', 't.id', 'c.template_id')
    .leftJoin('nivaro_hub_apps as a', 'a.id', 'c.source_app_id')
    .leftJoin('nivaro_hub_environments as e', 'e.id', 'c.source_environment_id')
    .select(
      'c.*',
      't.id as t_id',
      't.name as t_name',
      't.version as t_version',
      't.archived_at as t_archived_at',
      'a.key as app_key',
      'a.name as app_name',
      'e.key as env_key'
    )
}

export async function readClone(id: number): Promise<CloneRow | null> {
  const r = (await cloneQuery().where('c.id', id).first()) as Record<string, unknown> | undefined
  return r ? fromRow(r) : null
}

/** Recent clones, newest first (admins only at the route). */
export async function listClones(limit = 50): Promise<CloneRow[]> {
  const rows = (await cloneQuery()
    .orderBy('c.id', 'desc')
    .limit(Math.max(1, Math.min(200, limit)))) as Array<Record<string, unknown>>
  return rows.map(fromRow)
}
