import type { HubApp } from '../apps.js'
import type { HubEnvironmentRow } from '../promote-types.js'
import type { StackSpec } from './agent-types.js'
import type { DockerDriverConfig } from './driver-config.js'
import { type DatabaseRecordEnv, databaseEnvFor, databaseKey } from './stack-env.js'
import type { StackSettingsRow } from './stack-settings.js'
import { stackRoles } from './templates.js'

/**
 * The Hub-side StackSpec renderer (Hub phase 4): one environment's stored settings + the version
 * being deployed → the exact spec PUT to the Hub agent. Pure: the caller opens the secrets and the
 * hub token inside the call that sends the spec, and the answer is never logged or stored (it
 * carries those secrets in plain text).
 *
 * The renderer never emits a spec the agent would refuse for its own shape: where the stored
 * settings cannot make one (a hostname the agent cannot route, too many names, a publish edge with
 * no port, a key that is both env and secret) it throws StackRenderError with a code instead.
 * hub-render-agent.test.ts runs the agent's own validator over its output.
 */

export type StackEdge = 'traefik' | 'publish'

export interface RenderStackInput {
  app: HubApp
  env: HubEnvironmentRow
  driver: DockerDriverConfig
  /** The agent's edge mode (GET /v1/health `edge`). */
  edge: StackEdge
  row: StackSettingsRow
  /** The opened settings secrets (openStackSecrets). */
  secrets: Record<string, string>
  /** The environment's opened hub token. */
  hubToken: string
  version: string
  /** <repo>@sha256:<64 hex> */
  image: string
  /** Extension id → <repo>@sha256:<64 hex>. */
  extensions: Record<string, string>
  /** The Hub's own origin (HUB_URL), when it has one. */
  hubPublicUrl: string | null
  /** The environment's phase 3 database record, opened by the run only (never by a plan). */
  database?: DatabaseRecordEnv | null
  /** The target agent's version (GET /v1/health `agent_version`); unknown = no exporter role. */
  agentVersion?: string | null
}

export type StackRenderCode =
  | 'HOSTNAME_INVALID'
  | 'TOO_MANY_HOSTNAMES'
  | 'PUBLISH_PORT_REQUIRED'
  | 'ENV_SECRET_CLASH'

export class StackRenderError extends Error {
  code: StackRenderCode
  constructor(code: StackRenderCode, message: string) {
    super(message)
    this.name = 'StackRenderError'
    this.code = code
  }
}

/** The agent's cap on hostnames per stack. */
export const MAX_STACK_HOSTNAMES = 10

const NIVARO_ENVIRONMENTS = ['production', 'staging', 'development', 'test']

const noTrailingSlash = (url: string) => url.replace(/\/+$/, '')

/** The agent's DNS-name rule (packages/hub-agent/src/spec.ts isDnsName): ≥ 2 labels, ≤ 253. */
const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
export function isAgentDnsName(h: string): boolean {
  if (h.length > 253) return false
  const labels = h.split('.')
  return labels.length >= 2 && labels.every((l) => DNS_LABEL_RE.test(l))
}

function baseHost(env: Pick<HubEnvironmentRow, 'base_url'>): string | null {
  try {
    return new URL(env.base_url).hostname.toLowerCase() || null
  } catch {
    return null
  }
}

function addName(out: string[], h: string | null) {
  const name = (h ?? '').trim().toLowerCase()
  if (name && !out.includes(name)) out.push(name)
}

/**
 * Every name an environment claims: its base_url host and its own hostnames, lower-case, each
 * once. Another environment may not route any of them (HOSTNAME_TAKEN).
 */
export function environmentNames(env: Pick<HubEnvironmentRow, 'base_url' | 'hostnames'>): string[] {
  const out: string[] = []
  addName(out, baseHost(env))
  for (const h of env.hostnames) addName(out, h)
  return out
}

/**
 * The names a stack asks the agent to route: with the traefik edge, base_url's host first then
 * the environment's own names; with the publish edge (ruling P4-14) the base host is left out —
 * hostnames only drive Traefik routing, and a published port has no name.
 */
export function stackHostnames(
  env: Pick<HubEnvironmentRow, 'base_url' | 'hostnames'>,
  edge: StackEdge = 'traefik'
): string[] {
  const out: string[] = []
  if (edge === 'traefik') addName(out, baseHost(env))
  for (const h of env.hostnames) addName(out, h)
  return out
}

