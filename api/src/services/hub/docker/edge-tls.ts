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

export type EdgeTlsProblemCode =
  | 'EDGE_TLS_INCOMPLETE'
  | 'EDGE_TLS_INVALID'
  | 'EDGE_TLS_KEY_MISMATCH'
  | 'EDGE_TLS_NAME_NOT_COVERED'
  | 'EDGE_TLS_NEEDS_TRAEFIK'
  | 'EDGE_TLS_NOT_CONFIGURED'
  | 'AGENT_TOO_OLD'

export interface EdgeTlsProblem {
  code: EdgeTlsProblemCode
  message: string
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
  const missing = hostnames.filter((h) => leaf.checkHost(h) === undefined)
  if (missing.length)
    return {
      code: 'EDGE_TLS_NAME_NOT_COVERED',
      message: `The stack certificate does not cover ${missing.join(', ')}: reissue it with ${missing.length > 1 ? 'those names' : 'that name'}, or remove ${missing.length > 1 ? 'them' : 'it'} from the environment.`
    }
  return null
}
