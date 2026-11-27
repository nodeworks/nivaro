import { fieldWords, typedName } from '../plan-words.js'
import {
  type ConnectionTest,
  type DesiredResource,
  type FieldChange,
  type FieldSpec,
  type HealthAnswer,
  type ListPage,
  type Observed,
  type OpResult,
  type PlannedOp,
  type ProviderAdapter,
  type ProviderContext,
  ProviderError,
  type ResourceTypeSpec,
  type RiskFlag,
  ROTATE_OUTPUTS_FIELD
} from '../types.js'
import { modeOfKey, segment, stripeCall, stripeListAll, stripeMode } from './client.js'

/**
 * Stripe (`stripe`): a restricted key (`rk_…`, preferred) or a secret key (`sk_…`); live or test
 * mode is read from the key's prefix. Host `api.stripe.com`. The Hub only CONFIGURES Stripe:
 * products, prices, webhook endpoints, billing portal configurations and tax rates. It never
 * moves money (no charges, refunds, transfers, payouts, customers or subscriptions: client.ts
 * refuses every other path) and never deletes a product, price, tax rate or portal configuration
 * (Stripe keeps history): those are ARCHIVED. Prices and tax rates are immutable in the fields
 * that matter, so a change there is a replace: a new object is made, then the old one archived.
 *
 * Live mode: every op on a live-mode connection carries `$adminOnly` (a Hub administrator starts
 * it); test mode is open to owners. The webhook signing secret is a once-only secret output.
 *
 * External id = Stripe's id (`prod_…`, `price_…`, `we_…`, `bpc_…`, `txr_…`). The key IS the
 * account, so the connection is the pin; an object whose `livemode` disagrees with the key reads
 * as gone. Hub tags are kept in `metadata` as `nivaro-hub:<key>`.
 */

const T = {
  product: 'stripe.product',
  price: 'stripe.price',
  webhook: 'stripe.webhook_endpoint',
  portal: 'stripe.billing_portal_config',
  tax: 'stripe.tax_rate'
} as const

const TAG_PREFIX = 'nivaro-hub:'
const RESOURCE_TAG = 'nivaro-hub:resource'

// ── Small helpers ──

function norm(v: unknown): unknown {
  if (v === '' || v === undefined) return null
  if (Array.isArray(v)) return [...v].map(String).sort()
  return v
}

const same = (a: unknown, b: unknown): boolean =>
  JSON.stringify(norm(a)) === JSON.stringify(norm(b))

function diffFields(
  keys: string[],
  want: Record<string, unknown>,
  have: Record<string, unknown>
): FieldChange[] {
  const out: FieldChange[] = []
  for (const k of keys) {
    if (want[k] === undefined) continue
    if (!same(want[k], have[k])) out.push({ field: k, from: norm(have[k]), to: norm(want[k]) })
  }
  return out
}

const ok = (
  externalId: string | null,
  observed: Observed | null,
  answer?: Record<string, unknown>,
  outputs?: Record<string, string>
): OpResult => ({
  ok: true,
  externalId,
  observed,
  ...(answer ? { answer } : {}),
  ...(outputs && Object.keys(outputs).length ? { outputs } : {})
})

const bad = (msg: string) => new ProviderError('INVALID_FIELDS', msg)

function alreadyExists(what: string): ProviderError {
  return new ProviderError(
    'ALREADY_EXISTS',
    `${what} already exists at Stripe. Adopt it instead of creating it.`,
    { retryable: false }
  )
}

function tagsOf(raw: any): Record<string, string> {
  const out: Record<string, string> = {}
  const md = raw?.metadata
  if (md && typeof md === 'object')
    for (const [k, v] of Object.entries(md))
      if (k.startsWith(TAG_PREFIX) && typeof v === 'string') out[k] = v
  return out
}

const tagOf = (d: DesiredResource): string =>
  d.tags[RESOURCE_TAG] ?? (d.resourceId !== null ? String(d.resourceId) : '')

