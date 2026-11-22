import { isIP } from 'node:net'
import { plainHttpAllowed } from '../../render-peer.js'
import type { DockerDriverRow, Validation } from '../drivers.js'
import { nextSecret } from '../secrets.js'

/**
 * Docker driver config (Hub phase 4): where the Hub agent listens and how stack names reach the
 * edge. The agent token is the driver's sealed `secret` column, never part of this config.
 */
export interface DockerDriverConfig {
  /** Origin of the Hub agent (https; plain http only where plainHttpAllowed() allows). */
  agent_url: string
  /** automatic = a wildcard DNS name already points at the edge; manual = someone adds each name. */
  dns_mode: 'automatic' | 'manual'
  /** automatic: every hostname ends with `.<wildcard_domain>`. */
  wildcard_domain: string | null
  /** manual: what a new name must point at (a DNS name or an address). */
  edge_target: string | null
}

export type DockerConfigCheck =
  | { ok: true; config: DockerDriverConfig }
  | { ok: false; code: 'BAD_CONFIG'; message: string }

const CONFIG_KEYS = ['agent_url', 'dns_mode', 'wildcard_domain', 'edge_target'] as const

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/** A lower-case DNS name of at least two labels (`apps.example.com`). */
export function isDnsName(v: string): boolean {
  if (v.length > 253) return false
  const labels = v.split('.')
  return labels.length >= 2 && labels.every((l) => LABEL.test(l)) && !/^\d+$/.test(labels.at(-1)!)
}

/**
 * The agent URL checked: an origin with no credentials, no path beyond `/`, no query or
 * fragment; https unless the host is one plainHttpAllowed() lets through (same rule as
 * RENDER_URL). Answers the origin (no trailing slash) or null.
 */
export function agentOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 500) return null
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return null
  }
  if (u.username || u.password) return null
  if (u.pathname !== '/' || u.search || u.hash) return null
  if (u.protocol === 'https:') return u.origin
  if (u.protocol === 'http:' && plainHttpAllowed(u.hostname)) return u.origin
  return null
}

const bad = (message: string): DockerConfigCheck => ({ ok: false, code: 'BAD_CONFIG', message })

/** null for an absent / null / blank value, the trimmed lower-case text otherwise. */
function optionalText(v: unknown): string | null | undefined {
  if (v === undefined || v === null) return null
  if (typeof v !== 'string') return undefined
  const t = v.trim().toLowerCase()
  return t ? t : null
}

/** The incoming config over the stored one (PATCH), every field checked. */
export function checkDockerConfig(
  incoming: Record<string, unknown>,
  stored?: DockerDriverConfig
): DockerConfigCheck {
  for (const k of Object.keys(incoming)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(k)) return bad(`Unknown config key: ${k}.`)
  }
  const pick = (k: (typeof CONFIG_KEYS)[number]): unknown =>
    incoming[k] !== undefined ? incoming[k] : stored?.[k]

  const rawUrl = pick('agent_url')
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) return bad('Config agent_url is required.')
  const origin = agentOrigin(rawUrl)
  if (!origin) {
    return bad(
      'Config agent_url must be an https origin with no credentials or path (http only for loopback, single-label or private addresses).'
    )
  }

  const mode = pick('dns_mode')
  if (mode !== 'automatic' && mode !== 'manual') {
    return bad('Config dns_mode must be automatic or manual.')
  }

  let wildcard = optionalText(pick('wildcard_domain'))
  if (wildcard === undefined) return bad('Config wildcard_domain must be a DNS name.')
  if (wildcard?.startsWith('*.')) wildcard = wildcard.slice(2)
  if (wildcard !== null && !isDnsName(wildcard)) {
    return bad('Config wildcard_domain must be a DNS name (like apps.example.com).')
  }

  const edge = optionalText(pick('edge_target'))
  if (edge === undefined) return bad('Config edge_target must be a DNS name or an address.')
  if (edge !== null && !isDnsName(edge) && !isIP(edge.replace(/^\[|]$/g, ''))) {
    return bad('Config edge_target must be a DNS name or an address.')
  }

  if (mode === 'automatic' && !wildcard) {
    return bad('Automatic DNS needs wildcard_domain (the domain every stack name ends with).')
  }
  if (mode === 'manual' && !edge) {
    return bad('Manual DNS needs edge_target (what each new name must point at).')
  }
  return {
    ok: true,
    config: { agent_url: origin, dns_mode: mode, wildcard_domain: wildcard, edge_target: edge }
  }
}

/** What a docker driver save stores (the secret is sealed). */
export type DockerDriverFields = {
  kind: 'docker'
  name: string
  config: DockerDriverConfig
  secret: string | null
}

/**
 * A docker driver create (no `existing`) or PATCH over a stored docker driver. The token
 * follows the GitLab rule: the mask keeps it, empty clears it, text seals it — and a kept token
 * is refused (SECRET_REQUIRED) when the agent's origin changes.
 */
export function validateDockerDriverInput(
  body: Record<string, unknown>,
  existing?: DockerDriverRow
): Validation<DockerDriverFields> {
  const name = body.name !== undefined ? body.name : existing?.name
  if (typeof name !== 'string' || !name.trim()) {
    return { ok: false, code: 'BAD_NAME', message: 'A driver needs a name.' }
  }
  const incoming = body.config ?? {}
  if (typeof incoming !== 'object' || incoming === null || Array.isArray(incoming)) {
    return { ok: false, code: 'BAD_CONFIG', message: 'Driver config must be an object.' }
  }
  const checked = checkDockerConfig(incoming as Record<string, unknown>, existing?.config)
  if (!checked.ok) return checked

  if (body.secret !== undefined && body.secret !== null && typeof body.secret !== 'string') {
    return { ok: false, code: 'BAD_SECRET', message: 'The token must be text.' }
  }
  const stored = existing?.secret ?? null
  const secret = body.secret === undefined && existing ? stored : nextSecret(body.secret, stored)
  if (
    existing &&
    stored &&
    secret === stored &&
    checked.config.agent_url !== agentOrigin(existing.config.agent_url)
  ) {
    return {
      ok: false,
      code: 'SECRET_REQUIRED',
      message: 'Enter the agent token again when the agent address changes'
    }
  }
  return { ok: true, row: { kind: 'docker', name: name.trim(), config: checked.config, secret } }
}
