// Task 11a (Hub providers): creation targets of kind `github` — new apps get their repository on
// GitHub (from a template repository) through a GitHub provider connection, beside GitLab targets.
// The row lives in nivaro_hub_targets (kind `github`, `connection_id` → nivaro_hub_connections,
// migration 583); it holds no token of its own (the connection's credentials are the provider
// framework's, sealed there). GitLab code never sees these rows: targets.ts lists kind `gitlab` only.
//
// What a GitHub creation does is create/github-steps.ts.
import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import type { Validation } from '../drivers.js'
import { dnsSuffix, httpAllowed, route53ConfigProblem, zoneResourceIdOf } from './dns.js'

export interface HubGithubTargetConfig {
  /** `owner/repo` of the template repository new app repositories are created from. */
  template: string
  visibility: 'private' | 'internal'
  /** The workflow file (under .github/workflows) the template deploys an environment with. */
  deploy_workflow: string
  /** The branch environments deploy from (default main). */
  source_branch: string
  dns_mode: 'automatic' | 'manual' | 'route53' | 'cloudflare'
  dns_zone_resource_id?: number | null
  wildcard_domain: string | null
  edge_address: string | null
  scheme: 'https' | 'http'
  port: number | null
  cert_note: string | null
}

export interface HubGithubTargetRow {
  id: number
  kind: 'github'
  name: string
  connection_id: number
  config: HubGithubTargetConfig
}

export type GithubTargetFields = Omit<HubGithubTargetRow, 'id'>

const CONFIG_KEYS = [
  'template',
  'visibility',
  'deploy_workflow',
  'source_branch',
  'dns_mode',
  'dns_zone_resource_id',
  'wildcard_domain',
  'edge_address',
  'scheme',
  'port',
  'cert_note'
] as const

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/
const WORKFLOW_RE = /^[A-Za-z0-9._-]+\.ya?ml$/
const BRANCH_RE = /^(?!.*\.\.)(?!.*\/\/)(?!\/)(?!.*\/$)[A-Za-z0-9._/-]{1,200}$/

const fail = (code: string, message: string) => ({ ok: false as const, code, message })

function optText(v: unknown, max: number): string | null | undefined {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  if (t.length > max) return undefined
  return t || null
}

/** A GitHub target create / PATCH: every field checked; the connection must be a GitHub one. */
export async function validateGithubTargetInput(
  body: Record<string, unknown>,
  existing?: HubGithubTargetRow
): Promise<Validation<GithubTargetFields>> {
  const name = body.name !== undefined ? body.name : existing?.name
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 200)
    return fail('BAD_NAME', 'A target needs a name (at most 200 characters).')
  const connRaw = body.connection_id !== undefined ? body.connection_id : existing?.connection_id
  if (typeof connRaw !== 'number' || !Number.isSafeInteger(connRaw) || connRaw < 1)
    return fail('BAD_CONNECTION', 'Pick the GitHub connection new repositories are made through.')
  const conn = (await db('nivaro_hub_connections').where({ id: connRaw }).first('provider')) as
    | { provider: string }
    | undefined
  if (!conn || conn.provider !== 'github')
    return fail('BAD_CONNECTION', 'connection_id must name a GitHub connection.')

  const incoming = body.config ?? {}
  if (typeof incoming !== 'object' || incoming === null || Array.isArray(incoming))
    return fail('BAD_CONFIG', 'Target config must be an object.')
  const inc = incoming as Record<string, unknown>
  for (const k of Object.keys(inc))
    if (!(CONFIG_KEYS as readonly string[]).includes(k))
      return fail('BAD_CONFIG', `Unknown config key: ${k}.`)
  const pick = (k: (typeof CONFIG_KEYS)[number]): unknown =>
    inc[k] !== undefined ? inc[k] : existing?.config?.[k]

  const template = pick('template')
  if (typeof template !== 'string' || !REPO_RE.test(template))
    return fail('BAD_CONFIG', 'Config template must be owner/repo of a template repository.')
  const visibility = pick('visibility') ?? 'private'
  if (visibility !== 'private' && visibility !== 'internal')
    return fail('BAD_CONFIG', 'Config visibility must be private or internal.')
  const workflow = pick('deploy_workflow')
  if (typeof workflow !== 'string' || !WORKFLOW_RE.test(workflow))
    return fail(
      'BAD_CONFIG',
      'Config deploy_workflow must be a workflow file name like deploy.yml.'
    )
  const branchRaw = pick('source_branch') ?? 'main'
  if (typeof branchRaw !== 'string' || !BRANCH_RE.test(branchRaw))
    return fail('BAD_CONFIG', 'Config source_branch must be a branch name.')

  const dnsMode = pick('dns_mode')
  if (
    dnsMode !== 'automatic' &&
    dnsMode !== 'manual' &&
    dnsMode !== 'route53' &&
    dnsMode !== 'cloudflare'
  )
    return fail('BAD_CONFIG', 'Config dns_mode must be automatic, manual, route53 or cloudflare.')
  const scheme = pick('scheme') ?? 'https'
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
  if (dnsMode !== 'manual' && !wildcard)
    return fail('BAD_WILDCARD', 'Automatic names need a wildcard domain like apps.example.com.')
  if (scheme === 'http' && !httpAllowed(wildcard))
    return fail(
      'BAD_SCHEME',
      'Plain http is only allowed when the wildcard domain is localhost or ends in .test.'
    )
  const zoneId = zoneResourceIdOf(pick('dns_zone_resource_id'))
  if (zoneId === undefined)
    return fail(
      'BAD_CONFIG',
      'Config dns_zone_resource_id must name a managed Route 53 hosted zone.'
    )
  const r53 = route53ConfigProblem({
    dns_mode: dnsMode,
    dns_zone_resource_id: zoneId,
    wildcard_domain: wildcard,
    edge
  })
  if (r53) return fail('BAD_CONFIG', r53)

  return {
    ok: true,
    row: {
      kind: 'github',
      name: name.trim(),
      connection_id: connRaw,
      config: {
        template,
        visibility,
        deploy_workflow: workflow,
        source_branch: branchRaw,
        dns_mode: dnsMode,
        ...(dnsMode === 'route53' || dnsMode === 'cloudflare'
          ? { dns_zone_resource_id: zoneId }
          : {}),
        wildcard_domain: wildcard,
        edge_address: edge,
        scheme,
        port,
        cert_note: certNote
      }
    }
  }
}