/** Metadata a create writes: the Hub's tags (bounded to Stripe's limits). */
function metadataOf(d: DesiredResource): Record<string, string> {
  const out: Record<string, string> = {}
  const all = { ...d.tags }
  if (!all[RESOURCE_TAG] && d.resourceId !== null) all[RESOURCE_TAG] = String(d.resourceId)
  for (const [k, v] of Object.entries(all))
    if (k.startsWith(TAG_PREFIX) && k.length <= 40) out[k] = String(v).slice(0, 500)
  return out
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const optStr = (v: unknown): string | null => (str(v) ? str(v) : null)

function httpsUrl(v: unknown, label: string): string {
  const s = str(v)
  let u: URL
  try {
    u = new URL(s)
  } catch {
    throw bad(`${label} is not a web address.`)
  }
  if (u.protocol !== 'https:') throw bad(`${label} must start with https://.`)
  if (u.username || u.password) throw bad(`${label} must not carry a user name or password.`)
  return u.toString()
}

// ── Per-type definitions ──

interface Def {
  type: string
  label: string
  base: string
  prefix: string
  /** What "delete" does: POST this flag to false, or a real DELETE (webhook endpoints). */
  archive: 'active' | 'delete'
  listQuery: Record<string, string>
  /** The field of the raw object that says it is live (archived = false). */
  activeKey: 'active' | 'is_active' | null
  fields: FieldSpec[]
  /** Fields a plan may change in place. */
  writable: string[]
  /** Fields whose change needs a new object (replace). */
  replaceKeys: string[]
  map(raw: any): Observed
  validate(d: DesiredResource): void
  createForm(d: DesiredResource): Record<string, unknown>
  updateForm(want: Record<string, unknown>, changed: string[]): Record<string, unknown>
  find(ctx: ProviderContext, d: DesiredResource): Promise<any | null>
  nameOf(f: Record<string, unknown>): string | null
}

const isLiveObject = (raw: any, ctx: ProviderContext): boolean => {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return false
  return raw.livemode === (stripeMode(ctx) === 'live')
}

const isActive = (def: Def, raw: any): boolean =>
  def.activeKey ? raw?.[def.activeKey] !== false : true

function observedOf(def: Def, raw: any): Observed {
  const o = def.map(raw)
  return {
    ...o,
    tags: tagsOf(raw),
    version: null,
    status: o.status ?? (isActive(def, raw) ? 'active' : 'archived'),
    url: `https://dashboard.stripe.com/${raw.livemode ? '' : 'test/'}${dashboardPath(def.type)}/${encodeURIComponent(String(raw.id))}`
  }
}

function dashboardPath(type: string): string {
  if (type === T.product) return 'products'
  if (type === T.price) return 'prices'
  if (type === T.webhook) return 'workbench/webhooks'
  if (type === T.tax) return 'tax-rates'
  return 'settings/billing/portal'
}

const INTERVALS = ['day', 'week', 'month', 'year']

const PRODUCT: Def = {
  type: T.product,
  label: 'Stripe product',
  base: '/v1/products',
  prefix: 'prod_',
  archive: 'active',
  listQuery: { active: 'true' },
  activeKey: 'active',
  nameOf: (f) => (typeof f.name === 'string' ? f.name : null),
  fields: [
    {
      key: 'name',
      label: 'Name',
      kind: 'string',
      required: true,
      help: 'Shown to customers on checkout and invoices.'
    },
    { key: 'description', label: 'Description', kind: 'string' },
    {
      key: 'active',
      label: 'Active',
      kind: 'boolean',
      default: true,
      help: 'Off = archived: it can no longer be sold, and Stripe keeps it for past charges.'
    }
  ],
  writable: ['name', 'description', 'active'],
  replaceKeys: [],
  map: (raw) => ({
    type: T.product,
    externalId: String(raw.id),
    name: raw.name ?? null,
    fields: {
      name: raw.name ?? null,
      description: raw.description ?? null,
      active: raw.active !== false
    },
    tags: {}
  }),
  validate(d) {
    const name = str(d.fields.name)
    if (!name) throw bad('The product needs a name.')
    if (name.length > 250) throw bad('The product name is too long (250 characters at most).')
  },
  createForm: (d) => ({
    name: str(d.fields.name),
    ...(optStr(d.fields.description) ? { description: str(d.fields.description) } : {}),
    ...(d.fields.active === false ? { active: false } : {}),
    metadata: metadataOf(d)
  }),
  updateForm(want, changed) {
    const f: Record<string, unknown> = {}
    for (const k of changed) {
      if (k === 'name') f.name = str(want.name)
      if (k === 'description') f.description = str(want.description)
      if (k === 'active') f.active = want.active !== false
    }
    return f
  },
  async find(ctx, d) {
    const name = str(d.fields.name)
    const all = await stripeListAll(ctx, '/v1/products', { active: 'true' })
    return all.find((p) => p?.name === name && isLiveObject(p, ctx)) ?? null
  }
}

const PRICE: Def = {
  type: T.price,
  label: 'Stripe price',
  base: '/v1/prices',
  prefix: 'price_',
  archive: 'active',
  listQuery: { active: 'true' },
  activeKey: 'active',
  nameOf: (f) => (typeof f.nickname === 'string' && f.nickname ? f.nickname : null),
  fields: [
    {
      key: 'product',
      label: 'Product',
      kind: 'ref',
      refType: T.product,
      required: true,
      createOnly: true,
      replaceOnChange: true
    },
    {
      key: 'currency',
      label: 'Currency',
      kind: 'string',
      required: true,
      createOnly: true,
      replaceOnChange: true,
      pattern: '^[a-z]{3}$',
      help: 'Three lowercase letters, e.g. usd.'
    },
    {
      key: 'unit_amount',
      label: 'Amount',
      kind: 'number',
      required: true,
      min: 0,
      replaceOnChange: true,
      help: 'In the currency’s smallest unit (cents for usd). Prices are immutable: a change makes a new price and archives the old one.'
    },
    {
      key: 'interval',
      label: 'Billing interval',
      kind: 'enum',
      default: '',
      replaceOnChange: true,
      options: [{ value: '', label: 'One time' }, ...INTERVALS.map((i) => ({ value: i, label: i }))]
    },
    {
      key: 'interval_count',
      label: 'Every how many intervals',
      kind: 'number',
      default: 1,
      min: 1,
      max: 365,
      replaceOnChange: true
    },
    { key: 'nickname', label: 'Nickname', kind: 'string' },
    {
      key: 'lookup_key',
      label: 'Lookup key',
      kind: 'string',
      help: 'A stable name code can look the price up by, so a replaced price keeps the same key.'
    },
    {
      key: 'tax_behavior',
      label: 'Tax behavior',
      kind: 'enum',
      default: 'unspecified',
      replaceOnChange: true,
      options: [
        { value: 'unspecified', label: 'Unspecified' },
        { value: 'inclusive', label: 'Inclusive' },
        { value: 'exclusive', label: 'Exclusive' }
      ]
    },
    {
      key: 'active',
      label: 'Active',
      kind: 'boolean',
      default: true,
      help: 'Off = archived. Prices are never deleted.'
    }
  ],
  writable: ['nickname', 'lookup_key', 'active'],
  replaceKeys: ['product', 'currency', 'unit_amount', 'interval', 'interval_count', 'tax_behavior'],
  map: (raw) => ({
    type: T.price,
    externalId: String(raw.id),
    name: raw.nickname ?? null,
    fields: {
      product: typeof raw.product === 'string' ? raw.product : (raw.product?.id ?? null),
      currency: raw.currency ?? null,
      unit_amount: typeof raw.unit_amount === 'number' ? raw.unit_amount : null,
      interval: raw.recurring?.interval ?? '',
      interval_count: raw.recurring ? (raw.recurring.interval_count ?? 1) : null,
      nickname: raw.nickname ?? null,
      lookup_key: raw.lookup_key ?? null,
      tax_behavior: raw.tax_behavior ?? 'unspecified',
      active: raw.active !== false
    },
    tags: {}
  }),
  validate(d) {
    if (typeof d.refs.product !== 'string' || !d.refs.product)
      throw bad('The price needs a product that exists at Stripe.')
    if (!/^[a-z]{3}$/.test(str(d.fields.currency)))
      throw bad('The currency is three lowercase letters, such as usd.')
    const amt = d.fields.unit_amount
    if (typeof amt !== 'number' || !Number.isInteger(amt) || amt < 0 || amt > 99999999)
      throw bad('The amount is a whole number in the currency’s smallest unit.')
    const interval = str(d.fields.interval)
    if (interval && !INTERVALS.includes(interval))
      throw bad('The billing interval is day, week, month, year or empty (one time).')
    const n = d.fields.interval_count
    if (
      n !== undefined &&
      n !== null &&
      (!Number.isInteger(n) || (n as number) < 1 || (n as number) > 365)
    )
      throw bad('Every how many intervals is a whole number from 1 to 365.')
  },
  createForm(d) {
    const interval = str(d.fields.interval)
    const tax = str(d.fields.tax_behavior)
    return {
      product: d.refs.product,
      currency: str(d.fields.currency),
      unit_amount: d.fields.unit_amount,
      ...(interval
        ? {
            recurring: {
              interval,
              interval_count:
                typeof d.fields.interval_count === 'number' ? d.fields.interval_count : 1
            }
          }
        : {}),
      ...(optStr(d.fields.nickname) ? { nickname: str(d.fields.nickname) } : {}),
      ...(optStr(d.fields.lookup_key) ? { lookup_key: str(d.fields.lookup_key) } : {}),
      ...(tax && tax !== 'unspecified' ? { tax_behavior: tax } : {}),
      ...(d.fields.active === false ? { active: false } : {}),
      metadata: metadataOf(d)
    }
  },
  updateForm(want, changed) {
    const f: Record<string, unknown> = {}
    for (const k of changed) {
      if (k === 'nickname') f.nickname = str(want.nickname)
      if (k === 'lookup_key') f.lookup_key = str(want.lookup_key)
      if (k === 'active') f.active = want.active !== false
    }
    return f
  },
  async find(ctx, d) {
    const key = str(d.fields.lookup_key)
    if (!key) return null
    const r = await stripeCall(ctx, 'GET', '/v1/prices', {
      query: { 'lookup_keys[]': key, limit: 10 }
    })
    const data: any[] = Array.isArray(r.body?.data) ? r.body.data : []
    return data.find((p) => isLiveObject(p, ctx)) ?? null
  }
}

const EVENT_RE = /^(\*|[a-z0-9_]+(\.[a-z0-9_*]+)+)$/

const WEBHOOK: Def = {
  type: T.webhook,
  label: 'Stripe webhook endpoint',
  base: '/v1/webhook_endpoints',
  prefix: 'we_',
  archive: 'delete',
  listQuery: {},
  activeKey: null,
  nameOf: (f) => (typeof f.url === 'string' ? f.url : null),
  fields: [
    {
      key: 'url',
      label: 'URL',
      kind: 'string',
      required: true,
      pattern: '^https://',
      help: 'Where Stripe sends events. https only.'
    },
    {
      key: 'enabled_events',
      label: 'Events',
      kind: 'list',
      required: true,
      items: { key: 'event', label: 'Event', kind: 'string' },
      help: 'Event types such as invoice.paid, or * for all of them.'
    },
    { key: 'description', label: 'Description', kind: 'string' },
    {
      key: 'status',
      label: 'Status',
      kind: 'enum',
      default: 'enabled',
      options: [
        { value: 'enabled', label: 'Enabled' },
        { value: 'disabled', label: 'Disabled' }
      ]
    },
    {
      key: ROTATE_OUTPUTS_FIELD,
      label: 'Make a new signing secret now',
      kind: 'boolean',
      trigger: true,
      help: 'Stripe shows the signing secret once. This makes a new endpoint with the same settings, removes the old one and hands the new secret to what is bound to it.'
    }
  ],
  writable: ['url', 'enabled_events', 'description', 'status'],
  replaceKeys: [],
  map: (raw) => ({
    type: T.webhook,
    externalId: String(raw.id),
    name: raw.url ?? null,
    fields: {
      url: raw.url ?? null,
      enabled_events: Array.isArray(raw.enabled_events) ? [...raw.enabled_events].sort() : [],
      description: raw.description ?? null,
      status: raw.status === 'disabled' ? 'disabled' : 'enabled'
    },
    tags: {},
    status: raw.status === 'disabled' ? 'disabled' : 'enabled'
  }),
  validate(d) {
    httpsUrl(d.fields.url, 'The URL')
    const ev = d.fields.enabled_events
    if (!Array.isArray(ev) || !ev.length) throw bad('Choose at least one event.')
    for (const e of ev)
      if (typeof e !== 'string' || !EVENT_RE.test(e))
        throw bad('An event name looks like invoice.paid (or * for all).')
  },
  createForm: (d) => ({
    url: httpsUrl(d.fields.url, 'The URL'),
    enabled_events: [...(d.fields.enabled_events as string[])],
    ...(optStr(d.fields.description) ? { description: str(d.fields.description) } : {}),
    metadata: metadataOf(d)
  }),
  updateForm(want, changed) {
    const f: Record<string, unknown> = {}
    for (const k of changed) {
      if (k === 'url') f.url = httpsUrl(want.url, 'The URL')
      if (k === 'enabled_events') f.enabled_events = [...(want.enabled_events as string[])]
      if (k === 'description') f.description = str(want.description)
      if (k === 'status') f.disabled = want.status === 'disabled'
    }
    return f
  },
  async find(ctx, d) {
    const url = httpsUrl(d.fields.url, 'The URL')
    const all = await stripeListAll(ctx, '/v1/webhook_endpoints')
    return all.find((w) => w?.url === url && isLiveObject(w, ctx)) ?? null
  }
}

const CUSTOMER_UPDATES = ['email', 'address', 'shipping', 'phone', 'tax_id']

const PORTAL: Def = {
  type: T.portal,
  label: 'Stripe billing portal configuration',
  base: '/v1/billing_portal/configurations',
  prefix: 'bpc_',
  archive: 'active',
  listQuery: { is_active: 'true' },
  activeKey: 'is_active',
  nameOf: (f) => (typeof f.headline === 'string' && f.headline ? f.headline : null),
  fields: [
    { key: 'headline', label: 'Headline', kind: 'string', max: 60 },
    {
      key: 'privacy_policy_url',
      label: 'Privacy policy URL',
      kind: 'string',
      pattern: '^https://'
    },
    {
      key: 'terms_of_service_url',
      label: 'Terms of service URL',
      kind: 'string',
      pattern: '^https://'
    },
    { key: 'default_return_url', label: 'Return URL', kind: 'string', pattern: '^https://' },
    { key: 'invoice_history', label: 'Show invoice history', kind: 'boolean', default: true },
    {
      key: 'payment_method_update',
      label: 'Let customers update payment methods',
      kind: 'boolean',
      default: true
    },
    { key: 'customer_update', label: 'Let customers update their details', kind: 'boolean' },
    {
      key: 'customer_update_allowed',
      label: 'Details customers may update',
      kind: 'list',
      items: { key: 'detail', label: 'Detail', kind: 'string' },
      help: `Any of ${CUSTOMER_UPDATES.join(', ')}.`
    },
    {
      key: 'subscription_cancel',
      label: 'Let customers cancel their subscription',
      kind: 'boolean'
    },
    {
      key: 'subscription_cancel_mode',
      label: 'When a cancellation takes effect',
      kind: 'enum',
      default: 'at_period_end',
      options: [
        { value: 'at_period_end', label: 'At period end' },
        { value: 'immediately', label: 'Immediately' }
      ]
    },
    {
      key: 'active',
      label: 'Active',
      kind: 'boolean',
      default: true,
      help: 'Off = archived. Configurations are never deleted.'
    }
  ],
  writable: [
    'headline',
    'privacy_policy_url',
    'terms_of_service_url',
    'default_return_url',
    'invoice_history',
    'payment_method_update',
    'customer_update',
    'customer_update_allowed',
    'subscription_cancel',
    'subscription_cancel_mode',
    'active'
  ],
  replaceKeys: [],
  map(raw) {
    const f = raw.features ?? {}
    return {
      type: T.portal,
      externalId: String(raw.id),
      name: raw.business_profile?.headline ?? null,
      fields: {
        headline: raw.business_profile?.headline ?? null,
        privacy_policy_url: raw.business_profile?.privacy_policy_url ?? null,
        terms_of_service_url: raw.business_profile?.terms_of_service_url ?? null,
        default_return_url: raw.default_return_url ?? null,
        invoice_history: f.invoice_history?.enabled === true,
        payment_method_update: f.payment_method_update?.enabled === true,
        customer_update: f.customer_update?.enabled === true,
        customer_update_allowed: Array.isArray(f.customer_update?.allowed_updates)
          ? [...f.customer_update.allowed_updates].sort()
          : [],
        subscription_cancel: f.subscription_cancel?.enabled === true,
        subscription_cancel_mode: f.subscription_cancel?.mode ?? 'at_period_end',
        active: raw.is_active !== false
      },
      tags: {}
    }
  },
  validate(d) {
    for (const k of ['privacy_policy_url', 'terms_of_service_url', 'default_return_url'])
      if (optStr(d.fields[k])) httpsUrl(d.fields[k], `The ${k.replace(/_/g, ' ')}`)
    const allowed = d.fields.customer_update_allowed
    if (Array.isArray(allowed))
      for (const a of allowed)
        if (!CUSTOMER_UPDATES.includes(String(a)))
          throw bad(`Customers may update: ${CUSTOMER_UPDATES.join(', ')}.`)
  },
  createForm(d) {
    return { ...PORTAL_BODY(d.fields), metadata: metadataOf(d) }
  },
  updateForm(want) {
    return PORTAL_BODY(want, true)
  },
  async find() {
    return null
  }
}

/** Only the features the Hub models; the rest of a configuration is never sent. */
function PORTAL_BODY(f: Record<string, unknown>, update = false): Record<string, unknown> {
  const b = (v: unknown, dflt = false) => (typeof v === 'boolean' ? v : dflt)
  const allowed = Array.isArray(f.customer_update_allowed)
    ? (f.customer_update_allowed as string[])
    : []
  const cu = b(f.customer_update)
  const sc = b(f.subscription_cancel)
  return {
    business_profile: {
      headline: str(f.headline),
      privacy_policy_url: str(f.privacy_policy_url),
      terms_of_service_url: str(f.terms_of_service_url)
    },
    default_return_url: str(f.default_return_url),
    features: {
      invoice_history: { enabled: b(f.invoice_history, true) },
      payment_method_update: { enabled: b(f.payment_method_update, true) },
      customer_update: cu
        ? { enabled: true, ...(allowed.length ? { allowed_updates: allowed } : {}) }
        : { enabled: false },
      subscription_cancel: sc
        ? { enabled: true, mode: str(f.subscription_cancel_mode) || 'at_period_end' }
        : { enabled: false }
    },
    ...(update && f.active !== undefined ? { active: f.active !== false } : {})
  }
}

const TAX: Def = {
  type: T.tax,
  label: 'Stripe tax rate',
  base: '/v1/tax_rates',
  prefix: 'txr_',
  archive: 'active',
  listQuery: { active: 'true' },
  activeKey: 'active',
  nameOf: (f) => (typeof f.display_name === 'string' ? f.display_name : null),
  fields: [
    { key: 'display_name', label: 'Name', kind: 'string', required: true },
    {
      key: 'percentage',
      label: 'Percentage',
      kind: 'number',
      required: true,
      min: 0,
      max: 100,
      replaceOnChange: true,
      help: 'Tax rates are immutable in percentage and inclusive/exclusive: a change makes a new rate and archives the old one.'
    },
    {
      key: 'inclusive',
      label: 'Inclusive',
      kind: 'boolean',
      default: false,
      replaceOnChange: true,
      help: 'The rate is already part of the price.'
    },
    { key: 'description', label: 'Description', kind: 'string' },
    { key: 'jurisdiction', label: 'Jurisdiction', kind: 'string' },
    { key: 'country', label: 'Country', kind: 'string', pattern: '^[A-Z]{2}$' },
    { key: 'state', label: 'State', kind: 'string' },
    { key: 'tax_type', label: 'Tax type', kind: 'string', help: 'vat, sales_tax, gst …' },
    {
      key: 'active',
      label: 'Active',
      kind: 'boolean',
      default: true,
      help: 'Off = archived. Tax rates are never deleted.'
    }
  ],
  writable: [
    'display_name',
    'description',
    'jurisdiction',
    'country',
    'state',
    'tax_type',
    'active'
  ],
  replaceKeys: ['percentage', 'inclusive'],
  map: (raw) => ({
    type: T.tax,
    externalId: String(raw.id),
    name: raw.display_name ?? null,
    fields: {
      display_name: raw.display_name ?? null,
      percentage: typeof raw.percentage === 'number' ? raw.percentage : null,
      inclusive: raw.inclusive === true,
      description: raw.description ?? null,
      jurisdiction: raw.jurisdiction ?? null,
      country: raw.country ?? null,
      state: raw.state ?? null,
      tax_type: raw.tax_type ?? null,
      active: raw.active !== false
    },
    tags: {}
  }),
  validate(d) {
    if (!str(d.fields.display_name)) throw bad('The tax rate needs a name.')
    const p = d.fields.percentage
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 100)
      throw bad('The percentage is a number from 0 to 100.')
    const c = str(d.fields.country)
    if (c && !/^[A-Z]{2}$/.test(c)) throw bad('The country is two capital letters, such as US.')
  },
  createForm: (d) => ({
    display_name: str(d.fields.display_name),
    percentage: d.fields.percentage,
    inclusive: d.fields.inclusive === true,
    ...(optStr(d.fields.description) ? { description: str(d.fields.description) } : {}),
    ...(optStr(d.fields.jurisdiction) ? { jurisdiction: str(d.fields.jurisdiction) } : {}),
    ...(optStr(d.fields.country) ? { country: str(d.fields.country) } : {}),
    ...(optStr(d.fields.state) ? { state: str(d.fields.state) } : {}),
    ...(optStr(d.fields.tax_type) ? { tax_type: str(d.fields.tax_type) } : {}),
    ...(d.fields.active === false ? { active: false } : {}),
    metadata: metadataOf(d)
  }),
  updateForm(want, changed) {
    const f: Record<string, unknown> = {}
    for (const k of changed) {
      if (k === 'active') f.active = want.active !== false
      else f[k] = str(want[k])
    }
    return f
  },
  async find(ctx, d) {
    const name = str(d.fields.display_name)
    const all = await stripeListAll(ctx, '/v1/tax_rates', { active: 'true' })
    return (
      all.find(
        (t) =>
          t?.display_name === name &&
          t.percentage === d.fields.percentage &&
          (t.inclusive === true) === (d.fields.inclusive === true) &&
          isLiveObject(t, ctx)
      ) ?? null
    )
  }
}

