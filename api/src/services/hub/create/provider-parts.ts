// Task 11a (Hub providers): the provider parts Create app makes per environment — shapes, checks
// and plan words. Pure (the planner imports it); the step that makes them is provider-step.ts.
import { EDGE_TLS_CERT_KEY, EDGE_TLS_KEY_KEY } from '../docker/edge-tls.js'
import { redirectUriFor } from './app-config.js'

/** The part types Create app offers per environment. */
export const CREATE_PROVIDER_TYPES = [
  'vercel.project',
  'auth0.application',
  'aws.route53_record',
  'aws.rds_instance',
  // Task 33 (Wave 2): an Entra app registration (+ its client secret) that replaces the manual
  // sign-in step, a managed Redis, a Sentry project, an Anthropic workspace.
  'entra.app_registration',
  'upstash.redis_database',
  'redis-cloud.database',
  'sentry.project',
  'anthropic.workspace',
  // Task 43 (Wave 3): LiveKit huddles (the pasted key pair → the app's huddle settings) and a TLS
  // certificate from an ACME CA (Docker drivers whose names are made by hand only).
  'livekit.api_key',
  'acme.certificate'
] as const
export type CreateProviderType = (typeof CREATE_PROVIDER_TYPES)[number]

export interface CreateProviderPart {
  connection_id: number
  type: CreateProviderType
  fields?: Record<string, unknown>
}

export const MAX_PROVIDER_PARTS = 6

export const ENTRA_APP_TYPE = 'entra.app_registration'
export const ENTRA_SECRET_TYPE = 'entra.client_secret'
/** Parts whose outputs are bound to the environment's Docker stack (Docker creations only). */
export const STACK_BOUND_TYPES: readonly CreateProviderType[] = [
  'entra.app_registration',
  'upstash.redis_database',
  'redis-cloud.database'
]
export const REDIS_PART_TYPES: readonly CreateProviderType[] = [
  'upstash.redis_database',
  'redis-cloud.database'
]

/**
 * Where a part's outputs go on the environment's stack (Task 33): the Entra app's client id and
 * secret are the stack's sign-in (OIDC_CLIENT_ID / OIDC_CLIENT_SECRET); a managed Redis's URL is
 * the stack's REDIS_URL (a secret: it carries the password). `resource` names which made resource
 * holds the output (`secret` = the Entra client secret made beside the app registration).
 */
export const PART_BINDINGS: Partial<
  Record<
    CreateProviderType,
    Array<{
      resource: 'part' | 'secret'
      output_key: string
      target: 'stack_setting' | 'stack_secret'
      target_key: string
    }>
  >
> = {
  'entra.app_registration': [
    {
      resource: 'part',
      output_key: 'client_id',
      target: 'stack_setting',
      target_key: 'OIDC_CLIENT_ID'
    },
    {
      resource: 'secret',
      output_key: 'client_secret',
      target: 'stack_secret',
      target_key: 'OIDC_CLIENT_SECRET'
    }
  ],
  'upstash.redis_database': [
    { resource: 'part', output_key: 'redis_url', target: 'stack_secret', target_key: 'REDIS_URL' }
  ],
  'redis-cloud.database': [
    { resource: 'part', output_key: 'redis_url', target: 'stack_secret', target_key: 'REDIS_URL' }
  ],
  // Gap G-D: the certificate Traefik serves for the environment's name (agent 0.2.5): the stack
  // secrets the renderer sends as the spec's `edge_tls` (docker/edge-tls.ts), never to the app.
  'acme.certificate': [
    {
      resource: 'part',
      output_key: 'fullchain',
      target: 'stack_secret',
      target_key: EDGE_TLS_CERT_KEY
    },
    {
      resource: 'part',
      output_key: 'private_key',
      target: 'stack_secret',
      target_key: EDGE_TLS_KEY_KEY
    }
  ]
}

/** The Entra client secret made beside an app registration part (same connection, same change). */
export function entraSecretFields(appKey: string, envKey: string): Record<string, unknown> {
  return { name: `nivaro-${appKey}-${envKey}`.slice(0, 120), valid_months: 12 }
}

/** The sign-in issuer of an Entra tenant (a tenant id or verified domain), or null. */
export function entraIssuerOf(tenant: unknown): string | null {
  const t = typeof tenant === 'string' ? tenant.trim() : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(t)) return null
  return `https://login.microsoftonline.com/${t}/v2.0`
}

/**
 * What the plan refuses about one environment's parts beyond their shape (Task 33): parts bound
 * to a stack need a Docker creation; a managed Redis needs the stack's Redis set to external; at
 * most one Entra app registration and one Redis per environment.
 */
