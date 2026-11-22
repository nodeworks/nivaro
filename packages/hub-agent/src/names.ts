// Names the agent gives to swarm objects, the ownership labels it stamps on
// them and the spec hash. Pure: no I/O.
import { createHash, createHmac } from 'node:crypto'
import type { StackSpec } from './spec.js'

/** A stack name: also the prefix of every object the agent creates for it. */
export const STACK_NAME_RE = /^[a-z][a-z0-9-]{1,40}$/

/** Env and secret keys (also the file name under /run/secrets). */
export const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/

/** Swarm caps secret (and config) names at 64 characters. */
export const SECRET_NAME_MAX = 64

export function isStackName(name: unknown): name is string {
  return typeof name === 'string' && STACK_NAME_RE.test(name)
}

function hmac12(hmacKey: string, parts: string[]): string {
  return createHmac('sha256', hmacKey).update(parts.join('\0')).digest('hex').slice(0, 12)
}

/**
 * `nvh_<stack>_<KEY>_<hmac12>`. Swarm secrets are immutable, so a changed
 * value needs a new name; the hmac (keyed, bound to stack + key) changes with
 * the value without fingerprinting it. Over 64 characters the KEY is
 * truncated, never the hmac.
 */
export function secretName(stack: string, key: string, value: string, hmacKey: string): string {
  if (!isStackName(stack)) throw new Error('secretName: bad stack name')
  if (!ENV_KEY_RE.test(key)) throw new Error('secretName: bad key')
  const mac = hmac12(hmacKey, ['secret', stack, key, value])
  const fixed = `nvh_${stack}__${mac}`.length
  return `nvh_${stack}_${key.slice(0, SECRET_NAME_MAX - fixed)}_${mac}`
}

/** What a secret value becomes inside the spec hash. */
function secretDigest(key: string, value: string, hmacKey: string): string {
  return hmac12(hmacKey, ['spec', key, value])
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(value as object).sort()) {
      const v = (value as Record<string, unknown>)[k]
      if (v !== undefined) out[k] = canonical(v)
    }
    return out
  }
  return value
}

/** The exact text the spec hash is taken over: secret values replaced by their hmac12. */
export function specHashInput(spec: StackSpec, hmacKey: string): string {
  const secrets: Record<string, string> = {}
  for (const [k, v] of Object.entries(spec.secrets)) secrets[k] = secretDigest(k, v, hmacKey)
  return JSON.stringify(canonical({ ...spec, secrets }))
}

/** sha256 hex of the canonical spec; a secret change changes it, it reveals no secret. */
export function specHash(spec: StackSpec, hmacKey: string): string {
  return createHash('sha256').update(specHashInput(spec, hmacKey)).digest('hex')
}

// ── Ownership (Decision 4) ──────────────────────────────────────────────

export const LABEL_MANAGED = 'nivaro.hub.managed'
export const LABEL_NAMESPACE = 'com.docker.stack.namespace'
export const LABEL_APP = 'nivaro.hub.app'
export const LABEL_SHARED = 'nivaro.hub.shared'
export const LABEL_ENV = 'nivaro.hub.env'
export const LABEL_SPEC_HASH = 'nivaro.hub.spec-hash'
export const LABEL_ROLE = 'nivaro.hub.role'

/** The labels every object of a stack carries. Built only from validated fields. */
export function ownershipLabels(stack: string, spec: StackSpec): Record<string, string> {
  if (!isStackName(stack)) throw new Error('ownershipLabels: bad stack name')
  const owner: Record<string, string> =
    'app' in spec.owner ? { [LABEL_APP]: spec.owner.app } : { [LABEL_SHARED]: spec.owner.shared }
  return {
    [LABEL_MANAGED]: '1',
    [LABEL_NAMESPACE]: stack,
    ...owner,
    [LABEL_ENV]: spec.environment
  }
}

export const serviceName = (stack: string, role: string) => `${stack}_${role}`
export const uploadsVolume = (stack: string) => `nvh_${stack}_uploads`
export const redisVolume = (stack: string) => `nvh_${stack}_redis`