const DEFS: Record<string, Def> = {
  [T.product]: PRODUCT,
  [T.price]: PRICE,
  [T.webhook]: WEBHOOK,
  [T.portal]: PORTAL,
  [T.tax]: TAX
}

function defOf(type: unknown): Def {
  const d = typeof type === 'string' ? DEFS[type] : undefined
  if (!d) throw new ProviderError('UNKNOWN_TYPE', `Stripe has no ${String(type)}.`)
  return d
}

// ── Reads ──

async function readRaw(ctx: ProviderContext, def: Def, id: string): Promise<any | null> {
  const r = await stripeCall(ctx, 'GET', `${def.base}/${segment(id, def.prefix)}`, {
    allow: [404]
  })
  if (r.status === 404 || !isLiveObject(r.body, ctx)) return null
  return r.body
}

// ── Planning ──

const adminData = (ctx: ProviderContext): Record<string, unknown> => {
  try {
    return stripeMode(ctx) === 'live' ? { $adminOnly: true } : {}
  } catch {
    return { $adminOnly: true } // a key the Hub cannot read the mode of is treated as live
  }
}

function archiveReason(def: Def, name: string | null): string {
  const what = typedName(def.label, name)
  if (def.archive === 'delete')
    return `Delete ${what}. Stripe stops sending events to it at once and its signing secret stops working.`
  return `Archive ${what}. Stripe never deletes these: it stays in the dashboard as archived, can be restored there, and anything already sold with it is untouched.`
}

