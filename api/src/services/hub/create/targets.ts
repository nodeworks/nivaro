// Hub creation targets (phase 3): where a new app is created — a GitLab namespace, the template
// its deploy repository is forked from, the deploy host and how hostnames are made. The GitLab
// token is sealed (secrets.ts) and only ever answered as the mask. Kind `gitlab` only in this
// phase; a `docker` kind belongs in this same table later.

import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import type { GitCtx } from '../../gitlab-client.js'
import type { Validation } from '../drivers.js'
import { GitlabWriteError } from '../gitlab-write.js'
import { HubSecretError, maskSecret, nextSecret, openSecret } from '../secrets.js'
import { dnsSuffix, httpAllowed } from './dns.js'
import {
  currentUser,
  groupAccessLevel,
  namespaceExists,
  projectExists
} from './gitlab-provision.js'

/** GitLab access level a target's token needs on its namespace (Maintainer). */
const MAINTAINER = 40

export interface HubTargetConfig {
  api: string
  namespace: string
  template_project: string
  /** Tag or commit sha of template_project that app repositories include the deploy job from. */
  template_ref: string
  pin_file: string
  deploy_job: string
  deploy_host: string
  /** known_hosts lines of the swarm manager: the deploy job refuses any other host key. */
  manager_known_hosts: string
  proxy_network: string
  dns_mode: 'automatic' | 'manual'
  wildcard_domain: string | null
  edge_address: string | null
  scheme: 'https' | 'http'
  port: number | null
  cert_note: string | null
}

/** A target as stored: config parsed, token still sealed. */
export interface HubTargetRow {
  id: number
  kind: 'gitlab'
  name: string
  config: HubTargetConfig
  secret: string | null
}

/** A target as the API shows it: the token is only ever the mask. */
export interface HubTarget {
  id: number
  kind: 'gitlab'
  name: string
  config: HubTargetConfig
  secret: string | null
}

export type TargetFields = Omit<HubTargetRow, 'id'>

export interface TargetCheck {
  id: 'token' | 'namespace' | 'template'
  ok: boolean
  text: string
}

const CONFIG_KEYS = [
  'api',
  'namespace',
  'template_project',
  'template_ref',
  'pin_file',
  'deploy_job',
  'deploy_host',
  'manager_known_hosts',
  'proxy_network',
  'dns_mode',
  'wildcard_domain',
  'edge_address',
  'scheme',
  'port',
  'cert_note'
] as const

const DEFAULTS = {
  pin_file: '.hub/nivaro-version',
  deploy_job: 'deploy',
  proxy_network: 'proxy',
  scheme: 'https'
} as const

/** A GitLab project / namespace path (or numeric id). */
const GITLAB_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/
/** `host`, `user@host`, `host:port` — never a leading `-` (it would read as an ssh option). */
const DEPLOY_HOST = /^[A-Za-z0-9][A-Za-z0-9._-]*(@[A-Za-z0-9.-]+)?(:\d+)?$/

function fail(code: string, message: string): { ok: false; code: string; message: string } {
  return { ok: false, code, message }
}

function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
}

function validApiUrl(raw: string): boolean {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  // A token-bearing base URL carries no credentials, query or fragment.
  if (u.username || u.password || u.search || u.hash) return false
  if (u.protocol === 'https:') return true
  return u.protocol === 'http:' && isLocalHost(u.hostname)
}

function originOf(raw: string): string {
  try {
    return new URL(raw).origin
  } catch {
    return raw
  }
}

/**
 * A pinned ref of the template: a full commit sha, or a tag-like name. Branch names people
 * move (main, master, HEAD, develop) are refused: the deploy job must not change under an app.
 */
export function validTemplateRef(v: unknown): v is string {
  if (typeof v !== 'string') return false
  if (/^[0-9a-f]{40}$/.test(v) || /^[0-9a-f]{64}$/.test(v)) return true
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(v) || v.includes('..') || v.endsWith('.lock'))
    return false
  return !['main', 'master', 'head', 'develop', 'development', 'trunk'].includes(v.toLowerCase())
}

