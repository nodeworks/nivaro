import type { ProviderAdapter, ResourceTypeSpec } from './types.js'

/**
 * The provider registry: adapter key → adapter. Core adapters register from providers/index.ts;
 * extensions through `ctx.hub.registerProvider` (Hub mode only). A key is taken once: a second
 * register of the same key is refused, never replaces the first.
 */

export type ProviderRegistryCode = 'PROVIDER_KEY_TAKEN' | 'PROVIDER_INVALID'

export class ProviderRegistryError extends Error {
  code: ProviderRegistryCode
  constructor(code: ProviderRegistryCode, message: string) {
    super(message)
    this.name = 'ProviderRegistryError'
    this.code = code
  }
}

export const PROVIDER_KEY_RE = /^[a-z][a-z0-9-]{1,30}$/
/** The part of a type key after `<provider>.`. */
export const TYPE_SUFFIX_RE = /^[a-z][a-z0-9_]{0,62}$/
const FIELD_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const FIELD_KINDS = new Set([
  'string',
  'number',
  'boolean',
  'enum',
  'list',
  'object',
  'ref',
  'secret'
])
const CAPS = ['create', 'update', 'delete', 'adopt', 'snapshot', 'tag'] as const

const providers = new Map<string, ProviderAdapter>()

function invalid(message: string): never {
  throw new ProviderRegistryError('PROVIDER_INVALID', message)
}

function checkType(adapter: ProviderAdapter, t: ResourceTypeSpec): void {
  const prefix = `${adapter.key}.`
  if (typeof t?.key !== 'string' || !t.key.startsWith(prefix))
    invalid(`Type ${String(t?.key)} must start with "${prefix}".`)
  if (!TYPE_SUFFIX_RE.test(t.key.slice(prefix.length)))
    invalid(`Type ${t.key} must be ${prefix}<lowercase_snake>.`)
  if (typeof t.label !== 'string' || !t.label.trim()) invalid(`Type ${t.key} needs a label.`)
  if (t.scope !== 'app' && t.scope !== 'shared') invalid(`Type ${t.key} scope must be app|shared.`)
  if (!Array.isArray(t.fields)) invalid(`Type ${t.key} needs a fields list.`)
  const seen = new Set<string>()
  for (const f of t.fields) {
    if (typeof f?.key !== 'string' || !FIELD_KEY_RE.test(f.key))
      invalid(`Type ${t.key} has a bad field key ${String(f?.key)}.`)
    if (seen.has(f.key)) invalid(`Type ${t.key} lists field ${f.key} twice.`)
    seen.add(f.key)
    if (!FIELD_KINDS.has(f.kind)) invalid(`Field ${t.key}.${f.key} has an unknown kind.`)
    if (f.kind === 'ref' && typeof f.refType !== 'string')
      invalid(`Ref field ${t.key}.${f.key} needs refType.`)
  }
  if (!t.capabilities || typeof t.capabilities !== 'object')
    invalid(`Type ${t.key} needs capabilities.`)
  for (const c of CAPS)
    if (typeof t.capabilities[c] !== 'boolean')
      invalid(`Type ${t.key} capability ${c} must be true or false.`)
  if (typeof t.reversible !== 'boolean' && typeof t.reversible !== 'function')
    invalid(`Type ${t.key} reversible must be a boolean or a function.`)
  if (!Array.isArray(t.refs)) invalid(`Type ${t.key} needs a refs list ([] for none).`)
  for (const r of t.refs)
    if (!seen.has(r?.field) || typeof r?.type !== 'string')
      invalid(`Type ${t.key} ref ${String(r?.field)} must name one of its fields and a type.`)
  if (typeof t.risk !== 'function') invalid(`Type ${t.key} needs a risk() function.`)
  if (t.costClass !== undefined && typeof t.costClass !== 'function')
    invalid(`Type ${t.key} costClass must be a function.`)
  if (t.estimate !== undefined && typeof t.estimate !== 'function')
    invalid(`Type ${t.key} estimate must be a function.`)
  if (t.registrar !== undefined && typeof t.registrar !== 'boolean')
    invalid(`Type ${t.key} registrar must be true or false.`)
}

function checkAdapter(adapter: ProviderAdapter): void {
  if (!adapter || typeof adapter !== 'object') invalid('A provider must be an object.')
  if (typeof adapter.key !== 'string' || !PROVIDER_KEY_RE.test(adapter.key))
    invalid(`Provider key ${String(adapter.key)} must match ${PROVIDER_KEY_RE.source}.`)
  if (typeof adapter.label !== 'string' || !adapter.label.trim())
    invalid(`Provider ${adapter.key} needs a label.`)
  const c = adapter.connection
  if (
    !c ||
    !Array.isArray(c.fields) ||
    typeof c.hosts !== 'function' ||
    typeof c.describe !== 'function'
  )
    invalid(`Provider ${adapter.key} needs connection { fields, hosts(), describe() }.`)
  for (const m of ['testConnection', 'observe', 'list', 'plan', 'apply'] as const)
    if (typeof adapter[m] !== 'function') invalid(`Provider ${adapter.key} needs ${m}().`)
  for (const m of ['snapshot', 'health', 'findExisting', 'usageNow', 'priceApi', 'costs'] as const)
    if (adapter[m] !== undefined && typeof adapter[m] !== 'function')
      invalid(`Provider ${adapter.key} ${m} must be a function.`)
  if (!Array.isArray(adapter.types) || adapter.types.length === 0)
    invalid(`Provider ${adapter.key} needs at least one resource type.`)
  const keys = new Set<string>()
  for (const t of adapter.types) {
    checkType(adapter, t)
    if (keys.has(t.key)) invalid(`Provider ${adapter.key} lists type ${t.key} twice.`)
    keys.add(t.key)
  }
}

/** Registers an adapter. Throws PROVIDER_INVALID (bad shape) or PROVIDER_KEY_TAKEN. */
export function registerProvider(adapter: ProviderAdapter): void {
  checkAdapter(adapter)
  if (providers.has(adapter.key))
    throw new ProviderRegistryError(
      'PROVIDER_KEY_TAKEN',
      `A provider with key ${adapter.key} is already registered.`
    )
  providers.set(adapter.key, adapter)
}

export function getProvider(key: string): ProviderAdapter | null {
  return providers.get(key) ?? null
}

/** Every registered adapter, in key order. */
export function listProviders(): ProviderAdapter[] {
  return [...providers.values()].sort((a, b) => a.key.localeCompare(b.key))
}

/** The adapter + type spec of a type key ('aws.vpc'); null when none is registered. */
export function findType(
  typeKey: string
): { provider: ProviderAdapter; type: ResourceTypeSpec } | null {
  const dot = typeof typeKey === 'string' ? typeKey.indexOf('.') : -1
  if (dot <= 0) return null
  const provider = providers.get(typeKey.slice(0, dot))
  const type = provider?.types.find((t) => t.key === typeKey)
  return provider && type ? { provider, type } : null
}

/** Tests only: forget every registered adapter. */
export function resetProvidersForTest(): void {
  providers.clear()
}