function planDef(
  ctx: ProviderContext,
  def: Def,
  desired: DesiredResource | null,
  observed: Observed | null
): PlannedOp[] {
  const data = adminData(ctx)
  const withData = (): { data?: Record<string, unknown> } =>
    Object.keys(data).length ? { data } : {}
  const words = (changes: Array<{ field: string }>) => fieldWords(def.fields, changes)
  if (!desired) {
    if (!observed) return []
    if (def.archive === 'active' && observed.fields.active === false) return []
    return [
      {
        kind: 'delete',
        type: def.type,
        resourceId: null,
        externalId: observed.externalId,
        reason: archiveReason(def, observed.name),
        changes: [],
        preconditions: { status: observed.status ?? null },
        risk: [],
        ...withData()
      }
    ]
  }
  if (!observed) {
    return [
      {
        kind: 'create',
        type: def.type,
        resourceId: desired.resourceId,
        externalId: null,
        reason: `Create ${typedName(def.label, def.nameOf(desired.fields))}.${
          def.type === T.webhook
            ? ' Stripe shows its signing secret once: bind it to a stack secret to carry it on.'
            : ''
        }`,
        changes: def.fields
          .map((f) => f.key)
          .filter((k) => k !== ROTATE_OUTPUTS_FIELD && norm(desired.fields[k]) !== null)
          .map((k) => ({ field: k, to: desired.fields[k] })),
        preconditions: {},
        risk: [],
        ...withData()
      }
    ]
  }
  const base = {
    type: def.type,
    resourceId: desired.resourceId,
    externalId: observed.externalId
  }
  const replace = diffFields(def.replaceKeys, desired.fields, observed.fields)
  if (replace.length) {
    return [
      {
        kind: 'replace',
        ...base,
        reason: `Replace ${typedName(def.label, observed.name)}: ${words(replace)} cannot change in place, so a new one is made and the old one is archived. Its Stripe id changes.`,
        changes: replace,
        preconditions: { status: observed.status ?? null },
        risk: [],
        ...withData()
      }
    ]
  }
  const ops: PlannedOp[] = []
  const changes = diffFields(def.writable, desired.fields, observed.fields)
  if (changes.length) {
    const pre: Record<string, unknown> = {}
    for (const c of changes) pre[c.field] = c.from ?? null
    ops.push({
      kind: 'update',
      ...base,
      reason: `Change ${words(changes)} on ${typedName(def.label, observed.name)}.`,
      changes,
      preconditions: pre,
      risk: [],
      ...withData()
    })
  }
  if (def.type === T.webhook && desired.fields[ROTATE_OUTPUTS_FIELD] === true) {
    ops.push({
      kind: 'update',
      ...base,
      action: 'rotate',
      reason: `Make a new signing secret for ${typedName(def.label, observed.name)}: a new endpoint with the same settings is made and the old one is removed. The old secret stops working at once; update whatever checks signatures.`,
      changes: [{ field: ROTATE_OUTPUTS_FIELD, from: false, to: true }],
      preconditions: { status: observed.status ?? null },
      risk: [],
      ...withData()
    })
  }
  return ops
}

