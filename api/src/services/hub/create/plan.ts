// The creation planner (phase 3, Task 8): validates a whole Create app request against the facts
// the Hub gathered (gather.ts) and previews what the runner will make — per environment the
// hostname, base URL, DNS ticket, redirect URI, branches, stack name and the database (made by
// the Hub, requested from a DBA with a checklist, or an existing row). Pure: no I/O, no clock.
//
// The plan is answered to the browser as it is, so it carries NAMES ONLY: never the OIDC client
// secret, a token, a sealed value, a password or a CI variable value. Blocker texts quote only
// what the person typed for names (hostnames, keys, database names), cut short.
//
// Database and login names given for a manual or adopted database are checked here as DATA
// (isDbIdentifier, reserved names, the engine's login length): they never reach DDL from here,
// and gather.ts probes a name on a server only when it passed these same checks.

import { dbaChecklist } from '../db/checklist.js'
import type { HubDbEngine } from '../db/connection.js'
import { PROVISION_ENGINES } from '../db/connection.js'
import {
  defaultDatabaseName,
  defaultLoginName,
  isDbIdentifier,
  isReservedDbName,
  maxLoginLength
} from '../db/names.js'
import { isCollation, isUserHost } from '../db/provisioner.js'
import { type HubDbServerRow, publicServer } from '../db/servers.js'
import { hostnameRefusals } from '../docker/render-spec.js'
import { publishPortProblem } from '../docker/stack-gather.js'
import { StackTemplateError, stackRoles } from '../docker/templates.js'
import { DEFAULT_POOL_MAX, MAX_SHARED_POOL_MAX, MIN_SHARED_POOL_MAX } from '../drivers.js'
import {
  baseUrlFor,
  ciConfigPath,
  deployProjectVariables,
  hostnameFor,
  hubOwnHostnames,
  isCreatableKey,
  manualTicket,
  type NamingConfig,
  redirectUriFor,
  stackName
} from './app-config.js'
import { namingForDocker, namingForShared, sharedHostname } from './dest.js'
import { dnsSuffix, httpAllowed } from './dns.js'
import { type CreateProviderType, partLine, providerPartsOf } from './provider-parts.js'
import { type HubTargetRow, knownHostsCover, parseKnownHosts, validTemplateRef } from './targets.js'
import type {
  CreateAppInput,
  CreationBlocker,
  CreationFacts,
  CreationPlan,
  CreationPlanDatabase,
  CreationPlanEnvironment
} from './types.js'
import { creationKindOf, githubTargetIdOf, gitlabTargetIdOf } from './types.js'

/** At most this many environments per created app. */
export const MAX_CREATE_ENVIRONMENTS = 6

const VERSION_RE = /^\d+\.\d+\.\d+$/
// Twin of hub-link/first-admin.ts (the app refuses anything else, so refuse it before creating).
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/
const EMAIL_MAX = 255
const PERSON_NAME_MAX = 100
const APP_NAME_MAX = 200
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EXTENSION_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/
const GITLAB_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters
const CONTROL = /[\u0000-\u001f\u007f]/

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const cut = (v: string, n = 80) => (v.length > n ? `${v.slice(0, n)}…` : v)
const hostKey = (h: string) => h.trim().toLowerCase().replace(/\.$/, '')

function isPlainText(v: unknown, max: number): v is string {
  return typeof v === 'string' && !!v.trim() && v.trim().length <= max && !CONTROL.test(v)
}

// ── names ────────────────────────────────────────────────────────────────────

/**
 * The default login for an environment, never a reserved name: `<app>_<env>`, and when that is
 * reserved (app key `pg…` or `mysql…` makes `pg_…` / `mysql…`) `u_<app>_<env>`, fitted to the
 * engine's login length by defaultLoginName.
 */
export function plannedLoginName(appKey: string, envKey: string, engine: HubDbEngine): string {
  const name = defaultLoginName(appKey, envKey, engine)
  if (!isReservedDbName(engine, name)) return name
  return defaultLoginName(`u_${appKey}`, envKey, engine)
}

/** The database and login names an environment on `server` gets (given ones trimmed). */
export function plannedDatabaseNames(
  appKey: string,
  envKey: string,
  engine: HubDbEngine,
  given: { database_name?: unknown; login_name?: unknown }
): { database_name: string; login_name: string } {
  const database_name =
    given.database_name === undefined || given.database_name === null
      ? defaultDatabaseName(appKey, envKey)
      : str(given.database_name)
  const login_name =
    given.login_name === undefined || given.login_name === null
      ? plannedLoginName(appKey, envKey, engine)
      : str(given.login_name)
  return { database_name, login_name }
}

/** Why a database name may not be used (as data), or null. */
export function databaseNameProblem(engine: HubDbEngine, name: string): string | null {
  if (!isDbIdentifier(name))
    return `"${cut(name, 40)}" is not a database name the Hub accepts (lower-case letters, digits and _, 2–63, starting with a letter).`
  if (isReservedDbName(engine, name)) return `"${name}" is a reserved name.`
  return null
}

