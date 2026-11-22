// What a created app's deploy repository is told (phase 3, decisions 7–9): the non-secret
// settings committed as `.hub/app.env`, the hostname and base URL of each environment, the
// manual DNS ticket, and the names of the secret CI variables. Pure functions, no I/O.
//
// `.hub/app.env` is committed to a repository, so it never holds a secret: secrets travel only
// as masked, base64-wrapped GitLab CI variables (HUB_APP_SECRET_VARS). It also never holds a
// key that changes the runtime or the user the app runs as (appEnvKeyRefusal) — the template's
// deploy script reads exactly HUB_APP_ENV_KEYS from it and refuses every other line.
//
// Twins: deploy/hub-app-template/scripts/deploy.sh (APP_ENV_KEYS, secret names),
// deploy/hub-app-template/manager/nivaro-hub-deploy (the manager's own allow-list) and
// deploy/hub-app-template/manager/docker-stack.yml (one ${KEY} per setting, one secret per
// variable).
// hub-app-template.test.ts keeps them in step.

import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import type { HubDbEngine } from '../db/connection.js'
import { DNS_LABEL, dnsSuffix, httpAllowed } from './dns.js'
import type { HubTargetConfig } from './targets.js'

/** The non-secret settings in `.hub/app.env`, in the order the deploy script lists them. */
export const HUB_APP_ENV_KEYS: readonly string[] = Object.freeze([
  'APP_KEY',
  'ENV_KEY',
  'STACK_NAME',
  'APP_HOSTS',
  'PUBLIC_URL',
  'ADMIN_URL',
  'HUB_URL',
  'NIVARO_ENVIRONMENT',
  'DB_CLIENT',
  'OIDC_ISSUER',
  'OIDC_CLIENT_ID',
  'OIDC_REDIRECT_URI',
  'PROXY_NETWORK',
  'TRUST_PROXY'
])

/**
 * Secret CI variables (decision 8), per environment scope, masked + protected + raw, each the
 * base64 of the value. `secret` is the swarm secret's short name (inside the container at
 * /run/secrets/<secret>), `env` the app setting it fills through `<env>_FILE`. Short names keep
 * `<stack>_<secret>_<sha8>` within swarm's 64-character limit (see STACK_NAME_MAX).
 */
export const HUB_SECRET_FILES: Readonly<Record<string, { secret: string; env: string }>> =
  Object.freeze({
    NIVARO_DB_URL_B64: { secret: 'db_url', env: 'DB_URL' },
    NIVARO_HUB_TOKEN_B64: { secret: 'hub_token', env: 'HUB_TOKEN' },
    NIVARO_SESSION_SECRET_B64: { secret: 'session_secret', env: 'SESSION_SECRET' },
    NIVARO_ENCRYPTION_KEY_B64: { secret: 'encryption_key', env: 'ENCRYPTION_KEY' },
    NIVARO_OIDC_CLIENT_SECRET_B64: { secret: 'oidc_secret', env: 'OIDC_CLIENT_SECRET' }
  })

export const HUB_APP_SECRET_VARS: readonly string[] = Object.freeze(Object.keys(HUB_SECRET_FILES))

/**
 * Generated once and never overwritten: a new SESSION_SECRET signs everyone out, a new
 * ENCRYPTION_KEY makes the app's sealed values unreadable.
 */
export const KEEP_ONCE_VARS: readonly string[] = Object.freeze([
  'NIVARO_SESSION_SECRET_B64',
  'NIVARO_ENCRYPTION_KEY_B64'
])

/**
 * Longest stack name. Swarm names a secret `<stack>_<secret>_<sha8>` (≤ 64: 40 + 1 + 14 + 1 + 8)
 * and a service `<stack>_<service>` (≤ 63). Longer `<app>-<env>` names keep a hash suffix.
 */
export const STACK_NAME_MAX = 40

export class AppConfigError extends Error {
  code = 'BAD_APP_SETTING'
  constructor(message: string) {
    super(message)
    this.name = 'AppConfigError'
  }
}