// ── Applying ──

function checkTarget(op: PlannedOp, desired: DesiredResource | null): void {
  if (desired?.externalId && op.externalId && desired.externalId !== op.externalId)
    throw new ProviderError('TARGET_MISMATCH', 'The step does not match the resource it runs on.')
}

async function archiveRaw(ctx: ProviderContext, def: Def, id: string): Promise<void> {
  if (def.archive === 'delete') {
    await stripeCall(ctx, 'DELETE', `${def.base}/${segment(id, def.prefix)}`, { allow: [404] })
    return
  }
  await stripeCall(ctx, 'POST', `${def.base}/${segment(id, def.prefix)}`, {
    form: { active: false }
  })
}

async function createObject(
  ctx: ProviderContext,
  def: Def,
  desired: DesiredResource,
  opts: { keyTag: string; transferLookup?: boolean }
): Promise<{ raw: any; fresh: boolean }> {
  def.validate(desired)
  if (desired.externalId) {
    const have = await readRaw(ctx, def, desired.externalId)
    if (have) return { raw: have, fresh: false }
  }
  if (!opts.transferLookup) {
    const hit = await def.find(ctx, desired)
    if (hit) {
      // Ours (a resumed run whose id was not recorded) is returned as it is; anyone else's is not touched.
      if (tagsOf(hit)[RESOURCE_TAG] && tagsOf(hit)[RESOURCE_TAG] === tagOf(desired))
        return { raw: hit, fresh: false }
      throw alreadyExists(typedName(def.label, def.nameOf(desired.fields)))
    }
  }
  const form = def.createForm(desired)
  if (opts.transferLookup && form.lookup_key) form.transfer_lookup_key = true
  const r = await stripeCall(ctx, 'POST', def.base, {
    form,
    idempotencyKey: `nivaro-hub-${opts.keyTag}`.slice(0, 255)
  })
  let raw = r.body
  if (!raw?.id)
    throw new ProviderError('PROVIDER_REJECTED', 'Stripe did not return the new object.')
  const wantsDisabled = def.type === T.webhook && desired.fields.status === 'disabled'
  const secret = typeof raw.secret === 'string' ? raw.secret : undefined
  if (wantsDisabled) {
    const u = await stripeCall(ctx, 'POST', `${def.base}/${segment(raw.id, def.prefix)}`, {
      form: { disabled: true }
    })
    raw = { ...u.body, secret }
  }
  return { raw, fresh: true }
}