/** Why a login name may not be used (as data), or null. */
export function loginNameProblem(engine: HubDbEngine, name: string): string | null {
  if (!isDbIdentifier(name))
    return `The login "${cut(name, 40)}" is not a name the Hub accepts (lower-case letters, digits and _, starting with a letter).`
  if (name.length > maxLoginLength(engine))
    return `The login "${name}" is longer than ${maxLoginLength(engine)} characters, the most this engine allows.`
  if (isReservedDbName(engine, name)) return `The login "${name}" is a reserved name.`
  return null
}

/** Why a server cannot take a new database, or null. */
export function serverProblem(s: HubDbServerRow): string | null {
  if (!PROVISION_ENGINES.includes(s.engine))
    return `${s.name} is a ${String(s.engine)} server: the Hub makes databases on SQL Server, Postgres, MySQL and MariaDB only.`
  if (s.provision_mode !== 'automatic' && s.provision_mode !== 'manual')
    return `${s.name} has no provisioning mode.`
  if (s.provision_mode === 'automatic' && !s.admin_secret)
    return `${s.name} makes databases automatically but has no provisioning login: enter one on the Databases tab.`
  if (s.collation !== null && s.collation !== undefined && !isCollation(s.collation))
    return `${s.name} has a collation the Hub cannot use: correct it on the Databases tab.`
  if (
    (s.engine === 'mysql2' || s.engine === 'mariadb') &&
    s.user_host !== null &&
    s.user_host !== undefined &&
    !isUserHost(s.user_host)
  )
    return `${s.name} has a login host the Hub cannot use: correct it on the Databases tab.`
  return null
}

// ── target ───────────────────────────────────────────────────────────────────

/** Why a target cannot take a new app, or null. Names only in the text. */
export function targetProblem(t: HubTargetRow): string | null {
  if (t.kind !== 'gitlab') return `${t.name} is not a GitLab target.`
  if (!t.secret) return `${t.name} has no GitLab token: enter one on the target.`
  const c = t.config
  if (!c || typeof c !== 'object') return `${t.name} has no settings.`
  if (typeof c.namespace !== 'string' || !GITLAB_PATH.test(c.namespace))
    return `${t.name} has no GitLab namespace to create the deploy repository in.`
  if (!validTemplateRef(c.template_ref))
    return `${t.name} pins its template to "${cut(String(c.template_ref ?? ''), 40)}", which is not a tag or commit sha.`
  const known = parseKnownHosts(c.manager_known_hosts)
  if (!known) return `${t.name} has no manager host keys (manager_known_hosts).`
  if (typeof c.deploy_host !== 'string' || !knownHostsCover(known, c.deploy_host))
    return `${t.name}'s manager host keys do not cover its deploy host: add the host key of ${cut(String(c.deploy_host ?? ''), 60)}.`
  if (c.dns_mode !== 'automatic' && c.dns_mode !== 'manual' && c.dns_mode !== 'route53')
    return `${t.name} has no DNS mode.`
  if (c.dns_mode !== 'manual' && !dnsSuffix(c.wildcard_domain))
    return `${t.name} makes names automatically but has no wildcard domain.`
  if (c.scheme !== 'https' && c.scheme !== 'http')
    return `${t.name} must use https (http only for localhost and .test).`
  try {
    ciConfigPath(c)
    deployProjectVariables(c)
  } catch (err) {
    return `${t.name}: ${err instanceof Error ? err.message : 'settings are incomplete'}`
  }
  return null
}

// ── Hub URL ──────────────────────────────────────────────────────────────────

const isLocalName = (h: string) =>
  h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '[::1]'

/** Why `hubUrl` cannot be given to the apps as HUB_URL, or null. */
export function hubUrlProblem(hubUrl: string | null, appHosts: string[]): string | null {
  if (!hubUrl)
    return 'The Hub has no address to give the apps (HUB_URL, else PUBLIC_URL): set one and restart the Hub.'
  let u: URL
  try {
    u = new URL(hubUrl)
  } catch {
    return 'The Hub address (HUB_URL, else PUBLIC_URL) is not a URL.'
  }
  const host = u.hostname.toLowerCase()
  if (
    u.protocol !== 'https:' &&
    !(u.protocol === 'http:' && (httpAllowed(host) || isLocalName(host)))
  )
    return `The Hub address ${u.origin} is not https: apps send their Hub link token to it (http only for localhost and .test).`
  if (isLocalName(host) && appHosts.some((h) => !httpAllowed(h)))
    return `The Hub address ${u.origin} is local to this machine: the apps could not reach it. Set HUB_URL to the address apps reach the Hub on.`
  return null
}

// ── plan ─────────────────────────────────────────────────────────────────────