const KEY_TYPES = new Set([
  'ssh-ed25519',
  'ssh-rsa',
  'ecdsa-sha2-nistp256',
  'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com',
  'sk-ecdsa-sha2-nistp256@openssh.com'
])
/** Host patterns (`host`, `[host]:port`, comma lists, `*`/`?` wildcards) or a hashed `|1|salt|hash`. */
const KH_HOSTS = /^(\|1\|[A-Za-z0-9+/=]+\|[A-Za-z0-9+/=]+|[A-Za-z0-9.:*?![\]_,-]+)$/
const KH_KEY = /^[A-Za-z0-9+/]{16,}={0,2}$/

/**
 * ssh known_hosts text: `[@cert-authority|@revoked] <hosts> <key type> <base64 key> [comment]`
 * lines only (blank and `#` lines dropped). Answers the normalised lines (single spaces, no
 * comments), or null when any line is something else, there is none, or it is too long.
 */
export function parseKnownHosts(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 16_000) return null
  const out: string[] = []
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const parts = t.split(/[ \t]+/)
    const marker = parts[0].startsWith('@') ? parts.shift() : null
    if (marker && marker !== '@cert-authority' && marker !== '@revoked') return null
    const [hosts, type, key] = parts
    if (!hosts || !type || !key) return null
    if (!KH_HOSTS.test(hosts) || hosts.startsWith('-') || !KEY_TYPES.has(type) || !KH_KEY.test(key))
      return null
    out.push([marker, hosts, type, key].filter(Boolean).join(' '))
  }
  if (!out.length || out.length > 50) return null
  return out.join('\n')
}

function optText(v: unknown, max: number): string | null | undefined {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  if (t.length > max) return undefined
  return t || null
}