const outputsOf = (def: Def, raw: any, fresh: boolean): Record<string, string> =>
  def.type === T.webhook && fresh && typeof raw?.secret === 'string' && raw.secret
    ? { signing_secret: raw.secret }
    : {}

async function applyDef(
  ctx: ProviderContext,
  def: Def,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  checkTarget(op, desired)
  const id = op.externalId as string
  if (op.kind === 'create') {
    if (!desired) throw bad('Nothing to create.')
    const { raw, fresh } = await createObject(ctx, def, desired, {
      keyTag: `create-${def.type}-${tagOf(desired)}`
    })
    return ok(
      String(raw.id),
      observedOf(def, raw),
      fresh ? { created: true } : { already: 'exists' },
      outputsOf(def, raw, fresh)
    )
  }
  if (op.kind === 'delete') {
    const have = await readRaw(ctx, def, id)
    if (have && isActive(def, have)) await archiveRaw(ctx, def, id)
    return ok(id, null, { archived: def.archive === 'active' })
  }
  if (!desired) throw bad('Nothing to write.')
  const have = await readRaw(ctx, def, id)
  if (!have) throw new ProviderError('NOT_FOUND', `${def.label} no longer exists.`, { status: 404 })

  if (op.kind === 'replace') {
    const { raw } = await createObject(
      ctx,
      def,
      { ...desired, externalId: null },
      { keyTag: `replace-${def.type}-${tagOf(desired)}-${id}`, transferLookup: true }
    )
    if (isActive(def, have)) await archiveRaw(ctx, def, id)
    return ok(String(raw.id), observedOf(def, raw), { replaced: id })
  }

  if (op.action === 'rotate') {
    const body = await stripeCall(ctx, 'POST', def.base, {
      form: {
        url: have.url,
        enabled_events: have.enabled_events,
        ...(have.description ? { description: have.description } : {}),
        metadata: have.metadata ?? {}
      },
      idempotencyKey: `nivaro-hub-rotate-${tagOf(desired)}-${id}`.slice(0, 255)
    })
    let raw = body.body
    if (!raw?.id)
      throw new ProviderError('PROVIDER_REJECTED', 'Stripe did not return the new endpoint.')
    const secret = typeof raw.secret === 'string' ? raw.secret : ''
    if (have.status === 'disabled') {
      const u = await stripeCall(ctx, 'POST', `${def.base}/${segment(raw.id, def.prefix)}`, {
        form: { disabled: true }
      })
      raw = u.body
    }
    await archiveRaw(ctx, def, id)
    return ok(
      String(raw.id),
      observedOf(def, raw),
      { rotated: true, replaced: id },
      secret ? { signing_secret: secret } : undefined
    )
  }

  const seen = observedOf(def, have)
  const diff = diffFields(def.writable, desired.fields, seen.fields)
  if (!diff.length) return ok(id, seen, { already: 'matches' })
  const form = def.updateForm(
    desired.fields,
    diff.map((c) => c.field)
  )
  await stripeCall(ctx, 'POST', `${def.base}/${segment(id, def.prefix)}`, { form })
  const after = await readRaw(ctx, def, id)
  return ok(id, after ? observedOf(def, after) : null, { changed: diff.map((c) => c.field) })
}