export function buildCreationPlan(input: CreateAppInput, facts: CreationFacts): CreationPlan {
  const blockers: CreationBlocker[] = []
  const block = (code: string, text: string, env?: string) =>
    blockers.push(env ? { code, text, env } : { code, text })
  const i = (input && typeof input === 'object' ? input : {}) as Partial<CreateAppInput>

  // App
  const key = str(i.key)
  const keyOk = isCreatableKey(key)
  if (!keyOk)
    block(
      'BAD_KEY',
      `"${cut(key, 40)}" is not an app key: lower-case letters, digits and single dashes, starting with a letter (no "--").`
    )
  else if (facts.keyTaken) block('KEY_TAKEN', `An app with the key ${key} exists already.`)

  const name = str(i.name)
  if (!isPlainText(i.name, APP_NAME_MAX))
    block('BAD_NAME', `The app needs a name of one line, ${APP_NAME_MAX} characters at most.`)

  if (
    !Array.isArray(i.owners) ||
    i.owners.some((o) => typeof o !== 'string' || !UUID_RE.test(o.trim()))
  )
    block('BAD_OWNER', 'Owners must be a list of people.')
  else if (facts.unknownOwners.length)
    block('BAD_OWNER', `${facts.unknownOwners.length} owner(s) name no person.`)

  const fa = (i.first_admin && typeof i.first_admin === 'object' ? i.first_admin : null) as
    | CreateAppInput['first_admin']
    | null
  const email = str(fa?.email)
  if (!fa || !email || email.length > EMAIL_MAX || !EMAIL_RE.test(email))
    block('BAD_EMAIL', 'The first administrator needs an email address like ada@example.com.')
  else
    for (const part of ['first_name', 'last_name'] as const) {
      const v = fa[part]
      if (v !== undefined && v !== null && v !== '' && !isPlainText(v, PERSON_NAME_MAX))
        block('BAD_EMAIL', `The first administrator's ${part.replace('_', ' ')} must be one line.`)
    }

  // Target: a GitLab target, a Docker driver (the Hub agent) or a shared deployment.
  const kind = creationKindOf(i)
  const gitlab = kind === 'gitlab'
  const t = gitlab && facts.target && facts.target.id === gitlabTargetIdOf(i) ? facts.target : null
  const dk = kind === 'docker' ? (facts.docker ?? null) : null
  const sh = kind === 'shared' ? (facts.shared?.deployment ?? null) : null
  // Task 11a: a GitHub target (github-target.ts).
  const gh =
    kind === 'github' && facts.github?.target && facts.github.target.id === githubTargetIdOf(i)
      ? facts.github.target
      : null
  let targetOk = false
  let targetName: string | null = null
  if (kind === 'github') {
    if (!gh) block('BAD_TARGET', 'Pick the GitHub target the app is created on.')
    else {
      targetName = gh.name
      if (facts.github?.problem) block('BAD_TARGET', facts.github.problem)
      else targetOk = true
    }
  } else if (gitlab) {
    if (!t) block('BAD_TARGET', 'Pick the target the app is created on.')
    else {
      targetName = t.name
      const why = targetProblem(t)
      if (why) block('BAD_TARGET', why)
      else targetOk = true
    }
  } else if (kind === 'docker') {
    const d = dk?.driver ?? null
    targetName = d?.name ?? null
    if (!d) block('BAD_TARGET', 'Pick the Docker driver (the Hub agent) the app is deployed with.')
    else if (!d.secret)
      block('BAD_TARGET', `${d.name} has no agent token: enter one on the driver.`)
    else targetOk = true
  } else {
    targetName = sh?.name ?? null
    if (!sh) block('BAD_TARGET', 'Pick the shared deployment the app is placed on.')
    else if (sh.status === 'retired')
      block('SHARED_RETIRED', `${sh.key} is retired: nothing can be placed on it.`)
    else if (sh.status === 'upgrading')
      block('SHARED_BUSY', `${sh.key} is being upgraded or rolled back: wait for it to end.`)
    else if (sh.mode === 'docker' && (sh.status === 'new' || !sh.version_pin))
      block(
        'NOT_DEPLOYED',
        `${sh.key} has not been deployed yet: upgrade it to a version first, then create apps on it.`
      )
    else targetOk = true
  }
  if (targetOk && dk?.driver) dockerAppBlockers()

  // Version + image (a shared deployment runs its own version: blank = that one)
  const version = sh && !str(i.version) ? (sh.version_pin ?? '') : str(i.version)
  if (kind === 'shared') {
    if (sh && version && sh.version_pin && version !== sh.version_pin)
      block(
        'VERSION_NOT_SHARED',
        `${sh.key} runs ${sh.version_pin}: an app placed on it runs that version. Leave the version empty.`
      )
    else if (version && !VERSION_RE.test(version))
      block('BAD_VERSION', `"${cut(version, 40)}" is not a version (x.y.z).`)
  } else if (!VERSION_RE.test(version))
    block('BAD_VERSION', `"${cut(version, 40)}" is not a version (x.y.z).`)
  else if (facts.digest === null)
    block(
      'IMAGE_MISSING',
      `The image for ${version} is not on Docker Hub, or Docker Hub did not answer.`
    )
  else if (facts.digest === 'present')
    block(
      'IMAGE_NO_DIGEST',
      `Docker Hub lists ${version} without a digest: the deploy pins images by digest only.`
    )

  // Sign-in (the secret is checked, never quoted)
  const si = (i.signin && typeof i.signin === 'object' ? i.signin : null) as
    | CreateAppInput['signin']
    | null
  const signinProblem = (() => {
    if (!si) return 'Sign-in needs the issuer, client id and client secret of the app registration.'
    let issuer: URL
    try {
      issuer = new URL(str(si.issuer))
    } catch {
      return 'The sign-in issuer must be a URL.'
    }
    if (
      issuer.username ||
      issuer.password ||
      issuer.hash ||
      !(
        issuer.protocol === 'https:' ||
        (issuer.protocol === 'http:' && httpAllowed(issuer.hostname.toLowerCase()))
      ) ||
      CONTROL.test(String(si.issuer)) ||
      String(si.issuer).length > 500
    )
      return 'The sign-in issuer must be an https URL.'
    const id = str(si.client_id)
    if (!id || id.length > 200 || /\s/.test(id) || CONTROL.test(id))
      return 'The sign-in client id must be one word.'
    const secret = si.client_secret
    if (
      typeof secret !== 'string' ||
      !secret.trim() ||
      secret.length > 1000 ||
      CONTROL.test(secret)
    )
      return 'The sign-in client secret is missing.'
    return null
  })()
  // On a shared deployment the app signs in with the deployment's own OIDC: optional there.
  if (signinProblem && !(kind === 'shared' && (i.signin === undefined || i.signin === null)))
    block('BAD_SIGNIN', signinProblem)

  const extensionIds: string[] = []
  if (i.extensions !== undefined && i.extensions !== null) {
    if (kind === 'shared') {
      if (
        !Array.isArray(i.extensions) ||
        i.extensions.some((x) => typeof x !== 'string' || !EXTENSION_ID_RE.test(x))
      )
        block('BAD_EXTENSIONS', 'Extensions are a list of extension ids.')
      else {
        for (const x of i.extensions) if (!extensionIds.includes(x)) extensionIds.push(x)
        const missing = sh ? extensionIds.filter((x) => !sh.extensions.includes(x)) : []
        if (missing.length)
          block(
            'EXTENSION_NOT_ALLOWED',
            `${sh?.key} does not load ${missing.slice(0, 10).join(', ')}.`
          )
      }
    } else if (!Array.isArray(i.extensions) || i.extensions.length)
      block(
        'EXTENSIONS_UNSUPPORTED',
        kind === 'docker'
          ? 'A Docker app gets its extensions as pinned images in the stack settings (extension_pins).'
          : 'Created apps start without extensions: add one in the deploy repository afterwards.'
      )
  }
  const pins: Record<string, string> =
    dk?.settings.ok && dk.settings.row.extension_pins ? dk.settings.row.extension_pins : {}

  // Shared: the pool each environment takes on the deployment.
  const tgt = (i.target && typeof i.target === 'object' ? i.target : {}) as { pool_max?: unknown }
  let poolMax = DEFAULT_POOL_MAX
  if (kind === 'shared' && tgt.pool_max !== undefined && tgt.pool_max !== null) {
    const n = tgt.pool_max
    if (typeof n !== 'number' || !Number.isInteger(n) || n > MAX_SHARED_POOL_MAX)
      block(
        'BAD_POOL',
        `pool_max must be a whole number of connections, at most ${MAX_SHARED_POOL_MAX}.`
      )
    else if (n < MIN_SHARED_POOL_MAX)
      block(
        'POOL_TOO_SMALL',
        `An app on a shared deployment needs at least ${MIN_SHARED_POOL_MAX} database connections.`
      )
    else poolMax = n
  }

  // Task 11a: names made in Route 53 need the hosted zone the config names.
  if (facts.dnsZone && !facts.dnsZone.ok)
    block('DNS_ZONE_MISSING', facts.dnsZone.message ?? 'The Route 53 hosted zone is not usable.')
  if (!facts.encryptionKey)
    block(
      'NEEDS_ENCRYPTION_KEY',
      'Set ENCRYPTION_KEY (64 hex characters) on the Hub: it seals the new apps’ tokens and connections.'
    )

  // Environments
  const envs = Array.isArray(i.environments) ? i.environments : []
  if (!envs.length) block('NO_ENVIRONMENTS', 'Add at least one environment.')
  else if (envs.length > MAX_CREATE_ENVIRONMENTS)
    block(
      'TOO_MANY_ENVIRONMENTS',
      `An app is created with ${MAX_CREATE_ENVIRONMENTS} environments at most.`
    )

  const taken = new Set([
    ...facts.takenHostnames.map(hostKey),
    ...hubOwnHostnames([facts.hubUrl]).map(hostKey)
  ])
  const takenStacks = new Set(facts.takenStackNames)
  const seenEnv = new Set<string>()
  const seenHost = new Set<string>()
  const seenStack = new Set<string>()
  const seenDbName = new Set<string>()
  const seenLogin = new Set<string>()
  const seenDbId = new Set<number>()
  const planned: CreationPlanEnvironment[] = []
  const appHosts: string[] = []
  const naming: NamingConfig | null = !targetOk
    ? null
    : gh
      ? gh.config
      : t
        ? t.config
        : dk?.driver
          ? namingForDocker(dk.driver.config)
          : sh
            ? namingForShared(sh)
            : null
  const edge = dk?.health?.edge === 'publish' ? 'publish' : 'traefik'
  const seenPort = new Set<number>()
  const stackSize = dk?.settings.ok ? dk.settings.row.fields.size : 'small'
  const stackRedis = dk?.settings.ok ? dk.settings.row.fields.redis : 'bundled'

  envs.slice(0, MAX_CREATE_ENVIRONMENTS).forEach((raw, position) => {
    const e = (raw && typeof raw === 'object' ? raw : {}) as CreateAppInput['environments'][number]
    const envKey = str(e.key)
    const envKeyOk = isCreatableKey(envKey)
    const label = envKeyOk ? envKey : `environment ${position + 1}`
    if (!envKeyOk)
      block(
        'BAD_ENV_KEY',
        `"${cut(envKey, 40)}" is not an environment key: lower-case letters, digits and single dashes (no "--").`,
        label
      )
    else if (seenEnv.has(envKey)) block('DUPLICATE_ENV', `${envKey} is listed twice.`, envKey)
    if (envKeyOk) seenEnv.add(envKey)
    const prev = position > 0 ? str(envs[position - 1]?.key) : envKey
    const namesOk = keyOk && envKeyOk

    // Hostname, base URL, ticket
    let hostname: string | null = null
    let base_url: string | null = null
    let ticket: string | null = null
    let redirect_uri: string | null = null
    if (naming && namesOk) {
      const h = sh
        ? sharedHostname(sh, facts.shared?.routed ?? [], key, envKey, e.hostname ?? null)
        : hostnameFor(naming, key, envKey, e.hostname ?? null)
      if (!h.ok) block(h.code, h.message, label)
      else {
        try {
          // Docker / shared: http only for the local names that allow it (namingFor*).
          const forUrl = dk?.driver
            ? namingForDocker(dk.driver.config, h.hostname)
            : sh
              ? namingForShared(sh, h.hostname)
              : naming
          base_url = baseUrlFor(forUrl, h.hostname)
          hostname = h.hostname
        } catch (err) {
          block('HOSTNAME_INVALID', err instanceof Error ? err.message : 'Not a hostname.', label)
        }
      }
      if (hostname) {
        appHosts.push(hostname)
        if (taken.has(hostname))
          block(
            'HOSTNAME_TAKEN',
            `${hostname} is already used by another environment or by the Hub itself.`,
            label
          )
        else if (seenHost.has(hostname))
          block('HOSTNAME_TAKEN', `${hostname} is given to two environments.`, label)
        seenHost.add(hostname)
        redirect_uri = base_url ? redirectUriFor(base_url) : null
        if (naming.dns_mode === 'manual' && !sh) ticket = manualTicket(naming, hostname)
        // The agent's own rules for the name: under the wildcard, under a host suffix.
        if (dk?.driver && dk.health)
          for (const p of hostnameRefusals([hostname], dk.driver.config, {
            hostSuffixes: edge === 'traefik' ? dk.health.host_suffixes : undefined,
            edge
          }))
            block(
              p.code === 'HOSTNAME_INVALID' ? 'HOSTNAME_INVALID' : 'HOSTNAME_NOT_ALLOWED',
              p.message,
              label
            )
      }
    }

    // Docker: the published port of a publish edge (one per environment, in the agent's range).
    let publishPort: number | null = null
    if (dk?.health) {
      const raw = e.publish_port
      if (raw !== undefined && raw !== null) {
        if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > 65535)
          block('BAD_PUBLISH_PORT', 'The publish port must be a port number (1–65535).', label)
        else publishPort = raw
      }
      if (edge === 'publish') {
        const why = publishPortProblem(dk.health, { publish_port: publishPort } as never)
        if (why) block('PUBLISH_PORT_NOT_ALLOWED', `${label}: ${why}.`, label)
        else if (publishPort !== null && (dk.takenPorts ?? []).includes(publishPort))
          block(
            'PUBLISH_PORT_NOT_ALLOWED',
            `Port ${publishPort} is already published by another stack on ${dk.driver?.name ?? 'this driver'}.`,
            label
          )
        else if (publishPort !== null && seenPort.has(publishPort))
          block(
            'PUBLISH_PORT_NOT_ALLOWED',
            `Port ${publishPort} is given to two environments.`,
            label
          )
        if (publishPort !== null) seenPort.add(publishPort)
      } else publishPort = null
    }

    // Stack
    let stack: string | null = null
    if (namesOk && kind !== 'shared') {
      stack = stackName(key, envKey)
      if (takenStacks.has(stack) || seenStack.has(stack))
        block(
          'STACK_NAME_TAKEN',
          `The swarm stack ${stack} is already another environment's: pick another environment key.`,
          label
        )
      else if (dk?.placementStacks.includes(stack))
        block(
          'STACK_NAME_TAKEN',
          `Another placement on ${dk.driver?.name ?? 'this driver'} already deploys stack ${stack}.`,
          label
        )
      else if (dk?.health) {
        const held = dk.stacks[stack]
        if (held === 'hub' || held === 'other')
          block(
            'STACK_EXISTS',
            `The swarm already runs a stack named ${stack}: remove it first, or pick another environment key.`,
            label
          )
        else if (held !== 'none')
          block('AGENT_UNREACHABLE', `The Hub agent did not say whether ${stack} exists.`, label)
      }
      seenStack.add(stack)
    }

    // Database
    const database = planDatabase(e.database, label, key, envKey, namesOk)
    // place-shared makes an app key only for an empty database (an install there has its own).
    if (kind === 'shared' && database.holds_nivaro)
      block(
        'DATABASE_HOLDS_NIVARO',
        `${database.database_name} already holds a Nivaro install: an app that has served moves to a shared deployment instead.`,
        label
      )
    // Task 11a: the environment's provider parts (provider-parts.ts), shape only — the change
    // engine judges each when the providers step plans it.
    const parts = providerPartsOf((e as { providers?: unknown }).providers)
    if (!parts.ok) block('BAD_PROVIDER_PART', parts.text, label)
    planned.push({
      key: envKey,
      position,
      hostname,
      base_url,
      dns_mode: naming?.dns_mode === 'manual' ? 'manual' : 'automatic',
      ticket,
      redirect_uri,
      branch: envKey,
      source_branch: prev || envKey,
      stack_name: stack,
      ...(kind === 'docker'
        ? { stack: { size: stackSize, redis: stackRedis, publish_port: publishPort } }
        : {}),
      ...(kind === 'shared' ? { pool_max: poolMax } : {}),
      ...(parts.ok && parts.parts.length
        ? { providers: parts.parts.map((p) => ({ type: p.type, connection_id: p.connection_id })) }
        : {}),
      ...(facts.dnsZone ? { dns_record: true } : {}),
      database
    })
  })

  /** The agent's limits, the image and the stack settings of a Docker creation. */
  function dockerAppBlockers(): void {
    const d = dk as NonNullable<typeof dk>
    if (d.agentState !== 'ok' || !d.health) {
      block(
        d.agentState === 'incompatible'
          ? 'AGENT_INCOMPATIBLE'
          : d.agentState === 'refused'
            ? 'AGENT_REFUSED'
            : 'AGENT_UNREACHABLE',
        d.agentState === 'incompatible'
          ? `The Hub agent of ${d.driver?.name} speaks another API version: upgrade the agent.`
          : d.agentState === 'refused'
            ? `The Hub agent of ${d.driver?.name} refused the Hub (check the driver's token and address).`
            : `The Hub agent of ${d.driver?.name} did not answer.`
      )
      return
    }
    const images = Array.isArray(d.health.images) ? d.health.images : []
    if (!images.includes(d.imageRepo))
      block(
        'IMAGE_NOT_ALLOWED',
        `The agent does not allow ${d.imageRepo}: add it to HUB_AGENT_IMAGES on the agent.`
      )
    if (!d.settings.ok) {
      block(d.settings.code, d.settings.message)
      return
    }
    const row = d.settings.row
    for (const [id, pin] of Object.entries(row.extension_pins ?? {}).sort(([a], [b]) =>
      a.localeCompare(b)
    )) {
      const repo = pin.slice(0, pin.indexOf('@'))
      if (!images.includes(repo))
        block(
          'EXTENSION_NOT_ALLOWED',
          `The agent does not allow extension ${id} (${repo}): add it to HUB_AGENT_IMAGES.`
        )
    }
    if (row.fields.redis === 'bundled' && d.health.redis_bundled === false)
      block(
        'REDIS_NOT_OFFERED',
        'The agent offers no bundled Redis (HUB_AGENT_REDIS_IMAGE is not set): pick external Redis and give REDIS_URL.'
      )
    if (
      row.fields.redis === 'external' &&
      !row.fields.settings.REDIS_URL?.trim() &&
      !d.secretKeys.includes('REDIS_URL')
    )
      block('STACK_SETTINGS_MISSING', 'External Redis needs REDIS_URL (a setting or a secret).')
    const v = str(i.version)
    if (VERSION_RE.test(v))
      try {
        stackRoles(v, row.fields.size, d.health.agent_version)
      } catch (err) {
        if (!(err instanceof StackTemplateError)) throw err
        block(err.code, err.message)
      }
  }

  function planDatabase(
    d: unknown,
    label: string,
    appKey: string,
    envKey: string,
    namesOk: boolean
  ): CreationPlanDatabase {
    const spec = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>
    const none: CreationPlanDatabase = {
      mode: 'automatic',
      server_name: null,
      database_name: '',
      login_name: null,
      engine: 'mssql',
      checklist: null
    }

    if (spec.database_id !== undefined) {
      const id = Number(spec.database_id)
      const row = Number.isInteger(id) ? facts.existing[id] : undefined
      if (!row) {
        block(
          'DATABASE_NOT_READY',
          `There is no Hub database #${cut(String(spec.database_id), 12)}.`,
          label
        )
        return { ...none, mode: 'existing' }
      }
      if (seenDbId.has(id))
        block('DATABASE_IN_USE', `${row.database_name} is given to two environments.`, label)
      else if (row.environment)
        block(
          'DATABASE_IN_USE',
          `${row.database_name} already belongs to ${row.environment.app_key}/${row.environment.env_key}.`,
          label
        )
      seenDbId.add(id)
      // 0.3.215: a SQLite record is a file a shared deployment keeps for an app it places; a new
      // app's own stack keeps its SQLite file in its stack settings instead.
      if (row.engine === 'sqlite') {
        block(
          'SQLITE_PLACE_ONLY',
          `${row.database_name} is a SQLite record: it is used by placing an environment on a shared deployment of size small, not by a new app's own stack.`,
          label
        )
        return { ...none, mode: 'existing' }
      }
      if (row.status !== 'ready')
        block(
          'DATABASE_NOT_READY',
          `${row.database_name} is ${row.status}: only a ready database can be used.`,
          label
        )
      const holds =
        row.last_check?.state === 'nivaro'
          ? {
              migrations: row.last_check.migrations ?? null,
              last_migration: row.last_check.last_migration ?? null
            }
          : null
      return {
        mode: 'existing',
        server_name: row.server_name,
        database_name: row.database_name,
        login_name: row.login_name,
        engine: row.engine,
        checklist: null,
        ...(holds ? { holds_nivaro: holds } : {})
      }
    }

    const sid = Number(spec.server_id)
    const server = Number.isInteger(sid) ? facts.servers[sid] : undefined
    if (!server) {
      block(
        'BAD_SERVER',
        'Pick the database server for this environment, or an existing database.',
        label
      )
      return none
    }
    const serverWhy = serverProblem(server)
    if (serverWhy) block('BAD_SERVER', serverWhy, label)
    const automatic = server.provision_mode === 'automatic'
    if (!namesOk && spec.database_name === undefined)
      return {
        ...none,
        mode: automatic ? 'automatic' : 'manual',
        server_name: server.name,
        engine: server.engine
      }

    const names = plannedDatabaseNames(appKey, envKey, server.engine, spec)
    const dbWhy = databaseNameProblem(server.engine, names.database_name)
    // A bad app key makes no default login worth judging (BAD_KEY already says it); a login
    // typed for the environment is still checked.
    const loginGiven = spec.login_name !== undefined && spec.login_name !== null
    const loginWhy = keyOk || loginGiven ? loginNameProblem(server.engine, names.login_name) : null
    if (dbWhy) block('DATABASE_NAME_INVALID', dbWhy, label)
    if (loginWhy) block('DATABASE_NAME_INVALID', loginWhy, label)

    if (!dbWhy) {
      const host = hostKey(server.host)
      const dbKey = `${host}\u0000${names.database_name.toLowerCase()}`
      if (
        facts.recordedNames.some(
          (r) =>
            hostKey(r.host) === host &&
            r.database_name.toLowerCase() === names.database_name.toLowerCase()
        )
      )
        block(
          'DATABASE_RECORDED',
          `The Hub already records ${names.database_name} on ${server.name}.`,
          label
        )
      else if (seenDbName.has(dbKey))
        block('DATABASE_RECORDED', `${names.database_name} is given to two environments.`, label)
      seenDbName.add(dbKey)

      // gather.ts probes only with a good app key: without one there is no verdict to read.
      if (automatic && !serverWhy && keyOk) {
        const has = facts.serverHas[`${server.id}:${names.database_name}`]
        if (has === true)
          block(
            'DATABASE_EXISTS',
            `${server.name} already has a database ${names.database_name}: pick another name or adopt it.`,
            label
          )
        else if (has !== false) block('SERVER_UNREACHABLE', `${server.name} did not answer.`, label)
      }
    }
    if (!loginWhy && (keyOk || loginGiven)) {
      const loginKey = `${hostKey(server.host)}\u0000${names.login_name.toLowerCase()}`
      if (seenLogin.has(loginKey))
        block(
          'DATABASE_RECORDED',
          `The login ${names.login_name} is given to two environments.`,
          label
        )
      seenLogin.add(loginKey)
    }

    return {
      mode: automatic ? 'automatic' : 'manual',
      server_name: server.name,
      database_name: names.database_name,
      login_name: names.login_name,
      engine: server.engine,
      checklist:
        automatic || dbWhy || loginWhy
          ? null
          : dbaChecklist(publicServer(server), names.database_name, names.login_name)
    }
  }

  // GitLab project + Hub address (after the environments: the Hub address check needs their names)
  const projectPath = gitlab
    ? `${t?.config?.namespace ?? ''}${t?.config?.namespace ? '/' : ''}${key}-deploy`
    : ''
  if (gitlab && targetOk && keyOk) {
    if (facts.projectExists === true)
      block(
        'PROJECT_EXISTS',
        `GitLab already has a project ${projectPath}: the Hub creates the deploy repository itself.`
      )
    else if (facts.projectExists === 'unreachable')
      block('GITLAB_UNREACHABLE', `GitLab did not answer for ${projectPath}.`)
  }
  // A shared app is not told HUB_URL by the creation (the deployment carries it); its hub token
  // is issued by the placement when the app serves.
  const hubWhy = kind === 'shared' ? null : hubUrlProblem(facts.hubUrl, appHosts)
  if (hubWhy) block('NO_HUB_URL', hubWhy)

  // Shared: the deployment's connection budget takes every new environment's pool.
  if (sh && targetOk && planned.length) {
    const want = poolMax * planned.length
    const used = facts.shared?.poolUsed ?? 0
    if (used + want > sh.pool_budget)
      block(
        'POOL_BUDGET',
        `${sh.key} has ${Math.max(0, sh.pool_budget - used)} of its ${sh.pool_budget} database connections left; ${planned.length} environment(s) at ${poolMax} each need ${want}.`
      )
  }

  // Plain warnings (never blockers): an existing database that already holds a Nivaro install
  // is legitimate (an app re-created on its old data) but must not surprise anyone.
  const warnings: string[] = []
  for (const p of planned) {
    const d = p.database
    if (d.mode !== 'existing' || !d.holds_nivaro) continue
    const n = d.holds_nivaro
    const ledger =
      n.migrations != null
        ? ` (${n.migrations} migrations${n.last_migration ? `, last ${n.last_migration}` : ''})`
        : ''
    warnings.push(
      `${p.key}: ${d.database_name} already holds a Nivaro install${ledger}: the app starts on that data and its users, and the first administrator is made only if it has none. Make sure no other app still uses it.`
    )
  }

  if (dk?.health) {
    const nodes = dk.health.swarm?.nodes
    if (typeof nodes === 'number' && nodes > 1 && (dk.health.volume_driver ?? 'local') === 'local')
      warnings.push(
        `The swarm has ${nodes} nodes and the agent keeps volumes on each node (local): a stack's uploads stay on the node a task ran on. Set a shared volume driver on the agent before you rely on uploads.`
      )
    if (planned.some((p) => p.database.holds_nivaro) && !dk.secretKeys.includes('ENCRYPTION_KEY'))
      warnings.push(
        'A new ENCRYPTION_KEY is generated: values the old install sealed with its own key stay unreadable unless you enter that key as the secret ENCRYPTION_KEY.'
      )
  }

  // Preview lines: names only.
  const lines: string[] = []
  if (t) lines.push(`Fork ${t.config.template_project} into ${projectPath} (target ${t.name}).`)
  if (gh)
    lines.push(
      `Create the GitHub repository ${key} from ${gh.config.template} (target ${gh.name}); each environment gets a GitHub environment with its secrets, and ${gh.config.deploy_workflow} deploys it.`
    )
  if (dk?.driver) {
    lines.push(
      `Deploy through the Hub agent of ${dk.driver.name}${dk.health ? ` (${edge === 'publish' ? 'published port' : 'traefik'} edge)` : ''}.`
    )
    const ids = Object.keys(pins).sort()
    lines.push(
      `Install Nivaro ${version || '(no version)'} (${dk.imageRepo})${ids.length ? ` with ${ids.join(', ')}` : ' with no extensions'}.`
    )
    lines.push(
      `Stack settings: size ${stackSize}, Redis ${stackRedis}; SESSION_SECRET and ENCRYPTION_KEY${dk.secretKeys.includes('ENCRYPTION_KEY') ? ' (as entered)' : ' generated and'} sealed for each environment.`
    )
  } else if (sh) {
    lines.push(
      `Place every environment on the shared deployment ${sh.key} (Nivaro ${sh.version_pin ?? 'its version'}), ${poolMax} database connections each.`
    )
    if (extensionIds.length) lines.push(`Extensions: ${extensionIds.join(', ')}.`)
  } else lines.push(`Install Nivaro ${version || '(no version)'} with no extensions.`)
  for (const p of planned) {
    const d = p.database
    const dbLine =
      d.mode === 'existing'
        ? `use the existing database ${d.database_name}${d.server_name ? ` on ${d.server_name}` : ''}`
        : d.mode === 'automatic'
          ? `create database ${d.database_name} and login ${d.login_name} on ${d.server_name}`
          : `ask the DBA for database ${d.database_name} and login ${d.login_name} on ${d.server_name}`
    lines.push(`${p.key}: ${dbLine}.`)
    if (gitlab)
      lines.push(
        `${p.key}: branch ${p.branch} (promoted from ${p.source_branch}), stack ${p.stack_name ?? '—'}.`
      )
    else if (kind === 'docker')
      lines.push(
        `${p.key}: stack ${p.stack_name ?? '—'} (promoted from ${p.source_branch})${p.stack?.publish_port ? `, published on port ${p.stack.publish_port}` : ''}.`
      )
    if (p.hostname)
      lines.push(
        p.dns_mode === 'manual'
          ? `${p.key}: ${p.base_url} — the DNS name is requested by ticket; the Hub waits until it answers.`
          : `${p.key}: ${p.base_url}.`
      )
    if (p.redirect_uri)
      lines.push(
        sh
          ? `${p.key}: add the redirect URI ${p.redirect_uri} to the deployment's app registration.`
          : `${p.key}: add the redirect URI ${p.redirect_uri} to the app registration.`
      )
    // Task 11a: provider parts and a Route 53 name record (the providers step).
    if (p.dns_record && p.hostname)
      lines.push(`${p.key}: the Hub makes the Route 53 record ${p.hostname} in the hosted zone.`)
    for (const part of p.providers ?? [])
      lines.push(
        partLine(p.key, {
          type: part.type as CreateProviderType,
          connection_id: part.connection_id
        })
      )
  }
  if (email && EMAIL_RE.test(email)) lines.push(`First administrator: ${email}.`)

  return {
    ok: blockers.length === 0,
    blockers,
    lines,
    warnings,
    app: { key, name, project_path: projectPath },
    target: { kind, name: targetName },
    environments: planned
  }
}