export function validateTargetInput(
  body: Record<string, unknown>,
  existing?: HubTargetRow
): Validation<TargetFields> {
  const kind = body.kind ?? existing?.kind
  if (kind !== 'gitlab') return fail('BAD_KIND', 'Target kind must be gitlab.')

  const name = body.name !== undefined ? body.name : existing?.name
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 200)
    return fail('BAD_NAME', 'A target needs a name (at most 200 characters).')

  const incoming = body.config ?? {}
  if (typeof incoming !== 'object' || incoming === null || Array.isArray(incoming)) {
    return fail('BAD_CONFIG', 'Target config must be an object.')
  }
  const inc = incoming as Record<string, unknown>
  for (const k of Object.keys(inc)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(k)) {
      return fail('BAD_CONFIG', `Unknown config key: ${k}.`)
    }
  }
  const prev = (existing?.config ?? {}) as Partial<Record<string, unknown>>
  const pick = (k: (typeof CONFIG_KEYS)[number]) => (k in inc ? inc[k] : prev[k])

  const required: Record<string, string> = {}
  for (const k of [
    'api',
    'namespace',
    'template_project',
    'template_ref',
    'deploy_host'
  ] as const) {
    const v = pick(k)
    if (typeof v !== 'string' || !v.trim()) return fail('BAD_CONFIG', `Config ${k} is required.`)
    required[k] = v.trim()
  }
  if (!validApiUrl(required.api)) {
    return fail('BAD_CONFIG', 'Config api must be an https URL (http only for localhost).')
  }
  if (!GITLAB_PATH.test(required.namespace) || required.namespace.length > 255)
    return fail('BAD_CONFIG', 'Config namespace must be a GitLab group or user path.')
  if (!GITLAB_PATH.test(required.template_project) || required.template_project.length > 255)
    return fail('BAD_CONFIG', 'Config template_project must be a GitLab project path or id.')
  if (!DEPLOY_HOST.test(required.deploy_host) || required.deploy_host.length > 253)
    return fail('BAD_CONFIG', 'Config deploy_host must be host, user@host or host:port.')
  if (!validTemplateRef(required.template_ref))
    return fail(
      'BAD_CONFIG',
      'Config template_ref must be a tag or commit sha of the template (never a branch like main).'
    )
  const knownHosts = parseKnownHosts(pick('manager_known_hosts'))
  if (!knownHosts)
    return fail(
      'BAD_CONFIG',
      "Config manager_known_hosts must be the manager's ssh known_hosts lines (ssh-keyscan <host>)."
    )

  const withDefault = (k: keyof typeof DEFAULTS): unknown => {
    const v = pick(k)
    return v === undefined || v === null || v === '' ? DEFAULTS[k] : v
  }
  const pinFile = withDefault('pin_file')
  if (
    typeof pinFile !== 'string' ||
    pinFile.startsWith('/') ||
    pinFile.split('/').some((seg) => !seg || seg === '.' || seg === '..') ||
    pinFile.length > 255
  )
    return fail('BAD_CONFIG', 'Config pin_file must be a path inside the repository.')
  const deployJob = withDefault('deploy_job')
  if (typeof deployJob !== 'string' || !deployJob.trim() || deployJob.length > 255)
    return fail('BAD_CONFIG', 'Config deploy_job must be a job name.')
  const proxyNetwork = withDefault('proxy_network')
  if (typeof proxyNetwork !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(proxyNetwork))
    return fail('BAD_CONFIG', 'Config proxy_network must be a Docker network name.')

  const dnsMode = pick('dns_mode')
  if (dnsMode !== 'automatic' && dnsMode !== 'manual')
    return fail('BAD_CONFIG', 'Config dns_mode must be automatic or manual.')
  const scheme = withDefault('scheme')
  if (scheme !== 'https' && scheme !== 'http')
    return fail('BAD_CONFIG', 'Config scheme must be https or http.')

  const portRaw = pick('port')
  let port: number | null = null
  if (portRaw !== undefined && portRaw !== null && portRaw !== '') {
    if (typeof portRaw !== 'number' || !Number.isInteger(portRaw) || portRaw < 1 || portRaw > 65535)
      return fail('BAD_CONFIG', 'Config port must be a whole number from 1 to 65535.')
    port = portRaw
  }
  const edge = optText(pick('edge_address'), 253)
  if (edge === undefined) return fail('BAD_CONFIG', 'Config edge_address must be short text.')
  const certNote = optText(pick('cert_note'), 1000)
  if (certNote === undefined) return fail('BAD_CONFIG', 'Config cert_note must be short text.')

  const wildRaw = pick('wildcard_domain')
  let wildcard: string | null = null
  if (wildRaw !== undefined && wildRaw !== null && wildRaw !== '') {
    wildcard = typeof wildRaw === 'string' ? dnsSuffix(wildRaw) : null
    if (!wildcard)
      return fail('BAD_WILDCARD', 'The wildcard domain must be a DNS name like apps.example.com.')
  }
  if (dnsMode === 'automatic' && !wildcard)
    return fail('BAD_WILDCARD', 'Automatic names need a wildcard domain like apps.example.com.')
  if (scheme === 'http' && !httpAllowed(wildcard))
    return fail(
      'BAD_SCHEME',
      'Plain http is only allowed when the wildcard domain is localhost or ends in .test.'
    )

  if (body.secret !== undefined && body.secret !== null && typeof body.secret !== 'string') {
    return fail('BAD_SECRET', 'The token must be text.')
  }
  const stored = existing?.secret ?? null
  // Absent = keep on update (nextSecret reads undefined as clear).
  const secret = body.secret === undefined && existing ? stored : nextSecret(body.secret, stored)
  if (
    existing &&
    stored &&
    secret === stored &&
    (originOf(required.api) !== originOf(existing.config.api) ||
      required.namespace !== existing.config.namespace)
  ) {
    return fail(
      'SECRET_REQUIRED',
      'Enter the token again when the GitLab address or namespace changes'
    )
  }

  const config: HubTargetConfig = {
    api: required.api,
    namespace: required.namespace,
    template_project: required.template_project,
    template_ref: required.template_ref,
    pin_file: pinFile,
    deploy_job: deployJob.trim(),
    deploy_host: required.deploy_host,
    manager_known_hosts: knownHosts,
    proxy_network: proxyNetwork,
    dns_mode: dnsMode,
    wildcard_domain: wildcard,
    edge_address: edge,
    scheme,
    port,
    cert_note: certNote
  }
  return { ok: true, row: { kind: 'gitlab', name: name.trim(), config, secret } }
}