// ── Types ──

const riskOf =
  (def: Def) =>
  (op: PlannedOp): RiskFlag[] => {
    if (op.kind === 'delete' || op.kind === 'replace' || op.action === 'rotate') return ['downtime']
    if (
      def.type === T.webhook &&
      op.changes.some((c) => c.field === 'status' && c.to === 'disabled')
    )
      return ['downtime']
    return []
  }

const TYPES: ResourceTypeSpec[] = [PRODUCT, PRICE, WEBHOOK, PORTAL, TAX].map((def) => ({
  key: def.type,
  label: def.label,
  scope: 'app' as const,
  nameField: def.type === T.webhook ? 'url' : def.writable[0],
  fields: def.fields,
  capabilities: {
    create: true,
    update: true,
    delete: true,
    adopt: true,
    snapshot: false,
    tag: true
  },
  reversible: false,
  refs: def.type === T.price ? [{ field: 'product', type: T.product, required: true }] : [],
  ...(def.type === T.webhook
    ? {
        outputs: [
          {
            key: 'signing_secret',
            label: 'Webhook signing secret',
            secret: true,
            onceOnly: true
          }
        ]
      }
    : {}),
  risk: riskOf(def)
}))

// ── The adapter ──

const PROBES: Array<{ type: string; path: string; need: string }> = [
  { type: T.product, path: '/v1/products', need: 'read products' },
  { type: T.price, path: '/v1/prices', need: 'read prices' },
  { type: T.webhook, path: '/v1/webhook_endpoints', need: 'read webhook endpoints' },
  {
    type: T.portal,
    path: '/v1/billing_portal/configurations',
    need: 'read billing portal configurations'
  },
  { type: T.tax, path: '/v1/tax_rates', need: 'read tax rates' }
]