// ── Keys ─────────────────────────────────────────────────────────────────────

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/
const NIVARO_ALLOWED = new Set([
  'NIVARO_ENVIRONMENT',
  'NIVARO_INSTANCE',
  'NIVARO_EXPECTED_DB',
  'NIVARO_HEAP_FROM_CGROUP'
])
/** Process / shell / deploy-job variables an app setting must never replace. */
const RESERVED = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'PWD',
  'HOSTNAME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'IFS',
  'ENV',
  'BASH_ENV',
  'DEPLOY_HOST',
  'DB_URL',
  'SESSION_SECRET',
  'ENCRYPTION_KEY'
])
const RESERVED_PREFIXES = [
  'LD_',
  'DYLD_',
  'OPENSSL_',
  'SSL_CERT_',
  'DOCKER_',
  'SSH_',
  'GIT_',
  'CI_',
  'GITLAB_',
  'TRAEFIK_',
  'SECRET_'
]
const SECRET_WORD = /(SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE|CREDENTIAL)/

/**
 * Why `key` may not be an `.hub/app.env` setting, or null when it may. Refused: secrets (and
 * anything named like one), `<KEY>_FILE`, NODE_* except NODE_ENV, OPENSSL_*, SSL_CERT_*,
 * TMPDIR, LD_*, NIVARO_* except NIVARO_ENVIRONMENT / INSTANCE / EXPECTED_DB / HEAP_FROM_CGROUP,
 * and the variables of the shell and the deploy job itself.
 */
export function appEnvKeyRefusal(key: string): string | null {
  if (!ENV_NAME.test(key)) return 'not an environment variable name'
  if (key.endsWith('_FILE')) return 'a file indirection (secrets travel as CI variables)'
  if (key.endsWith('_B64')) return 'a secret CI variable'
  if (SECRET_WORD.test(key)) return 'named like a secret'
  if (RESERVED.has(key)) return 'reserved for the process or the deploy job'
  if (key.startsWith('NODE_') && key !== 'NODE_ENV') return 'changes the Node runtime'
  if (key.startsWith('NIVARO_') && !NIVARO_ALLOWED.has(key)) return 'changes how the image runs'
  for (const p of RESERVED_PREFIXES)
    if (key.startsWith(p)) return 'changes the runtime or the deploy'
  return null
}

for (const k of HUB_APP_ENV_KEYS) {
  const why = appEnvKeyRefusal(k)
  if (why) throw new Error(`HUB_APP_ENV_KEYS holds ${k}: ${why}`)
}

// ── Names ────────────────────────────────────────────────────────────────────

/** Hub app / environment key (phase 1): `^[a-z][a-z0-9-]{1,62}$`. */
const HUB_KEY = /^[a-z][a-z0-9-]{1,62}$/

/**
 * A key an app or environment may be CREATED with: a Hub key that does not end in `-` and holds
 * no `--`. Non-production names are `<app>--<env>`, so with no `--` inside a key every name
 * splits one way (app `a-b` production = `a-b`, app `a` env `b` = `a--b`).
 */
export function isCreatableKey(v: unknown): v is string {
  return typeof v === 'string' && HUB_KEY.test(v) && !v.endsWith('-') && !v.includes('--')
}

/** The label an automatic name starts with: `<app>` for production, else `<app>--<env>`. */
export function hostLabelFor(appKey: string, envKey: string): string {
  return envKey === 'production' ? appKey : `${appKey}--${envKey}`
}

type HostnameResult =
  | { ok: true; hostname: string }
  | {
      ok: false
      code: 'HOSTNAME_REQUIRED' | 'HOSTNAME_INVALID' | 'HOSTNAME_OUTSIDE_WILDCARD'
      message: string
    }

const invalid = (message: string): HostnameResult => ({
  ok: false,
  code: 'HOSTNAME_INVALID',
  message
})

/** Lower-cased, trailing dot dropped; null unless every label is a DNS label (≤ 253 in all). */
function normaliseHost(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const h = raw.trim().toLowerCase().replace(/\.$/, '')
  if (!h || h.length > 253 || isIP(h) || isIP(h.replace(/^\[|\]$/g, ''))) return null
  const labels = h.split('.')
  if (labels.length < 2) return null
  if (!labels.every((l) => DNS_LABEL.test(l))) return null
  // all-numeric top label = an address, not a name
  if (/^\d+$/.test(labels[labels.length - 1])) return null
  return h
}