export function publicTarget(row: HubTargetRow): HubTarget {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    config: row.config,
    secret: maskSecret(row.secret)
  }
}

export class TargetMisconfiguredError extends Error {
  code = 'TARGET_MISCONFIGURED'
  constructor(message: string) {
    super(message)
    this.name = 'TargetMisconfiguredError'
  }
}

/**
 * GitCtx for the GitLab clients: `base` is the host (the client adds /api/v4), `project` the
 * given one (default: the template). Opens the sealed token (HubSecretError when unreadable).
 */
export function targetCtx(row: HubTargetRow, project?: string): GitCtx {
  if (!row.config || typeof row.config.api !== 'string' || !row.config.api.trim()) {
    throw new TargetMisconfiguredError('The target has no GitLab address configured.')
  }
  const base = row.config.api.replace(/\/+$/, '').replace(/\/api\/v4$/, '')
  return {
    provider: 'gitlab',
    base,
    project: project ?? row.config.template_project,
    token: openSecret(row.secret),
    ref: null
  }
}

function parseConfig(raw: unknown): HubTargetConfig {
  let v: unknown = raw
  if (typeof raw === 'string') {
    try {
      v = raw ? JSON.parse(raw) : {}
    } catch {
      v = {}
    }
  }
  return (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as HubTargetConfig
}

function toRow(r: Record<string, unknown>): HubTargetRow {
  return {
    id: Number(r.id),
    kind: r.kind as 'gitlab',
    name: String(r.name),
    config: parseConfig(r.config),
    secret: (r.secret as string | null) ?? null
  }
}

const now = () => new Date()

export async function listTargets(): Promise<HubTargetRow[]> {
  const rows = (await db('nivaro_hub_targets').select('*').orderBy('id')) as Record<
    string,
    unknown
  >[]
  return rows.map(toRow)
}

export async function getTargetRow(id: number): Promise<HubTargetRow | null> {
  const r = (await db('nivaro_hub_targets').where({ id }).first()) as
    | Record<string, unknown>
    | undefined
  return r ? toRow(r) : null
}

export async function createTarget(row: TargetFields): Promise<HubTargetRow> {
  const id = await insertReturningId(db, 'nivaro_hub_targets', {
    kind: row.kind,
    name: row.name,
    config: JSON.stringify(row.config),
    secret: row.secret,
    created_at: now(),
    updated_at: now()
  })
  return { id: Number(id), ...row }
}

export async function updateTarget(id: number, patch: TargetFields): Promise<HubTargetRow | null> {
  const n = await db('nivaro_hub_targets')
    .where({ id })
    .update({
      kind: patch.kind,
      name: patch.name,
      config: JSON.stringify(patch.config),
      secret: patch.secret,
      updated_at: now()
    })
  if (!n) return null
  return { id, ...patch }
}

/** Deletes a target; IN_USE while an app names it (apps.target_id). */
export async function deleteTarget(
  id: number
): Promise<{ ok: true } | { ok: false; code: 'IN_USE' | 'NOT_FOUND' }> {
  return db.transaction(async (trx) => {
    if (!(await trx('nivaro_hub_targets').where({ id }).first('id')))
      return { ok: false, code: 'NOT_FOUND' as const }
    if (await trx('nivaro_hub_apps').where({ target_id: id }).first('id'))
      return { ok: false, code: 'IN_USE' as const }
    await trx('nivaro_hub_targets').where({ id }).del()
    return { ok: true as const }
  })
}

/** Plain text for a failed GitLab check: the code's meaning, never GitLab's answer. */
function why(err: unknown): string {
  if (err instanceof HubSecretError) return 'The saved token cannot be read (check ENCRYPTION_KEY)'
  if (err instanceof GitlabWriteError) {
    switch (err.code) {
      case 'GITLAB_NO_TOKEN':
        return 'No token saved'
      case 'GITLAB_UNAUTHORIZED':
        return 'GitLab refused the token (wrong, expired or revoked)'
      case 'GITLAB_FORBIDDEN':
        return 'GitLab refused: the token lacks the api scope or the role'
      case 'FETCH_REDIRECT':
        return 'GitLab redirected the call (check the address); refused'
      case 'GITLAB_UNREACHABLE':
        return 'GitLab did not answer'
      default:
        return `GitLab refused the call${err.status ? ` (${err.status})` : ''}`
    }
  }
  return 'The check failed'
}

/**
 * The target's Test button: does the token work, does the namespace exist, can the token see
 * the template? Read-only; each check says what failed. A failed token skips the other two.
 */
export async function testTarget(id: number): Promise<{ ok: boolean; checks: TargetCheck[] }> {
  const row = await getTargetRow(id)
  if (!row) {
    return { ok: false, checks: [{ id: 'token', ok: false, text: 'Target not found' }] }
  }
  const checks: TargetCheck[] = []
  let ctx: GitCtx
  try {
    ctx = targetCtx(row)
  } catch (err) {
    const text =
      err instanceof TargetMisconfiguredError ? 'The target has no GitLab address' : why(err)
    return {
      ok: false,
      checks: [
        { id: 'token', ok: false, text },
        { id: 'namespace', ok: false, text: 'Skipped: the token does not work' },
        { id: 'template', ok: false, text: 'Skipped: the token does not work' }
      ]
    }
  }

  let me: { id: number; username: string }
  try {
    me = await currentUser(ctx)
    checks.push({ id: 'token', ok: true, text: `Token works (signed in as ${me.username})` })
  } catch (err) {
    checks.push({ id: 'token', ok: false, text: why(err) })
    checks.push({ id: 'namespace', ok: false, text: 'Skipped: the token does not work' })
    checks.push({ id: 'template', ok: false, text: 'Skipped: the token does not work' })
    return { ok: false, checks }
  }

  const { namespace, template_project: template } = row.config
  try {
    const ns = await namespaceExists(ctx, namespace)
    if (!ns) {
      checks.push({
        id: 'namespace',
        ok: false,
        text: `Namespace ${namespace} not found (or the token cannot see it)`
      })
    } else if (ns.kind === 'user') {
      checks.push(
        ns.full_path === me.username
          ? { id: 'namespace', ok: true, text: `Namespace ${namespace} is the token user's own` }
          : {
              id: 'namespace',
              ok: false,
              text: `Namespace ${namespace} belongs to another user; new projects cannot go there`
            }
      )
    } else {
      const level = await groupAccessLevel(ctx, ns.full_path, me.id)
      checks.push(
        level != null && level >= MAINTAINER
          ? {
              id: 'namespace',
              ok: true,
              text: `Namespace ${namespace} found (Maintainer or above)`
            }
          : {
              id: 'namespace',
              ok: false,
              text: `Namespace ${namespace} found, but the token user is not a Maintainer there`
            }
      )
    }
  } catch (err) {
    checks.push({ id: 'namespace', ok: false, text: `Namespace ${namespace}: ${why(err)}` })
  }

  try {
    const p = await projectExists(ctx, template)
    checks.push(
      p
        ? { id: 'template', ok: true, text: `Template ${p.path_with_namespace || template} found` }
        : {
            id: 'template',
            ok: false,
            text: `Template project ${template} not found (or the token cannot see it)`
          }
    )
  } catch (err) {
    checks.push({ id: 'template', ok: false, text: `Template ${template}: ${why(err)}` })
  }

  return { ok: checks.every((c) => c.ok), checks }
}
