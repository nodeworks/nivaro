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
import {
  baseUrlFor,
  ciConfigPath,
  deployProjectVariables,
  hostnameFor,
  hubOwnHostnames,
  isCreatableKey,
  manualTicket,
  redirectUriFor,
  stackName
} from './app-config.js'
import { dnsSuffix, httpAllowed } from './dns.js'
import { type HubTargetRow, knownHostsCover, parseKnownHosts, validTemplateRef } from './targets.js'
import type {
  CreateAppInput,
  CreationBlocker,
  CreationFacts,
  CreationPlan,
  CreationPlanDatabase,
  CreationPlanEnvironment
} from './types.js'

/** At most this many environments per created app. */
export const MAX_CREATE_ENVIRONMENTS = 6

const VERSION_RE = /^\d+\.\d+\.\d+$/
// Twin of hub-link/first-admin.ts (the app refuses anything else, so refuse it before creating).
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/
const EMAIL_MAX = 255
const PERSON_NAME_MAX = 100
const APP_NAME_MAX = 200
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
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
  if (c.dns_mode !== 'automatic' && c.dns_mode !== 'manual') return `${t.name} has no DNS mode.`
  if (c.dns_mode === 'automatic' && !dnsSuffix(c.wildcard_domain))
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
    return 'The Hub has no address to give the apps (HUB_URL, ADMIN_URL or PUBLIC_URL): set one and restart the Hub.'
  let u: URL
  try {
    u = new URL(hubUrl)
  } catch {
    return 'The Hub address (HUB_URL / ADMIN_URL / PUBLIC_URL) is not a URL.'
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

  // Target
  const t = facts.target && facts.target.id === Number(i.target_id) ? facts.target : null
  let targetOk = false
  if (!t) block('BAD_TARGET', 'Pick the target the app is created on.')
  else {
    const why = targetProblem(t)
    if (why) block('BAD_TARGET', why)
    else targetOk = true
  }

  // Version + image
  const version = str(i.version)
  if (!VERSION_RE.test(version))
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
  if (signinProblem) block('BAD_SIGNIN', signinProblem)

  if (i.extensions !== undefined && i.extensions !== null) {
    if (!Array.isArray(i.extensions) || i.extensions.length)
      block(
        'EXTENSIONS_UNSUPPORTED',
        'Created apps start without extensions: add one in the deploy repository afterwards.'
      )
  }

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
  const tc = targetOk && t ? t.config : null

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
    if (tc && namesOk) {
      const h = hostnameFor(tc, key, envKey, e.hostname ?? null)
      if (!h.ok) block(h.code, h.message, label)
      else {
        try {
          base_url = baseUrlFor(tc, h.hostname)
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
        if (tc.dns_mode === 'manual') ticket = manualTicket(tc, hostname)
      }
    }

    // Stack
    let stack: string | null = null
    if (namesOk) {
      stack = stackName(key, envKey)
      if (takenStacks.has(stack) || seenStack.has(stack))
        block(
          'STACK_NAME_TAKEN',
          `The swarm stack ${stack} is already another environment's: pick another environment key.`,
          label
        )
      seenStack.add(stack)
    }

    // Database
    const database = planDatabase(e.database, label, key, envKey, namesOk)
    planned.push({
      key: envKey,
      position,
      hostname,
      base_url,
      dns_mode: tc?.dns_mode === 'manual' ? 'manual' : 'automatic',
      ticket,
      redirect_uri,
      branch: envKey,
      source_branch: prev || envKey,
      stack_name: stack,
      database
    })
  })

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
      if (row.status !== 'ready')
        block(
          'DATABASE_NOT_READY',
          `${row.database_name} is ${row.status}: only a ready database can be used.`,
          label
        )
      return {
        mode: 'existing',
        server_name: row.server_name,
        database_name: row.database_name,
        login_name: row.login_name,
        engine: row.engine,
        checklist: null
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
  const projectPath = `${t?.config?.namespace ?? ''}${t?.config?.namespace ? '/' : ''}${key}-deploy`
  if (targetOk && keyOk) {
    if (facts.projectExists === true)
      block(
        'PROJECT_EXISTS',
        `GitLab already has a project ${projectPath}: the Hub creates the deploy repository itself.`
      )
    else if (facts.projectExists === 'unreachable')
      block('GITLAB_UNREACHABLE', `GitLab did not answer for ${projectPath}.`)
  }
  const hubWhy = hubUrlProblem(facts.hubUrl, appHosts)
  if (hubWhy) block('NO_HUB_URL', hubWhy)

  // Preview lines: names only.
  const lines: string[] = []
  if (t) lines.push(`Fork ${t.config.template_project} into ${projectPath} (target ${t.name}).`)
  lines.push(`Install Nivaro ${version || '(no version)'} with no extensions.`)
  for (const p of planned) {
    const d = p.database
    const dbLine =
      d.mode === 'existing'
        ? `use the existing database ${d.database_name}${d.server_name ? ` on ${d.server_name}` : ''}`
        : d.mode === 'automatic'
          ? `create database ${d.database_name} and login ${d.login_name} on ${d.server_name}`
          : `ask the DBA for database ${d.database_name} and login ${d.login_name} on ${d.server_name}`
    lines.push(`${p.key}: ${dbLine}.`)
    lines.push(
      `${p.key}: branch ${p.branch} (promoted from ${p.source_branch}), stack ${p.stack_name ?? '—'}.`
    )
    if (p.hostname)
      lines.push(
        p.dns_mode === 'manual'
          ? `${p.key}: ${p.base_url} — the DNS name is requested by ticket; the Hub waits until it answers.`
          : `${p.key}: ${p.base_url}.`
      )
    if (p.redirect_uri)
      lines.push(`${p.key}: add the redirect URI ${p.redirect_uri} to the app registration.`)
  }
  if (email && EMAIL_RE.test(email)) lines.push(`First administrator: ${email}.`)

  return {
    ok: blockers.length === 0,
    blockers,
    lines,
    app: { key, name, project_path: projectPath },
    environments: planned
  }
}
