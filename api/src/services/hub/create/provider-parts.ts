// Task 11a (Hub providers): the provider parts Create app makes per environment — shapes, checks
// and plan words. Pure (the planner imports it); the step that makes them is provider-step.ts.
import { redirectUriFor } from './app-config.js'

/** The part types Create app offers per environment. */
export const CREATE_PROVIDER_TYPES = [
  'vercel.project',
  'auth0.application',
  'aws.route53_record',
  'aws.rds_instance'
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
  const name = typeof p.fields?.name === 'string' ? ` ${p.fields.name}` : ''
  const what: Record<CreateProviderType, string> = {
    'vercel.project': 'a Vercel project',
    'auth0.application': 'an Auth0 application (sign-in addresses from the environment)',
    'aws.route53_record': 'a Route 53 record',
    'aws.rds_instance': 'an RDS instance (link it as a database server once it is available)'
  }
  return `${envKey}: ${what[p.type]}${name} through connection #${p.connection_id}`
}

/** The fields one part is created with (Auth0 addresses from the environment when left out). */
export function partFields(p: CreateProviderPart, baseUrl: string): Record<string, unknown> {
  const f = { ...(p.fields ?? {}) }
  if (p.type === 'auth0.application') {
    const base = baseUrl.replace(/\/+$/, '')
    if (f.callbacks === undefined) f.callbacks = [redirectUriFor(base)]
    if (f.allowed_logout_urls === undefined) f.allowed_logout_urls = [base]
    if (f.web_origins === undefined) f.web_origins = [base]
    if (f.allowed_origins === undefined) f.allowed_origins = [base]
  }
  return f
}