function parseConfig(raw: unknown): HubGithubTargetConfig {
  let v: unknown = raw
  if (typeof raw === 'string') {
    try {
      v = raw ? JSON.parse(raw) : {}
    } catch {
      v = {}
    }
  }
  return (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as HubGithubTargetConfig
}

function toRow(r: Record<string, unknown>): HubGithubTargetRow {
  return {
    id: Number(r.id),
    kind: 'github',
    name: String(r.name),
    connection_id: Number(r.connection_id),
    config: parseConfig(r.config)
  }
}

export async function listGithubTargets(): Promise<HubGithubTargetRow[]> {
  try {
    const rows = (await db('nivaro_hub_targets')
      .where({ kind: 'github' })
      .select('*')
      .orderBy('id')) as Array<Record<string, unknown>>
    return rows.map(toRow)
  } catch {
    return []
  }
}

export async function getGithubTarget(id: number): Promise<HubGithubTargetRow | null> {
  if (!Number.isSafeInteger(id) || id < 1) return null
  const r = (await db('nivaro_hub_targets').where({ id, kind: 'github' }).first()) as
    | Record<string, unknown>
    | undefined
  return r ? toRow(r) : null
}

export async function createGithubTarget(f: GithubTargetFields): Promise<HubGithubTargetRow> {
  const at = new Date()
  const id = await insertReturningId(db, 'nivaro_hub_targets', {
    kind: 'github',
    name: f.name,
    connection_id: f.connection_id,
    config: JSON.stringify(f.config),
    secret: null,
    created_at: at,
    updated_at: at
  })
  return { id: Number(id), ...f }
}

export async function updateGithubTarget(
  id: number,
  f: GithubTargetFields
): Promise<HubGithubTargetRow | null> {
  const n = await db('nivaro_hub_targets')
    .where({ id, kind: 'github' })
    .update({
      name: f.name,
      connection_id: f.connection_id,
      config: JSON.stringify(f.config),
      updated_at: new Date()
    })
  return n ? { id, ...f } : null
}

/** The GitHub target's connection, checked for a creation (null = fine; else the refusal). */
export async function githubTargetProblem(t: HubGithubTargetRow): Promise<string | null> {
  const conn = (await db('nivaro_hub_connections')
    .where({ id: t.connection_id })
    .first('provider', 'status', 'name')) as
    | { provider: string; status: string; name: string }
    | undefined
  if (!conn || conn.provider !== 'github')
    return `${t.name} has no GitHub connection: pick one on the target.`
  if (conn.status === 'disabled') return `${t.name}'s connection ${conn.name} is disabled.`
  const c = t.config
  if (!c || typeof c.template !== 'string' || !REPO_RE.test(c.template))
    return `${t.name} has no template repository.`
  if (typeof c.deploy_workflow !== 'string' || !WORKFLOW_RE.test(c.deploy_workflow))
    return `${t.name} names no deploy workflow.`
  if (c.dns_mode !== 'manual' && !dnsSuffix(c.wildcard_domain))
    return `${t.name} makes names automatically but has no wildcard domain.`
  return null
}
