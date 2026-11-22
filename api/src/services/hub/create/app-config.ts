// What a created app's deploy repository is told (phase 3, decisions 7–9): the non-secret
// settings committed as `.hub/app.env`, the hostname and base URL of each environment, the
// manual DNS ticket, and the names of the secret CI variables. Pure functions, no I/O.
//
// `.hub/app.env` is committed to a repository, so it never holds a secret: secrets travel only
// as masked, base64-wrapped GitLab CI variables (HUB_APP_SECRET_VARS). It also never holds a
// key that changes the runtime or the user the app runs as (appEnvKeyRefusal) — the template's
// deploy script reads exactly HUB_APP_ENV_KEYS from it and refuses every other line.
//
// Twins: deploy/hub-app-template/scripts/deploy.sh (APP_ENV_KEYS, secret names) and
// deploy/hub-app-template/docker-stack.yml (one ${KEY} per setting, one secret per variable).
// hub-app-template.test.ts keeps them in step.

import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import type { HubDbEngine } from '../db/connection.js'
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
const DNS_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/

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

/** A DNS suffix as targets.ts stores it (lower case, no `*.`, no trailing dot), or null. */
function suffixOf(raw: string | null | undefined): string | null {
  if (!raw) return null
  const s = raw.trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '')
  return s?.split('.').every((l) => DNS_LABEL.test(l)) ? s : null
}

/** Lower-cased, trailing dot dropped; null unless every label is a DNS label (≤ 253 in all). */
function normaliseHost(raw: string): string | null {
  const h = raw.trim().toLowerCase().replace(/\.$/, '')
  if (!h || h.length > 253 || isIP(h) || isIP(h.replace(/^\[|\]$/g, ''))) return null
  const labels = h.split('.')
  if (labels.length < 2) return null
  if (!labels.every((l) => DNS_LABEL.test(l))) return null
  // all-numeric top label = an address, not a name
  if (/^\d+$/.test(labels[labels.length - 1])) return null
  return h
}

/** True for `localhost`, `*.localhost`, `test` and `*.test` — the names plain http may use. */
function httpHost(host: string): boolean {
  return (
    host === 'localhost' || host.endsWith('.localhost') || host === 'test' || host.endsWith('.test')
  )
}

/**
 * The hostname of an environment. Automatic targets build it from the validated keys and the
 * wildcard (production = `<app>.<wildcard>`, others `<app>-<env>.<wildcard>`); a given name must
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
  if (
    !HUB_KEY.test(appKey) ||
    !HUB_KEY.test(envKey) ||
    appKey.endsWith('-') ||
    envKey.endsWith('-')
  )
    return invalid('App and environment keys must be lower-case letters, digits and dashes.')
  const suffix = suffixOf(target.wildcard_domain)
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
    const label = envKey === 'production' ? appKey : `${appKey}-${envKey}`
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
  const host = normaliseHost(hostname)
  if (!host || host !== hostname) throw new AppConfigError('Not a hostname.')
  if (target.scheme !== 'https' && target.scheme !== 'http')
    throw new AppConfigError('The target scheme must be https or http.')
  if (target.scheme === 'http' && !httpHost(host))
    throw new AppConfigError('Plain http is only allowed for localhost and .test names.')
  const defaultPort = target.scheme === 'https' ? 443 : 80
  const port = target.port != null && target.port !== defaultPort ? `:${target.port}` : ''
  return `${target.scheme}://${host}${port}`
}

export function redirectUriFor(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/api/auth/callback`
}

/** `<app>-<env>`; past STACK_NAME_MAX it keeps (max - 5) chars + `-` + 4 hex of sha1. */
export function stackName(appKey: string, envKey: string): string {
  const name = `${appKey}-${envKey}`
  if (name.length <= STACK_NAME_MAX) return name
  const hash = createHash('sha1').update(name).digest('hex').slice(0, 4)
  return `${name.slice(0, STACK_NAME_MAX - 5).replace(/-+$/, '')}-${hash}`
}

export function nivaroEnvironmentFor(
  envKey: string
): 'production' | 'staging' | 'development' | 'test' | 'other' {
  const k = envKey.toLowerCase()
  if (['production', 'prod', 'prd', 'live'].includes(k)) return 'production'
  if (['staging', 'stage', 'stg', 'preprod', 'pre-prod', 'uat'].includes(k)) return 'staging'
  if (['development', 'develop', 'dev'].includes(k)) return 'development'
  if (['test', 'testing', 'qa'].includes(k)) return 'test'
  return 'other'
}

/** The DNS + certificate request for a manual-name environment, ready to paste into a ticket. */
export function manualTicket(target: HubTargetConfig, hostname: string): string {
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
function safeValue(key: string, v: string, max = 2000): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters
  if (typeof v !== 'string' || !v || v.length > max || /[\u0000-\u001f\u007f]/.test(v))
    throw new AppConfigError(`${key} must be one line of text.`)
  return v
}

/** An http(s) origin; plain http only for localhost / .test names. */
function originSetting(key: string, raw: string): string {
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

function issuerSetting(raw: string): string {
  let u: URL
  try {
    u = new URL(safeValue('OIDC_ISSUER', raw, 500))
  } catch {
    throw new AppConfigError('OIDC_ISSUER must be a URL.')
  }
  if (u.username || u.password || u.hash) throw new AppConfigError('OIDC_ISSUER must be a URL.')
  if (u.protocol === 'https:' || (u.protocol === 'http:' && httpHost(u.hostname))) return raw.trim()
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
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(network))
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
