import { randomBytes } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { db } from '../../../db/index.js'
import { isBlockedAddress } from '../../../lib/ssrf.js'
import { plainHttpHost, transferSource } from '../../hub-transfer/pull.js'
import { listComponents } from '../components.js'
import { agentHealth, agentStack } from '../docker/agent-client.js'
import { isAgentDnsName } from '../docker/render-spec.js'
import { getDriver, getPlacement, type HubPlacementRow, STACK_NAME_RE } from '../drivers.js'
import { HubSecretError, openSecret } from '../secrets.js'
import { getShared, linkUrlOrigin } from '../shared/store.js'
import { type HubLinkClient, hubLinkClient, hubLinkOrigin } from './link-client.js'
import type { MovePlan, MoveTarget } from './plan-port.js'

/**
 * Nivaro Hub phase 6, Task 16, fix round 1 (ruling P6-19 C-2, P6-18 #1/#2): the addresses a move
 * talks to each DEDICATED side on, resolved and probed at start, before anything changes, and
 * recorded with the move (steps.addresses). A refusal here writes nothing.
 *
 * Source (a dedicated app; a shared source is reached over its deployment link):
 *   - an address that does not depend on the public name, so maintenance, the delta copy, retire
 *     and a rollback still reach the source after a person pointed the name at the target:
 *       GitLab   the API component's verify_url origin, when its host is not the public one;
 *       Docker   publish edge: http://<agent host>:<published port> (only to this machine or a
 *                .test / .localhost name: the hub token never goes over plain http elsewhere);
 *   - or, ONLY with automatic routing on a Docker traefik source, the public name: the Hub moves
 *     that name itself (route) and puts it back first on rollback, and every source call while
 *     the source has given its name up is refused (ops.ts), never sent to the target;
 *   - none → 409 SOURCE_UNREACHABLE. It must answer its hub link now (probed).
 * Target (a dedicated app before its route; never the public name, which reaches the source):
 *   Docker traefik  a per-move name `hub-move-e<env>-<random>.<first agent host suffix>`, which
 *                   must resolve now (wildcard DNS for that suffix); the stack is deployed on it;
 *   Docker publish  the agent host (port read once deployed), this machine or .test/.localhost;
 *   GitLab          the API component's verify_url origin when its host is not the public one,
 *                   which must resolve now;
 *   none → 409 TARGET_UNREACHABLE.
 * Files (the pull's own rule, hub-transfer/pull.ts): the source's transfer address must be one
 * the target's pull may fetch: a loopback / RFC 1918 literal, or a name that resolves only to
 * public addresses (else the target needs SSRF_ALLOW_HOSTS) → 409 LINK_URL_NOT_PULLABLE (a shared
 * source's link_url) or SOURCE_NOT_PULLABLE (a dedicated source).
 *
 * The hub token is only ever sent to the dedicated source's recorded address and the target's.
 */

export interface MoveAddresses {
  /** A dedicated source's hub-link origin; null for a shared source. */
  source_link_base: string | null
  /** The base is the public name: usable only while the source holds its name. */
  source_link_public: boolean
  /** Where the target pulls the files from (origin + /api/hub-transfer/files). */
  pull_source: string
  /** A dedicated target's pre-route origin (traefik per-move name, or GitLab verify origin). */
  target_link_base: string | null
  /** A Docker publish-edge target: the agent host (the port is read once deployed). */
  target_publish_host: string | null
  /** The per-move name a Docker traefik target is deployed on before its route. */
  target_temp_host: string | null
}

export class AddressError extends Error {
  code: string
  statusCode = 409
  constructor(code: string, message: string) {
    super(message)
    this.name = 'AddressError'
    this.code = code
  }
}

export interface AddressDeps {
  agent?: Partial<{ agentHealth: typeof agentHealth; agentStack: typeof agentStack }>
  link?: (baseUrl: string, token: string | null) => HubLinkClient
  /** Every address a name resolves to. */
  resolve?: (host: string) => Promise<string[]>
  nonce?: () => string
}