const httpHost = (host: string) => httpAllowed(host)

/**
 * The hostname of an environment. Automatic targets build it from the validated keys and the
 * wildcard (production = `<app>.<wildcard>`, others `<app>--<env>.<wildcard>`); a given name must
 * sit directly under the wildcard. Manual targets need a given name (under the wildcard too, when
 * the target names one). Plain-http targets serve only localhost / .test names: the Hub link
 * token is sent to this address.
 */
export function hostnameFor(
  target: HubTargetConfig,
  appKey: string,
  envKey: string,
  given?: string | null
): HostnameResult {
  if (!isCreatableKey(appKey) || !isCreatableKey(envKey))
    return invalid(
      'App and environment keys must be lower-case letters, digits and single dashes (no "--").'
    )
  if (!target || typeof target !== 'object') return invalid('The target has no settings.')
  const suffix = dnsSuffix(target.wildcard_domain)
  const givenText = typeof given === 'string' ? given.trim() : ''

  let host: string
  if (givenText) {
    const h = normaliseHost(givenText)
    if (!h) return invalid(`"${givenText.slice(0, 80)}" is not a hostname like app.example.com.`)
    host = h
    if (suffix) {
      const under = host.endsWith(`.${suffix}`)
      const direct = under && !host.slice(0, -suffix.length - 1).includes('.')
      if (target.dns_mode === 'automatic' ? !direct : !under) {
        return {
          ok: false,
          code: 'HOSTNAME_OUTSIDE_WILDCARD',
          message:
            target.dns_mode === 'automatic'
              ? `The name must be one label directly under ${suffix}.`
              : `The name must end in .${suffix}.`
        }
      }
    }
  } else if (target.dns_mode === 'manual') {
    return {
      ok: false,
      code: 'HOSTNAME_REQUIRED',
      message: 'This target makes names by hand: enter the hostname for this environment.'
    }
  } else {
    if (!suffix) return invalid('The target has no wildcard domain to make names under.')
    const label = hostLabelFor(appKey, envKey)
    if (label.startsWith('xn--')) return invalid('A name may not start with xn-- (punycode).')
    if (!DNS_LABEL.test(label))
      return invalid(
        `"${label.slice(0, 80)}…" is longer than a DNS label (63 characters): enter a hostname.`
      )
    host = `${label}.${suffix}`
    if (host.length > 253) return invalid('The hostname is longer than 253 characters.')
  }

  if (target.scheme === 'http' && !httpHost(host))
    return invalid('Plain http is only allowed for localhost and .test names.')
  return { ok: true, hostname: host }
}

/** scheme://host[:port] (the default port of the scheme is left out). */
export function baseUrlFor(target: HubTargetConfig, hostname: string): string {
  if (!target || typeof target !== 'object') throw new AppConfigError('The target has no settings.')
  const host = normaliseHost(hostname)
  if (!host || host !== hostname) throw new AppConfigError('Not a hostname.')
  if (target.scheme !== 'https' && target.scheme !== 'http')
    throw new AppConfigError('The target scheme must be https or http.')
  if (target.scheme === 'http' && !httpHost(host))
    throw new AppConfigError('Plain http is only allowed for localhost and .test names.')
  if (
    target.port != null &&
    (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535)
  )
    throw new AppConfigError('The target port must be a whole number from 1 to 65535.')
  const defaultPort = target.scheme === 'https' ? 443 : 80
  const port = target.port != null && target.port !== defaultPort ? `:${target.port}` : ''
  return `${target.scheme}://${host}${port}`
}

export function redirectUriFor(baseUrl: string): string {
  if (typeof baseUrl !== 'string') throw new AppConfigError('The base URL must be text.')
  return `${baseUrl.replace(/\/+$/, '')}/api/auth/callback`
}

/**
 * `<app>--<env>` (keys hold no `--`, so app `ab-cd`/env `ef` and app `ab`/env `cd-ef` differ);
 * past STACK_NAME_MAX it keeps (max - 5) chars, trailing dashes dropped, + `-` + 4 hex of sha1
 * of the full name. Twin: deploy.sh and nivaro-hub-deploy compute the same name.
 */
