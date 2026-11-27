// Task 11a (Hub providers): the provider parts Create app makes per environment — shapes, checks
// and plan words. Pure (the planner imports it); the step that makes them is provider-step.ts.
import { redirectUriFor } from './app-config.js'

/** The part types Create app offers per environment. */
export const CREATE_PROVIDER_TYPES = [
  'vercel.project',
  'auth0.application',
  'aws.route53_record',
  'aws.rds_instance',
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
    'livekit.api_key':
      'a LiveKit Cloud key (the huddle settings are filled from it once the app answers)',
    'acme.certificate':
      'a TLS certificate from an ACME CA for the environment name (Traefik cannot get one on its own for a name made by hand)'
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
 * hub link once the app answers). An ACME certificate gets none: which stack secrets the edge
 * reads them from is the operator's (docs, hub-providers-acme).
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
  return f
}
