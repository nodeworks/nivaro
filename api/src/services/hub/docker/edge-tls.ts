import { createPrivateKey, X509Certificate } from 'node:crypto'
import { agentVersionAtLeast } from './templates.js'

/**
 * Edge TLS (Hub gap G-D, agent 0.2.5): a stack's own certificate, served by Traefik.
 *
 * An ACME certificate (acme.certificate) binds its `fullchain` and `private_key` outputs to the
 * stack secrets EDGE_TLS_CERT and EDGE_TLS_KEY (Create app does it for its ACME part; anyone can
 * bind them on the resource's Outputs card). The renderer never sends those two as app secrets:
 * it takes them out of `secrets` and sends them as the spec's `edge_tls`, which the agent writes
 * to the stack's file in Traefik's file-provider folder (HUB_AGENT_TRAEFIK_DYNAMIC_DIR). The app
 * containers never see the key.
 *
 * A renewal (a new chain + key) is the binding push of the new outputs: the stack shows it needs
 * Apply now, and the apply rewrites only that file and the stack hash on the service labels — no
 * task restarts (agent edge-tls.ts).
 *
 * The checks here are the Hub's twin of the agent's (packages/hub-agent/src/edge-tls.ts
 * checkEdgeTls), so a plan says why before an apply is refused.
 */

/** The stack secrets an ACME certificate's outputs bind to. Never app settings, never env. */
export const EDGE_TLS_CERT_KEY = 'EDGE_TLS_CERT'
export const EDGE_TLS_KEY_KEY = 'EDGE_TLS_KEY'
export const EDGE_TLS_SECRET_KEYS: readonly string[] = [EDGE_TLS_CERT_KEY, EDGE_TLS_KEY_KEY]

/** The first agent that takes `edge_tls`. */
export const EDGE_TLS_AGENT_MIN_VERSION = '0.2.5'

export const isEdgeTlsKey = (k: string): boolean => EDGE_TLS_SECRET_KEYS.includes(k)

/**
 * The only writer of the two keys: a Hub-managed ACME certificate of the SAME app and
 * environment, its `fullchain` into EDGE_TLS_CERT and its `private_key` into EDGE_TLS_KEY, as stack
 * secrets. A person never types them (stack-settings.ts EDGE_TLS_BINDING_ONLY), and no other
 * resource type may bind them: whoever writes them decides which names Traefik answers for.
 */
export const EDGE_TLS_RESOURCE_TYPE = 'acme.certificate'
export const EDGE_TLS_OUTPUT_FOR: Readonly<Record<string, string>> = Object.freeze({
  [EDGE_TLS_CERT_KEY]: 'fullchain',
  [EDGE_TLS_KEY_KEY]: 'private_key'
})

/** Why this binding may not write an EDGE_TLS_* key (null = it may, or it is another key). */
export function edgeTlsBindingProblem(
  row: {
    type: string
    scope: string
    app_id: number | null
    environment_id: number | null
    deleted_at?: string | null
  },
  b: { output_key: string; environment_id: number; target: string; target_key: string },
  envAppId: number | null
): string | null {
  if (!isEdgeTlsKey(b.target_key)) return null
  const why = `${b.target_key} is the stack certificate: only the ${EDGE_TLS_OUTPUT_FOR[b.target_key]} output of an ACME certificate (acme.certificate) of this same app and environment may write it, as a stack secret.`
  if (row.deleted_at) return why
  if (row.type !== EDGE_TLS_RESOURCE_TYPE || row.scope !== 'app') return why
  if (b.target !== 'stack_secret') return why
  if (EDGE_TLS_OUTPUT_FOR[b.target_key] !== b.output_key) return why
  if (row.app_id == null || envAppId == null || row.app_id !== envAppId) return why
  if (row.environment_id != null && row.environment_id !== b.environment_id) return why
  return null
}

export type EdgeTlsProblemCode =
  | 'EDGE_TLS_INCOMPLETE'
  | 'EDGE_TLS_INVALID'
  | 'EDGE_TLS_KEY_MISMATCH'
  | 'EDGE_TLS_NAME_NOT_COVERED'
  | 'EDGE_TLS_NAME_OUTSIDE_STACK'
  | 'EDGE_TLS_NEEDS_TRAEFIK'
  | 'EDGE_TLS_NOT_CONFIGURED'
  | 'AGENT_TOO_OLD'

export interface EdgeTlsProblem {
  code: EdgeTlsProblemCode
  message: string
}

/** A DNS name as Traefik's store compares it: case-insensitive, a trailing dot the same name. */
export const normName = (n: string): string => n.toLowerCase().replace(/\.$/, '')

const SAN_DNS_RE = /^[A-Za-z0-9*_-]+(?:\.[A-Za-z0-9*_-]+)*\.?$/