const defaultResolve = async (host: string) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address)

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/** A GitLab placement's API verify_url origin, when its host is not the public one. */
/** `host` on the scheme and port of the public address (https and the default port otherwise). */
function onPublicEntrypoint(host: string, publicBase: string): string {
  try {
    const u = new URL(publicBase.trim())
    if (u.protocol === 'https:' || u.protocol === 'http:')
      return `${u.protocol}//${host}${u.port ? `:${u.port}` : ''}`
  } catch {
    // not a URL: the default below
  }
  return `https://${host}`
}

async function verifyOrigin(placement: HubPlacementRow, publicHost: string | null) {
  const comps = await listComponents(placement.id).catch(() => [])
  const api = comps.find((c) => c.kind === 'api' && c.verify_url)
  const host = api?.verify_url ? hostOf(api.verify_url) : null
  if (!api?.verify_url || !host || host === publicHost) return null
  return originOf(api.verify_url)
}

/** Can the target's pull fetch `url`'s host (the pull's own rule)? */
async function pullable(url: string, resolve: (h: string) => Promise<string[]>): Promise<boolean> {
  const source = transferSource(`${url.replace(/\/+$/, '')}/api/hub-transfer/files`)
  if (!source) return false
  const host = new URL(source).hostname.replace(/^\[|\]$/g, '')
  if (plainHttpHost(host)) return true
  if (isIP(host)) return !isBlockedAddress(host)
  try {
    const all = await resolve(host)
    return all.length > 0 && all.every((a) => !isBlockedAddress(a))
  } catch {
    return false
  }
}

async function resolves(host: string, resolve: (h: string) => Promise<string[]>) {
  try {
    return (await resolve(host)).length > 0
  } catch {
    return false
  }
}

export interface AddressOptions {
  /**
   * Ruling P6-20 #2: the operator ticked the LINK_URL_NOT_PULLABLE override (the target lists
   * the link's host in SSRF_ALLOW_HOSTS). A wrong override fails at files_warm and rolls back.
   */
  allowUnpullable?: boolean
}

