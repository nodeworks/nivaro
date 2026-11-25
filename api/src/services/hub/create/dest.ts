// Where a created app goes when it is not a GitLab target (gap `create`, 0.3.215): a Docker
// driver (the Hub agent) or a shared deployment. Pure helpers shared by the planner, the runner
// and the creation view: how an environment is named there. No I/O.
import type { DockerDriverConfig } from '../docker/driver-config.js'
import { patternCovers } from '../shared/stack-render.js'
import type { SharedDeployment } from '../shared/store.js'
import { hostnameFor, type NamingConfig } from './app-config.js'
import { dnsSuffix, httpAllowed } from './dns.js'

type HostnameResult = ReturnType<typeof hostnameFor>

/** https, except for the names plain http is allowed on (localhost, .test). */
function schemeFor(suffixOrHost: string | null): 'http' | 'https' {
  return suffixOrHost && httpAllowed(suffixOrHost) ? 'http' : 'https'
}

/**
 * A Docker driver as a naming config: automatic DNS makes `<app>[--<env>].<wildcard>`, manual
 * DNS takes the name the person enters (and the ticket points at the driver's edge target). The
 * driver's edge_scheme / edge_port say how people reach its edge (an edge on :3280); unset =
 * https on 443, plain http on 80 for localhost / .test names.
 */
export function namingForDocker(c: DockerDriverConfig, host?: string | null): NamingConfig {
  const suffix = dnsSuffix(c?.wildcard_domain)
  return {
    dns_mode: c?.dns_mode === 'manual' ? 'manual' : 'automatic',
    wildcard_domain: suffix,
    scheme:
      c?.edge_scheme === 'https' || c?.edge_scheme === 'http'
        ? c.edge_scheme
        : schemeFor(host ?? suffix),
    port: typeof c?.edge_port === 'number' ? c.edge_port : null,
    edge_address: c?.edge_target ?? null,
    cert_note: null
  }
}

/** The name a host pattern (`*.apps.example.com`) makes names under, or null. */
export function patternBase(pattern: string | null | undefined): string | null {
  if (typeof pattern !== 'string' || !pattern.startsWith('*.')) return null
  return dnsSuffix(pattern.slice(2))
}

/**
 * A shared deployment as a naming config: with a host pattern every name is one label under it
 * (automatic: the deployment's router already routes it); without one the name is entered.
 */
export function namingForShared(s: SharedDeployment, host?: string | null): NamingConfig {
  const base = patternBase(s?.host_pattern)
  return {
    dns_mode: base ? 'automatic' : 'manual',
    wildcard_domain: base,
    scheme: schemeFor(host ?? base),
    port: null,
    edge_address: null,
    cert_note: null
  }
}

/**
 * An environment's hostname on a shared deployment. Automatic: one label under the pattern. A
 * name the person enters is taken as it is on a registered deployment (its operator routes it);
 * on a Docker deployment it must be under the pattern or a name its last run already routed —
 * placing never re-applies the stack (place.ts assertDockerReady, NAME_NOT_ROUTED).
 */
export function sharedHostname(
  s: SharedDeployment,
  routed: readonly string[],
  appKey: string,
  envKey: string,
  given?: string | null
): HostnameResult | { ok: false; code: 'NAME_NOT_ROUTED'; message: string } {
  const typed = typeof given === 'string' ? given.trim() : ''
  if (!typed) return hostnameFor(namingForShared(s), appKey, envKey, null)
  // Normalised with no suffix rule (the deployment's own rule follows).
  const free: NamingConfig = {
    dns_mode: 'manual',
    wildcard_domain: null,
    scheme: schemeFor(typed.toLowerCase()),
    port: null,
    edge_address: null,
    cert_note: null
  }
  const named = hostnameFor(free, appKey, envKey, typed)
  if (!named.ok) return named
  if (
    s.mode === 'docker' &&
    !patternCovers(s.host_pattern, named.hostname) &&
    !routed.includes(named.hostname)
  )
    return {
      ok: false,
      code: 'NAME_NOT_ROUTED',
      message: `${named.hostname} is not routed by ${s.key}: use a name under ${s.host_pattern ?? 'its host pattern'}, or leave the hostname empty.`
    }
  return named
}