export function stackName(appKey: string, envKey: string): string {
  if (!isCreatableKey(appKey) || !isCreatableKey(envKey))
    throw new AppConfigError('App and environment keys must be creatable Hub keys.')
  const name = `${appKey}--${envKey}`
  if (name.length <= STACK_NAME_MAX) return name
  const hash = createHash('sha1').update(name).digest('hex').slice(0, 4)
  return `${name.slice(0, STACK_NAME_MAX - 5).replace(/-+$/, '')}-${hash}`
}

export function nivaroEnvironmentFor(
  envKey: string
): 'production' | 'staging' | 'development' | 'test' | 'other' {
  if (typeof envKey !== 'string') throw new AppConfigError('The environment key must be text.')
  const k = envKey.toLowerCase()
  if (['production', 'prod', 'prd', 'live'].includes(k)) return 'production'
  if (['staging', 'stage', 'stg', 'preprod', 'pre-prod', 'uat'].includes(k)) return 'staging'
  if (['development', 'develop', 'dev'].includes(k)) return 'development'
  if (['test', 'testing', 'qa'].includes(k)) return 'test'
  return 'other'
}

/** The DNS + certificate request for a manual-name environment, ready to paste into a ticket. */
export function manualTicket(target: HubTargetConfig, hostname: string): string {
  if (!target || typeof target !== 'object' || normaliseHost(hostname) !== hostname)
    throw new AppConfigError('A ticket needs the target and a normalised hostname.')
  const lines = [
    `Please create the DNS name ${hostname}`,
    target.edge_address
      ? `pointing at the edge (load balancer / reverse proxy): ${target.edge_address}.`
      : 'pointing at the edge (load balancer / reverse proxy) that serves our Docker swarm.'
  ]
  if (target.scheme === 'https')
    lines.push(`The edge needs a TLS certificate that covers ${hostname}.`)
  lines.push(
    `Requests for ${hostname} go to the swarm's Traefik, which routes them by name to the app.`
  )
  if (target.cert_note) lines.push('', target.cert_note)
  return lines.join('\n')
}

// ── .hub/app.env ─────────────────────────────────────────────────────────────

const ENGINES: readonly HubDbEngine[] = ['mssql', 'pg', 'mysql2', 'mariadb']

/** One line of printable text: no line break, NUL or other control character. */
function safeValue(key: string, v: unknown, max = 2000): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters
  if (typeof v !== 'string' || !v || v.length > max || /[\u0000-\u001f\u007f]/.test(v))
    throw new AppConfigError(`${key} must be one line of text.`)
  return v
}

/** An http(s) origin; plain http only for localhost / .test names. */
function originSetting(key: string, raw: unknown): string {
  let u: URL
  try {
    u = new URL(safeValue(key, raw))
  } catch {
    throw new AppConfigError(`${key} must be a URL.`)
  }
  if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== '/'))
    throw new AppConfigError(`${key} must be an origin like https://hub.example.com.`)
  if (u.protocol === 'https:') return u.origin
  if (u.protocol === 'http:' && (httpHost(u.hostname) || u.hostname === '127.0.0.1'))
    return u.origin
  throw new AppConfigError(`${key} must be https (http only for localhost and .test).`)
}

function issuerSetting(raw: unknown): string {
  let u: URL
  try {
    u = new URL(safeValue('OIDC_ISSUER', raw, 500))
  } catch {
    throw new AppConfigError('OIDC_ISSUER must be a URL.')
  }
  if (u.username || u.password || u.hash) throw new AppConfigError('OIDC_ISSUER must be a URL.')
  if (u.protocol === 'https:' || (u.protocol === 'http:' && httpHost(u.hostname)))
    return String(raw).trim()
  throw new AppConfigError('OIDC_ISSUER must be an https URL.')
}

/**
 * `.hub/app.env` for one environment: `KEY=value` lines sorted by key, one per
 * HUB_APP_ENV_KEYS entry, no secrets. Values are one printable line each (a line break would let
 * a value add a key); the deploy script reads the text verbatim after the first `=`.
 */