export const stripeAdapter: ProviderAdapter = {
  key: 'stripe',
  label: 'Stripe',
  connection: {
    fields: [
      {
        key: 'apiKey',
        label: 'API key',
        kind: 'string',
        secret: true,
        required: true,
        placeholder: 'rk_test_…',
        help: 'A restricted key (rk_…) with write access to Products, Prices, Webhook endpoints, Customer portal and Tax rates only, or a secret key (sk_…). Test or live mode is read from the key. Live-mode changes need a Hub administrator. The Hub never charges, refunds or moves money.'
      }
    ],
    hosts: () => ['api.stripe.com'],
    describe: () => 'Stripe account',
    validate(_config, secrets) {
      if (secrets.apiKey === undefined) return []
      try {
        modeOfKey(secrets.apiKey)
        return []
      } catch {
        return [
          'The API key must be a Stripe restricted or secret key (rk_… or sk_…, test or live).'
        ]
      }
    }
  },
  types: TYPES,

  async testConnection(ctx): Promise<ConnectionTest> {
    let mode: string
    try {
      mode = stripeMode(ctx)
    } catch (err) {
      const message = err instanceof ProviderError ? err.message : 'The key is not usable.'
      const permissions = PROBES.map((p) => ({ type: p.type, need: p.need, has: false }))
      return {
        ok: false,
        identity: null,
        permissions,
        missing: permissions.map((p) => p.need),
        message
      }
    }
    const permissions: ConnectionTest['permissions'] = []
    let authFailed = false
    for (const p of PROBES) {
      let has = false
      try {
        const r = await stripeCall(ctx, 'GET', p.path, { query: { limit: 1 }, allow: [403] })
        has = r.status < 400
      } catch (err) {
        if (err instanceof ProviderError && err.code === 'AUTH_FAILED') authFailed = true
        else if (!(err instanceof ProviderError)) throw err
      }
      permissions.push({ type: p.type, need: p.need, has })
      if (authFailed) break
    }
    if (authFailed) {
      const all = PROBES.map((p) => ({ type: p.type, need: p.need, has: false }))
      return {
        ok: false,
        identity: null,
        permissions: all,
        missing: all.map((p) => p.need),
        message: 'Stripe refused the key.'
      }
    }
    let identity = `Stripe account (${mode} mode)`
    try {
      const a = await stripeCall(ctx, 'GET', '/v1/account', { allow: [401, 403, 404] })
      if (a.status < 400 && typeof a.body?.id === 'string') {
        const name = a.body.business_profile?.name ?? a.body.settings?.dashboard?.display_name
        identity = `Stripe ${a.body.id}${name ? ` · ${String(name)}` : ''} (${mode} mode)`
      }
    } catch {
      /* the identity stays generic */
    }
    const missing = permissions.filter((p) => !p.has).map((p) => p.need)
    return {
      ok: missing.length === 0,
      identity,
      permissions,
      missing,
      message:
        'Read access is checked here; write access is checked when a change is applied (a restricted key shows its write permissions only in the Stripe dashboard).'
    }
  },

  async observe(ctx, type, externalId) {
    const def = defOf(type)
    const raw = await readRaw(ctx, def, externalId)
    return raw ? observedOf(def, raw) : null
  },

  async list(ctx, type, cursor): Promise<ListPage> {
    const def = defOf(type)
    const r = await stripeCall(ctx, 'GET', def.base, {
      query: { ...def.listQuery, limit: 100, starting_after: cursor || undefined }
    })
    const data: any[] = Array.isArray(r.body?.data) ? r.body.data : []
    return {
      items: data.filter((x) => isLiveObject(x, ctx)).map((x) => observedOf(def, x)),
      cursor: r.body?.has_more && data.length ? String(data[data.length - 1].id) : null
    }
  },

  async findExisting(ctx, type, desired) {
    const def = defOf(type)
    if (desired.externalId) return null
    try {
      const hit = await def.find(ctx, desired)
      return hit ? observedOf(def, hit) : null
    } catch (err) {
      if (err instanceof ProviderError && err.code === 'INVALID_FIELDS') return null
      throw err
    }
  },

  plan(ctx, desired, observed) {
    const def = defOf(desired?.type ?? observed?.type)
    return planDef(ctx, def, desired, observed)
  },

  async apply(ctx, op, desired) {
    if (op.kind === 'noop') return ok(op.externalId, null)
    return applyDef(ctx, defOf(op.type), op, desired)
  },

  async health(ctx, type, externalId): Promise<HealthAnswer> {
    const checkedAt = ctx.now().toISOString()
    const seen = await this.observe(ctx, type, externalId)
    if (!seen) return { status: 'down', message: 'It is gone at Stripe.', checkedAt }
    const state = String(seen.status ?? '')
    if (state === 'active' || state === 'enabled')
      return { status: 'ok', checkedAt, details: { state } }
    return {
      status: 'warn',
      message: `It is ${state || 'in an unknown state'}.`,
      checkedAt,
      details: { state }
    }
  }
}