export function renderStackSpec(input: RenderStackInput): StackSpec {
  const { env: environment, row, edge } = input
  const roles = stackRoles(input.version, row.size, input.agentVersion)
  const base = noTrailingSlash(environment.base_url)

  const hostnames = stackHostnames(environment, edge)
  const badName = hostnames.find((h) => !isAgentDnsName(h))
  if (badName !== undefined) {
    throw new StackRenderError(
      'HOSTNAME_INVALID',
      `${badName} is not a DNS name the agent can route (at least two labels: a–z, 0–9, -).`
    )
  }
  if (hostnames.length > MAX_STACK_HOSTNAMES) {
    throw new StackRenderError(
      'TOO_MANY_HOSTNAMES',
      `A stack routes at most ${MAX_STACK_HOSTNAMES} names (the base URL's host included).`
    )
  }
  if (edge === 'publish' && row.publish_port == null) {
    throw new StackRenderError(
      'PUBLISH_PORT_REQUIRED',
      'The agent publishes stacks on a port: set publish_port in the stack settings.'
    )
  }

  const database = databaseEnvFor(environment, row.settings, input.secrets, input.database ?? null)
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(row.settings)) if (!databaseKey(k)) env[k] = v
  Object.assign(env, database.env)
  if (env.TRUST_PROXY === undefined) env.TRUST_PROXY = '1'
  env.PUBLIC_URL = base
  env.ADMIN_URL = base
  env.NIVARO_ENVIRONMENT = NIVARO_ENVIRONMENTS.includes(environment.key) ? environment.key : 'other'
  env.MIGRATION_SAFE_MODE = 'true'
  env.NODE_ENV = 'production'
  if (input.hubPublicUrl) env.HUB_URL = noTrailingSlash(input.hubPublicUrl)

  const secrets: Record<string, string> = {}
  for (const [k, v] of Object.entries(input.secrets)) if (!databaseKey(k)) secrets[k] = v
  Object.assign(secrets, database.secrets)
  secrets.HUB_TOKEN = input.hubToken

  const clash = Object.keys(secrets).find((k) => Object.hasOwn(env, k))
  if (clash !== undefined) {
    throw new StackRenderError(
      'ENV_SECRET_CLASH',
      `${clash} is both an env value and a secret: remove the secret (the Hub sets ${clash}).`
    )
  }

  const spec: StackSpec = {
    owner: { app: input.app.key },
    environment: environment.key,
    image: input.image,
    roles,
    env,
    secrets,
    hostnames,
    redis: row.redis,
    extensions: { ...input.extensions }
  }
  // The agent takes a published port only on the publish edge.
  if (edge === 'publish' && row.publish_port != null) spec.publish_port = row.publish_port
  return spec
}

export type HostnameProblemCode =
  | 'HOSTNAME_INVALID'
  | 'HOSTNAME_NOT_UNDER_WILDCARD'
  | 'HOSTNAME_NOT_ALLOWED'
  | 'TOO_MANY_HOSTNAMES'
  | 'HOSTNAME_TAKEN'

export interface HostnameProblem {
  code: HostnameProblemCode
  /** null for a problem with the whole list (TOO_MANY_HOSTNAMES). */
  hostname: string | null
  message: string
}

export interface HostnameCheckOptions {
  /** Names every OTHER Hub environment claims (environmentNames of each). */
  taken?: Iterable<string>
  /** The agent's host_suffixes (GET /v1/health), traefik edge only. */
  hostSuffixes?: readonly string[]
  edge?: StackEdge
}

function underSuffix(h: string, suffix: string): boolean {
  const s = suffix.startsWith('.') ? suffix.toLowerCase() : `.${suffix.toLowerCase()}`
  return s.length > 1 && h.length > s.length && h.endsWith(s)
}

/**
 * Why a stack's names cannot be routed, with codes: the agent's DNS-name rule
 * (HOSTNAME_INVALID: `a_b.x`, trailing dots, one label), at most 10 names, automatic DNS only
 * under `.<wildcard_domain>`, the agent's host_suffixes on the traefik edge, and no name another
 * Hub environment already claims (HOSTNAME_TAKEN).
 */
export function hostnameRefusals(
  hostnames: string[],
  driver: DockerDriverConfig,
  opts: HostnameCheckOptions = {}
): HostnameProblem[] {
  const edge = opts.edge ?? 'traefik'
  const taken = new Set([...(opts.taken ?? [])].map((h) => h.trim().toLowerCase()))
  const out: HostnameProblem[] = []
  const names: string[] = []
  for (const h of hostnames) addName(names, h)
  if (names.length > MAX_STACK_HOSTNAMES) {
    out.push({
      code: 'TOO_MANY_HOSTNAMES',
      hostname: null,
      message: `A stack routes at most ${MAX_STACK_HOSTNAMES} names (the base URL's host included).`
    })
  }
  const wildcard =
    driver.dns_mode === 'automatic' && driver.wildcard_domain
      ? driver.wildcard_domain.toLowerCase()
      : null
  for (const name of names) {
    if (!isAgentDnsName(name)) {
      out.push({
        code: 'HOSTNAME_INVALID',
        hostname: name,
        message: `${name} is not a DNS name the agent can route (at least two labels: a–z, 0–9, -).`
      })
      continue
    }
    if (wildcard && !underSuffix(name, wildcard)) {
      out.push({
        code: 'HOSTNAME_NOT_UNDER_WILDCARD',
        hostname: name,
        message: `${name} is not under ${wildcard}: automatic DNS only serves names ending in .${wildcard}`
      })
    }
    if (
      edge === 'traefik' &&
      opts.hostSuffixes &&
      !opts.hostSuffixes.some((s) => underSuffix(name, s))
    ) {
      out.push({
        code: 'HOSTNAME_NOT_ALLOWED',
        hostname: name,
        message: `${name} is outside the agent's allowed domains (${opts.hostSuffixes.join(', ')}).`
      })
    }
    if (taken.has(name)) {
      out.push({
        code: 'HOSTNAME_TAKEN',
        hostname: name,
        message: `${name} already belongs to another Hub environment.`
      })
    }
  }
  return out
}

/** hostnameRefusals as readable lines (the planner's `hostnameProblems: string[]`). */
export function hostnameProblems(
  hostnames: string[],
  driver: DockerDriverConfig,
  opts: HostnameCheckOptions = {}
): string[] {
  return hostnameRefusals(hostnames, driver, opts).map((p) => p.message)
}