export function renderAppEnv(o: {
  app: { key: string; oidc: { issuer: string; client_id: string } }
  envKey: string
  hostname: string
  baseUrl: string
  hubUrl: string
  engine: HubDbEngine
  target: HubTargetConfig
}): string {
  if (!o || typeof o !== 'object' || !o.app || typeof o.app !== 'object' || !o.app.oidc)
    throw new AppConfigError('The app settings are missing.')
  for (const [k, v] of [
    ['app key', o.app.key],
    ['environment key', o.envKey],
    ['hostname', o.hostname],
    ['base URL', o.baseUrl],
    ['Hub URL', o.hubUrl],
    ['OIDC issuer', o.app.oidc.issuer],
    ['OIDC client id', o.app.oidc.client_id]
  ] as const) {
    if (typeof v !== 'string') throw new AppConfigError(`The ${k} must be text.`)
  }
  const named = hostnameFor(o.target, o.app.key, o.envKey, o.hostname)
  if (!named.ok) throw new AppConfigError(named.message)
  if (named.hostname !== o.hostname) throw new AppConfigError('The hostname is not normalised.')
  const base = baseUrlFor(o.target, o.hostname)
  if (o.baseUrl.replace(/\/+$/, '') !== base)
    throw new AppConfigError('The base URL does not match the hostname.')
  if (!ENGINES.includes(o.engine)) throw new AppConfigError('Unknown database engine.')
  const clientId = safeValue('OIDC_CLIENT_ID', o.app.oidc.client_id.trim(), 200)
  if (/\s/.test(clientId)) throw new AppConfigError('OIDC_CLIENT_ID must not contain spaces.')
  const network = o.target.proxy_network
  if (typeof network !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(network))
    throw new AppConfigError('The target proxy network is not a Docker network name.')

  const values: Record<string, string> = {
    APP_KEY: o.app.key,
    ENV_KEY: o.envKey,
    STACK_NAME: stackName(o.app.key, o.envKey),
    APP_HOSTS: o.hostname,
    PUBLIC_URL: base,
    ADMIN_URL: base,
    HUB_URL: originSetting('HUB_URL', o.hubUrl),
    NIVARO_ENVIRONMENT: nivaroEnvironmentFor(o.envKey),
    DB_CLIENT: o.engine,
    OIDC_ISSUER: issuerSetting(o.app.oidc.issuer),
    OIDC_CLIENT_ID: clientId,
    OIDC_REDIRECT_URI: redirectUriFor(base),
    PROXY_NETWORK: network,
    // One hop: the swarm's Traefik. Trusting the whole chain would let a client set its address.
    TRUST_PROXY: '1'
  }

  const keys = Object.keys(values).sort()
  const expected = [...HUB_APP_ENV_KEYS].sort()
  if (keys.join() !== expected.join())
    throw new Error('renderAppEnv out of step with HUB_APP_ENV_KEYS')
  const lines = [
    '# Written by the Nivaro Hub. Settings only: secrets are masked CI variables, never here.',
    '# The deploy job reads exactly these keys; any other line stops the deploy.'
  ]
  for (const k of keys) lines.push(`${k}=${safeValue(k, values[k])}`)
  return `${lines.join('\n')}\n`
}

// ── the app repository's CI and project variables ────────────────────────────

/** The deploy job's file inside the template project (included at the target's pinned ref). */
export const HUB_DEPLOY_CI_FILE = 'ci/deploy.yml'

const GITLAB_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/
/** A full commit sha or a version tag (v1, v1.2, 1.2.3-rc1, v2.0.0.1). Twin of validTemplateRef. */
const PINNED_REF = /^([0-9a-f]{40}|v?\d+(\.\d+){0,3}([-.][a-z0-9]+)?)$/

/**
 * The app repository's whole `.gitlab-ci.yml`: it only includes the deploy job from the
 * Hub-owned template project at the target's pinned ref. A fallback only: the boundary is the
 * project's ci_config_path (ciConfigPath), which makes GitLab ignore this file — a pusher could
 * otherwise override the included job here.
 */
