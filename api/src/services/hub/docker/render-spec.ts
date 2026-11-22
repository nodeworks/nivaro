import type { HubApp } from '../apps.js'
import type { HubEnvironmentRow } from '../promote-types.js'
import type { StackSpec } from './agent-types.js'
import type { DockerDriverConfig } from './driver-config.js'
import { databaseEnvFor } from './stack-env.js'
import type { StackSettingsRow } from './stack-settings.js'
import { templateFor } from './templates.js'

/**
 * The Hub-side StackSpec renderer (Hub phase 4): one environment's stored settings + the version
 * being deployed → the exact spec PUT to the Hub agent. Pure: the caller opens the secrets and the
 * hub token inside the call that sends the spec, and the answer is never logged or stored (it
 * carries those secrets in plain text).
 */

export interface RenderStackInput {
  app: HubApp
  env: HubEnvironmentRow
  driver: DockerDriverConfig
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
}

const NIVARO_ENVIRONMENTS = ['production', 'staging', 'development', 'test']

const noTrailingSlash = (url: string) => url.replace(/\/+$/, '')

/** base_url's host first, then the environment's own names; lower-case, each once. */
function stackHostnames(env: HubEnvironmentRow): string[] {
  const out: string[] = []
  const add = (h: string) => {
    const name = h.trim().toLowerCase()
    if (name && !out.includes(name)) out.push(name)
  }
  try {
    add(new URL(env.base_url).hostname)
  } catch {
    // a stored base_url is always an origin (baseUrlCheck); nothing to add otherwise
  }
  for (const h of env.hostnames) add(h)
  return out
}

export function renderStackSpec(input: RenderStackInput): StackSpec {
  const { env: environment, row } = input
  const roles = structuredClone(templateFor(input.version).sizes[row.size])
  const base = noTrailingSlash(environment.base_url)

  const env: Record<string, string> = {
    ...row.settings,
    ...databaseEnvFor(environment, row.settings)
  }
  if (!env.TRUST_PROXY) env.TRUST_PROXY = '1'
  env.PUBLIC_URL = base
  env.ADMIN_URL = base
  env.NIVARO_ENVIRONMENT = NIVARO_ENVIRONMENTS.includes(environment.key) ? environment.key : 'other'
  env.MIGRATION_SAFE_MODE = 'true'
  env.NODE_ENV = 'production'
  if (input.hubPublicUrl) env.HUB_URL = noTrailingSlash(input.hubPublicUrl)

  const spec: StackSpec = {
    owner: { app: input.app.key },
    environment: environment.key,
    image: input.image,
    roles,
    env,
    secrets: { ...input.secrets, HUB_TOKEN: input.hubToken },
    hostnames: stackHostnames(environment),
    redis: row.redis,
    extensions: { ...input.extensions }
  }
  if (row.publish_port != null) spec.publish_port = row.publish_port
  return spec
}

/**
 * Names a driver's DNS mode cannot serve: with automatic DNS every name must sit under the
 * wildcard domain (`x.<wildcard_domain>`); manual DNS takes any name (someone points it at the
 * edge). One readable line per problem.
 */
export function hostnameProblems(hostnames: string[], driver: DockerDriverConfig): string[] {
  if (driver.dns_mode !== 'automatic' || !driver.wildcard_domain) return []
  const suffix = `.${driver.wildcard_domain.toLowerCase()}`
  const out: string[] = []
  for (const h of hostnames) {
    const name = h.trim().toLowerCase()
    if (name.length <= suffix.length || !name.endsWith(suffix)) {
      out.push(
        `${name} is not under ${driver.wildcard_domain}: automatic DNS only serves names ending in ${suffix}`
      )
    }
  }
  return out
}