export function partsProblem(
  parts: CreateProviderPart[],
  o: { kind: string; stackRedis: string | null }
): string | null {
  const bound = parts.filter((p) => STACK_BOUND_TYPES.includes(p.type))
  if (bound.length && o.kind !== 'docker')
    return 'An Entra app registration or a managed Redis is bound to the environment’s stack: pick a Docker driver to use one.'
  if (parts.filter((p) => p.type === ENTRA_APP_TYPE).length > 1)
    return 'One Entra app registration per environment.'
  const redis = parts.filter((p) => REDIS_PART_TYPES.includes(p.type))
  if (redis.length > 1) return 'One managed Redis per environment.'
  if (redis.length && o.stackRedis !== 'external')
    return 'A managed Redis needs the stack’s Redis set to external (the Hub fills REDIS_URL).'
  return null
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

/** The request's parts of one environment, checked (shape only); a refusal text when bad. */
export function providerPartsOf(
  raw: unknown
): { ok: true; parts: CreateProviderPart[] } | { ok: false; text: string } {
  if (raw === undefined || raw === null) return { ok: true, parts: [] }
  if (!Array.isArray(raw)) return { ok: false, text: 'providers must be a list.' }
  if (raw.length > MAX_PROVIDER_PARTS)
    return { ok: false, text: `At most ${MAX_PROVIDER_PARTS} provider parts per environment.` }
  const parts: CreateProviderPart[] = []
  for (const [i, p] of raw.entries()) {
    if (!isRecord(p)) return { ok: false, text: `Provider part ${i + 1} must be an object.` }
    const conn = p.connection_id
    if (typeof conn !== 'number' || !Number.isSafeInteger(conn) || conn < 1)
      return { ok: false, text: `Provider part ${i + 1} needs connection_id.` }
    if (!(CREATE_PROVIDER_TYPES as readonly unknown[]).includes(p.type))
      return {
        ok: false,
        text: `Provider part ${i + 1}: type must be one of ${CREATE_PROVIDER_TYPES.join(', ')}.`
      }
    if (p.fields !== undefined && !isRecord(p.fields))
      return { ok: false, text: `Provider part ${i + 1}: fields must be an object.` }
    parts.push({
      connection_id: conn,
      type: p.type as CreateProviderType,
      ...(p.fields ? { fields: p.fields as Record<string, unknown> } : {})
    })
  }
  return { ok: true, parts }
}

/** A part in plain words for the plan (never a field value). */
export function partLine(envKey: string, p: CreateProviderPart): string {
  const n = partName(p)
  const name = n ? ` ${n}` : ''
  const what: Record<CreateProviderType, string> = {
    'vercel.project': 'a Vercel project',
    'auth0.application': 'an Auth0 application (sign-in addresses from the environment)',
    'aws.route53_record': 'a Route 53 record',
    'aws.rds_instance': 'an RDS instance (link it as a database server once it is available)',
    'entra.app_registration':
      'an Entra app registration and its client secret (the stack signs in with them: OIDC_CLIENT_ID, OIDC_CLIENT_SECRET)',
    'upstash.redis_database': 'an Upstash Redis database (the stack’s REDIS_URL)',
    'redis-cloud.database': 'a Redis Cloud database (the stack’s REDIS_URL)',
    'sentry.project': 'a Sentry project (each promotion records a release on it)',
    'anthropic.workspace': 'an Anthropic workspace',
    'livekit.api_key':
      'a LiveKit Cloud key (the huddle settings are filled from it once the app answers)',
    'acme.certificate':
      'a TLS certificate from an ACME CA for the environment name (Traefik cannot get one on its own for a name made by hand; the Hub agent serves it, EDGE_TLS_CERT / EDGE_TLS_KEY)'
  }
  return `${envKey}: ${what[p.type]}${name} through connection #${p.connection_id}`
}

/** A part's own name (its type's name field), never a secret value. */
export function partName(p: CreateProviderPart): string | null {
  const v = p.type === 'livekit.api_key' ? p.fields?.api_key : p.fields?.name
  return typeof v === 'string' && v ? v : null
}

/**
 * Task 43: the bindings a made part gets by default (output → destination), so nobody copies a
 * key: a LiveKit key fills the app's huddle settings (allow-listed app settings, pushed over the
 * hub link once the app answers). An ACME certificate's are stack bindings (PART_BINDINGS: its
 * chain and key → EDGE_TLS_CERT / EDGE_TLS_KEY, which the agent serves through Traefik).
 */
export function partBindings(
  type: CreateProviderType
): Array<{ output_key: string; target: 'app_setting'; target_key: string }> {
  if (type === 'livekit.api_key')
    return [
      { output_key: 'url', target: 'app_setting', target_key: 'huddle_livekit_url' },
      { output_key: 'api_key', target: 'app_setting', target_key: 'huddle_livekit_key' },
      { output_key: 'api_secret', target: 'app_setting', target_key: 'huddle_livekit_secret' }
    ]
  return []
}

/** The fields one part is created with (Auth0 addresses from the environment when left out). */
export function partFields(p: CreateProviderPart, baseUrl: string): Record<string, unknown> {
  const f = { ...(p.fields ?? {}) }
  if (p.type === 'acme.certificate') {
    // The environment's own name when the request names none.
    let host = ''
    try {
      host = new URL(baseUrl).hostname
    } catch {
      host = ''
    }
    if (f.names === undefined && host) f.names = [host]
    if (f.name === undefined && host) f.name = host
  }
  if (p.type === 'auth0.application') {
    const base = baseUrl.replace(/\/+$/, '')
    if (f.callbacks === undefined) f.callbacks = [redirectUriFor(base)]
    if (f.allowed_logout_urls === undefined) f.allowed_logout_urls = [base]
    if (f.web_origins === undefined) f.web_origins = [base]
    if (f.allowed_origins === undefined) f.allowed_origins = [base]
  }
  if (p.type === ENTRA_APP_TYPE) {
    const base = baseUrl.replace(/\/+$/, '')
    if (f.web_redirect_uris === undefined) f.web_redirect_uris = [redirectUriFor(base)]
    if (f.logout_url === undefined) f.logout_url = base
  }
  return f
}