export async function resolveMoveAddresses(
  envId: number,
  to: MoveTarget,
  plan: Pick<MovePlan, 'routing'>,
  deps: AddressDeps = {},
  opts: AddressOptions = {}
): Promise<MoveAddresses> {
  const agent = { agentHealth, agentStack, ...deps.agent }
  const link = deps.link ?? ((b: string, t: string | null) => hubLinkClient(b, t))
  const resolve = deps.resolve ?? defaultResolve
  const nonce = deps.nonce ?? (() => randomBytes(4).toString('hex'))
  const env = (await db('nivaro_hub_environments')
    .where({ id: envId })
    .first('base_url', 'hub_token', 'placement_id')) as
    | { base_url: string; hub_token: string | null; placement_id: number | null }
    | undefined
  if (!env?.placement_id)
    throw new AddressError('NO_PLACEMENT', 'The environment has no placement.')
  const publicBase = originOf(String(env.base_url))
  const publicHost = hostOf(String(env.base_url))
  let token: string | null = null
  try {
    token = openSecret(env.hub_token)
  } catch (err) {
    if (!(err instanceof HubSecretError)) throw err
  }

  const out: MoveAddresses = {
    source_link_base: null,
    source_link_public: false,
    pull_source: '',
    target_link_base: null,
    target_publish_host: null,
    target_temp_host: null
  }

  // ── source ───────────────────────────────────────────────────────────────────────────────
  const from = await getPlacement(Number(env.placement_id))
  if (!from) throw new AddressError('NO_PLACEMENT', 'The environment has no placement.')
  const sourceUnreachable = (why: string) =>
    new AddressError(
      'SOURCE_UNREACHABLE',
      `The Hub has no address of its own for the source app (${why}), so it could not put the source in maintenance or roll back once the name points elsewhere.`
    )
  if (from.kind === 'shared') {
    const shared = await getShared(from.shared_deployment_id)
    const origin = shared ? linkUrlOrigin(shared.link_url) : null
    if (!origin)
      throw new AddressError(
        'LINK_URL_NOT_PULLABLE',
        "The source deployment's link address is unusable."
      )
    if (!opts.allowUnpullable && !(await pullable(origin, resolve)))
      throw new AddressError(
        'LINK_URL_NOT_PULLABLE',
        "The target cannot pull files from the source deployment's link address: its name resolves to a private address. Use a private IP literal for the link address, or list the name in the target's SSRF_ALLOW_HOSTS."
      )
    out.pull_source = origin
  } else {
    const driver = await getDriver(from.driver_id)
    let base: string | null = null
    if (driver?.kind === 'gitlab') {
      base = await verifyOrigin(from, publicHost)
      if (!base)
        throw sourceUnreachable('its API component has no check address apart from its public name')
    } else if (driver?.kind === 'docker') {
      const health = await agent.agentHealth(driver).catch(() => null)
      if (!health) throw sourceUnreachable('the Hub agent does not answer')
      if (health.edge === 'publish') {
        const stack = from.target.stack
        const st =
          typeof stack === 'string' && STACK_NAME_RE.test(stack)
            ? await agent.agentStack(driver, stack).catch(() => null)
            : null
        const host = hostOf(String(driver.config.agent_url ?? ''))
        const b = host && st?.published_port ? `http://${host}:${st.published_port}` : null
        base = b && hubLinkOrigin(b) ? b : null
        if (!base)
          throw sourceUnreachable('its published port is not on this machine or a .test name')
      } else if (plan.routing === 'automatic' && publicBase) {
        base = publicBase
        out.source_link_public = true
      } else throw sourceUnreachable('a manual route moves its only name')
    } else throw sourceUnreachable('its driver is gone')
    try {
      await link(base, token).status()
    } catch {
      throw sourceUnreachable(`it does not answer its hub link at ${base}`)
    }
    out.source_link_base = base
    if (!(await pullable(base, resolve)))
      throw new AddressError(
        'SOURCE_NOT_PULLABLE',
        `The target cannot pull files from ${base}: use an address that resolves publicly, or a private IP literal.`
      )
    out.pull_source = base
  }

  // ── target ───────────────────────────────────────────────────────────────────────────────
  if (to.kind === 'dedicated') {
    const placement = await getPlacement(to.placement_id)
    const targetUnreachable = (why: string) =>
      new AddressError(
        'TARGET_UNREACHABLE',
        `The Hub has no address to reach the target on before its route (${why}); it never talks to it through the public name, which reaches the source.`
      )
    if (!placement || placement.kind === 'shared') throw targetUnreachable('no dedicated placement')
    const driver = await getDriver(placement.driver_id)
    if (driver?.kind === 'gitlab') {
      const base = await verifyOrigin(placement, publicHost)
      const host = base ? hostOf(base) : null
      if (!base || !host)
        throw targetUnreachable('its API component has no check address apart from its public name')
      if (!isIP(host) && !(await resolves(host, resolve)))
        throw targetUnreachable(`${host} does not resolve`)
      out.target_link_base = base
    } else if (driver?.kind === 'docker') {
      const health = await agent.agentHealth(driver).catch(() => null)
      if (!health) throw targetUnreachable('the Hub agent does not answer')
      if (health.edge === 'publish') {
        const host = hostOf(String(driver.config.agent_url ?? ''))
        if (!host || !hubLinkOrigin(`http://${host}:1`))
          throw targetUnreachable('the agent host is not this machine or a .test name')
        out.target_publish_host = host
      } else {
        const suffix = health.host_suffixes?.[0]?.replace(/^\.+/, '').toLowerCase()
        const temp = suffix ? `hub-move-e${envId}-${nonce()}.${suffix}` : null
        if (!temp || !isAgentDnsName(temp))
          throw targetUnreachable('the agent names no host suffix')
        if (!(await resolves(temp, resolve)))
          throw targetUnreachable(
            `${temp} does not resolve (the per-move name needs wildcard DNS under ${suffix})`
          )
        out.target_temp_host = temp
        // E2E B3: the per-move name is served on the public name's edge entrypoint, so it keeps
        // the public address's scheme and port (an edge that is not on 443).
        out.target_link_base = onPublicEntrypoint(temp, String(env.base_url))
      }
    } else throw targetUnreachable('its driver is gone')
  }
  return out
}