/**
 * The names a leaf answers for: its DNS SANs, else its CN. null = a SAN that is not a plain DNS
 * name (IP address, URI, email, a value Node quoted). Twin of the agent's edge-tls.ts leafNames.
 */
export function leafNames(leaf: X509Certificate): string[] | null {
  const san = leaf.subjectAltName
  if (san !== undefined && san !== '') {
    const out: string[] = []
    for (const part of san.split(', ')) {
      if (!part.startsWith('DNS:')) return null
      const name = part.slice(4)
      if (!SAN_DNS_RE.test(name)) return null
      out.push(normName(name))
    }
    return out
  }
  const cns = (leaf.subject ?? '')
    .split('\n')
    .filter((l) => l.startsWith('CN='))
    .map((l) => l.slice(3))
  if (cns.some((n) => !SAN_DNS_RE.test(n))) return null
  return cns.map(normName)
}

/** What the agent says about itself (GET /v1/health), as far as edge TLS goes. */
export interface EdgeTlsAgentFacts {
  agent_version?: string | null
  edge?: 'traefik' | 'publish'
  edge_tls?: boolean
}

/**
 * Why this agent cannot serve a stack certificate, or null: the publish edge has no Traefik, an
 * agent before 0.2.5 does not take the field, and one without HUB_AGENT_TRAEFIK_DYNAMIC_DIR
 * refuses it (TLS_NOT_CONFIGURED). Unknown health = cannot tell = refused (fail closed).
 */
export function edgeTlsAgentProblem(
  health: EdgeTlsAgentFacts | null | undefined
): EdgeTlsProblem | null {
  if (health?.edge === 'publish')
    return {
      code: 'EDGE_TLS_NEEDS_TRAEFIK',
      message:
        'This agent publishes ports and runs no Traefik: a stack certificate needs the traefik edge.'
    }
  if (!agentVersionAtLeast(health?.agent_version, EDGE_TLS_AGENT_MIN_VERSION))
    return {
      code: 'AGENT_TOO_OLD',
      message: `A stack certificate (EDGE_TLS_CERT / EDGE_TLS_KEY) needs Hub agent ${EDGE_TLS_AGENT_MIN_VERSION} or later.`
    }
  if (health?.edge_tls !== true)
    return {
      code: 'EDGE_TLS_NOT_CONFIGURED',
      message:
        'The Hub agent has no HUB_AGENT_TRAEFIK_DYNAMIC_DIR (the folder Traefik’s file provider watches), so it cannot serve a stack certificate. Set it on the agent, or unbind EDGE_TLS_CERT / EDGE_TLS_KEY.'
    }
  return null
}

/**
 * The bound certificate checked against the names the stack routes: one key for the leaf, every
 * name covered (a wildcard covers one label). Messages name hosts, never PEM text.
 */
export function edgeTlsCertProblem(
  cert: string,
  key: string,
  hostnames: readonly string[]
): EdgeTlsProblem | null {
  let leaf: X509Certificate
  let keyObject: ReturnType<typeof createPrivateKey>
  try {
    leaf = new X509Certificate(cert)
    keyObject = createPrivateKey(key)
  } catch {
    return {
      code: 'EDGE_TLS_INVALID',
      message:
        'EDGE_TLS_CERT / EDGE_TLS_KEY are not a PEM certificate chain and an unencrypted private key.'
    }
  }
  if (!leaf.checkPrivateKey(keyObject))
    return {
      code: 'EDGE_TLS_KEY_MISMATCH',
      message: 'EDGE_TLS_KEY is not the private key of the certificate in EDGE_TLS_CERT.'
    }
  const missing = hostnames.filter((h) => leaf.checkHost(normName(h)) === undefined)
  if (missing.length)
    return {
      code: 'EDGE_TLS_NAME_NOT_COVERED',
      message: `The stack certificate does not cover ${missing.join(', ')}: reissue it with ${missing.length > 1 ? 'those names' : 'that name'}, or remove ${missing.length > 1 ? 'them' : 'it'} from the environment.`
    }
  // Security review 2026-11-27, twin of the agent's rule: Traefik's file-provider store is one
  // store for every router and picks by SNI, so every name the leaf answers for must be one of
  // this environment's own names — no other host, no wildcard over others, no IP or other SANs.
  const own = new Set(hostnames.map(normName))
  const names = leafNames(leaf)
  if (names === null || names.length === 0 || names.some((n) => !own.has(n)))
    return {
      code: 'EDGE_TLS_NAME_OUTSIDE_STACK',
      message:
        names === null
          ? 'The stack certificate carries an address or another kind of name besides DNS names: Traefik would serve it for more than this environment. Reissue it for the environment’s names only.'
          : `The stack certificate also names ${names.filter((n) => !own.has(n)).join(', ') || 'nothing of this environment'}: Traefik serves one certificate store for every stack, so it would answer for names that are not this environment’s. Reissue it for exactly the environment’s names.`
    }
  return null
}