export function renderAppCi(target: HubTargetConfig): string {
  if (!target || typeof target !== 'object') throw new AppConfigError('The target has no settings.')
  const project = target.template_project
  const ref = target.template_ref
  if (typeof project !== 'string' || !GITLAB_PATH.test(project) || project.length > 255)
    throw new AppConfigError('The target template project is not a GitLab path.')
  // include: project and ci_config_path need the full path; GitLab does not resolve an id there.
  if (!project.includes('/'))
    throw new AppConfigError(
      'The target template project must be its namespace/project path (not a numeric id) for the CI configuration path.'
    )
  if (typeof ref !== 'string' || !PINNED_REF.test(ref))
    throw new AppConfigError('The target template ref is not a tag or commit sha.')
  return [
    '# Written by the Nivaro Hub. The deploy job comes from the Hub-owned template at a pinned',
    '# ref; changing this file does not change what may run on the swarm manager.',
    'include:',
    `  - project: '${project}'`,
    `    ref: '${ref}'`,
    `    file: '/${HUB_DEPLOY_CI_FILE}'`,
    ''
  ].join('\n')
}

/**
 * The app project's CI configuration path (MANDATORY, set by the Hub at fork): the deploy job is
 * read from the Hub-owned template at the pinned ref, never from the app repository, whose own
 * `.gitlab-ci.yml` (renderAppCi) is then only a fallback.
 */
export function ciConfigPath(target: HubTargetConfig): string {
  renderAppCi(target) // same checks on project and ref
  return `${HUB_DEPLOY_CI_FILE}@${target.template_project}:${target.template_ref}`
}

export interface DeployProjectVariable {
  key: string
  value: string
  scope: '*'
  masked: boolean
  protected: boolean
}

/**
 * Project CI variables every app repository of `target` gets (all environments, protected):
 * DEPLOY_HOST (the manager, an ssh destination), DEPLOY_KNOWN_HOSTS (the manager's host keys,
 * base64 so GitLab can mask it; the deploy job refuses to connect without it), HUB_HOST_SUFFIX
 * (the wildcard: every hostname must end in it) and HUB_PIN_FILE when it is not the default.
 */
export function deployProjectVariables(target: HubTargetConfig): DeployProjectVariable[] {
  if (!target || typeof target !== 'object') throw new AppConfigError('The target has no settings.')
  const host = target.deploy_host
  if (
    typeof host !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*(@[A-Za-z0-9.-]+)?(:\d+)?$/.test(host)
  )
    throw new AppConfigError('The target deploy host is not host, user@host or host:port.')
  const known = target.manager_known_hosts
  if (typeof known !== 'string' || !known.trim())
    throw new AppConfigError('The target has no manager host keys (manager_known_hosts).')
  const out: DeployProjectVariable[] = [
    { key: 'DEPLOY_HOST', value: host, scope: '*', masked: false, protected: true },
    {
      key: 'DEPLOY_KNOWN_HOSTS',
      value: Buffer.from(`${known.trim()}\n`).toString('base64'),
      scope: '*',
      masked: true,
      protected: true
    }
  ]
  const suffix = dnsSuffix(target.wildcard_domain)
  if (target.dns_mode === 'automatic' && !suffix)
    throw new AppConfigError('An automatic target needs its wildcard domain.')
  if (suffix)
    out.push({ key: 'HUB_HOST_SUFFIX', value: suffix, scope: '*', masked: false, protected: true })
  if (target.pin_file && target.pin_file !== '.hub/nivaro-version')
    out.push({
      key: 'HUB_PIN_FILE',
      value: target.pin_file,
      scope: '*',
      masked: false,
      protected: true
    })
  return out
}

/**
 * The Hub's own hostnames (from its PUBLIC_URL, ADMIN_URL, HUB_URL …): a created environment
 * may never take one. Task 8's takenHostnames / HOSTNAME_TAKEN adds these to the names other
 * environments hold. Lower case, de-duplicated; unparsable or empty values are skipped.
 */
export function hubOwnHostnames(urls: ReadonlyArray<string | null | undefined>): string[] {
  const out = new Set<string>()
  for (const raw of urls) {
    if (typeof raw !== 'string' || !raw.trim()) continue
    try {
      const h = new URL(raw.trim()).hostname.toLowerCase().replace(/\.$/, '')
      if (h) out.add(h)
    } catch {
      // not a URL: nothing to reserve
    }
  }
  return [...out]
}
