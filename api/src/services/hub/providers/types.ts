/**
 * Nivaro Hub third-party providers: the contract every adapter (GitHub, AWS, Vercel, Auth0, Expo,
 * an extension's) implements and the engine, REST API and UI speak. Spec:
 * docs/superpowers/specs/2026-11-26-hub-providers-design.md ("Framework contract").
 *
 * Ground rules an adapter keeps:
 *  - It never touches the Hub database (the engine owns every write) and never calls `fetch`
 *    itself: every outbound call goes through `ctx.fetch` (host allowlist, https only).
 *  - It never puts a secret value in an error, a log line, an op's `changes`, `data` or `answer`,
 *    or an `Observed` — `ctx.scrub(text)` masks the connection's secrets in provider text.
 *  - `apply` is idempotent by read-before-write: observe, then act only if still needed.
 *  - Failures are thrown as `ProviderError` (code + message + retryable), never a bare Error.
 */

import type { HubResourceRow } from './store.js'

// ── Small enums ──

/** What a planned operation risks. The engine maps each to a gate (see the spec). */
export type RiskFlag = 'destructive' | 'data_loss' | 'public_exposure' | 'downtime' | 'cost'
export const RISK_FLAGS: readonly RiskFlag[] = [
  'destructive',
  'data_loss',
  'public_exposure',
  'downtime',
  'cost'
]

/** `app` = belongs to one app (+ environment); `shared` = per connection, Hub admins only. */
export type ResourceScope = 'app' | 'shared'

export type OpKind = 'create' | 'update' | 'replace' | 'delete' | 'noop'

/** How a resource type bills (Task 34 widened it from none | monthly). */
export type CostClass = 'none' | 'monthly' | 'yearly' | 'one_time'
export const COST_CLASSES: readonly CostClass[] = ['none', 'monthly', 'yearly', 'one_time']

// ── Outbound calls ──

export interface ProviderFetchInit {
  method?: string
  /** Lower- or mixed-case names; values are sent as given. */
  headers?: Record<string, string>
  body?: string | Uint8Array | null
  /** Combined with the context's abort signal and the fetch's own timeout. */
  signal?: AbortSignal
  /** Overrides the fetch's default timeout for this one call. */
  timeoutMs?: number
}

/**
 * `fetch` limited to the hosts an adapter declared (see provider-fetch.ts): https only, redirects
 * followed only to allowed hosts. Refusals and timeouts throw `ProviderFetchError`.
 */
export type ProviderFetch = (url: string, init?: ProviderFetchInit) => Promise<Response>

export interface ProviderLogger {
  /** Never pass secret values or provider bodies that may hold them. */
  info(message: string, data?: Record<string, unknown>): void
  warn(message: string, data?: Record<string, unknown>): void
  error(message: string, data?: Record<string, unknown>): void
}

/**
 * Short-lived tokens an adapter mints from its credentials (GitHub installation token, Auth0 M2M
 * token, AWS STS session). Scoped to ONE connection by the context builder, held in memory only,
 * dropped when the connection's credentials change. Adapters use this instead of module-level
 * caches (module-state guard).
 */
export interface ProviderTokenCache {
  get(key: string): string | null
  /** `expiresAt` = when the token stops working; the cache drops it 60 s before. */
  set(key: string, value: string, expiresAt: Date): void
  delete(key: string): void
}

/** What an adapter call is given. Built by the engine (`makeProviderContext`, context.ts). */
export interface ProviderContext {
  connectionId: number
  /** The adapter key, e.g. 'aws'. */
  provider: string
  /** The connection's non-secret fields (`ConnectionField` without `secret`). */
  config: Record<string, unknown>
  /** The connection's secret fields, opened for this call only. Never log or answer these. */
  secrets: Record<string, string>
  /** Allowlisted fetch for this connection (hosts from `ConnectionSpec.hosts(config)`). */
  fetch: ProviderFetch
  log: ProviderLogger
  /** The region this call is for (AWS: one of the connection's allowed regions); else null. */
  region: string | null
  /** Aborted when the run is cancelled or loses its lock. */
  signal: AbortSignal
  /** Masks every secret value of this connection (and its tokens) found in `text`. */
  scrub(text: string): string
  tokens: ProviderTokenCache
  /** The clock (tests pin it). */
  now(): Date
}

// ── Connections ──

export interface ConnectionField {
  key: string
  label: string
  kind: 'string' | 'number' | 'boolean' | 'enum' | 'list' | 'text'
  /** Sealed with the connection's secret; answered back only as a mask + fingerprint. */
  secret?: boolean
  required?: boolean
  help?: string
  placeholder?: string
  /** For `enum`; for `list` the allowed values when the list is closed (e.g. AWS regions). */
  options?: Array<{ value: string; label: string }>
  default?: unknown
}

export interface ConnectionSpec {
  /** The form: non-secret fields land in `config`, secret ones in the sealed secret. */
  fields: ConnectionField[]
  /**
   * The exact hosts (or `*.suffix`) this connection may call, from its config — e.g.
   * `['api.github.com']`, `['sts.amazonaws.com', 'ec2.us-east-1.amazonaws.com', …]`,
   * `['<tenant>.auth0.com']`. Anything else is refused by `ctx.fetch`.
   */
  hosts(config: Record<string, unknown>): string[]
  /** One line for lists, e.g. "AWS 123456789012 · us-east-1, eu-west-1". No secrets. */
  describe(config: Record<string, unknown>): string
  /** Problems with a filled-in form (empty = fine); called before saving. */
  validate?(config: Record<string, unknown>, secrets: Record<string, string>): string[]
}

export interface ConnectionTest {
  ok: boolean
  /** Who the credentials are, as the provider says it ("org nodeworks", an assumed-role ARN). */
  identity: string | null
  /** Each permission a resource type needs (`type` = '*' for connection-wide ones). */
  permissions: Array<{ type: string; need: string; has: boolean }>
  /** `need` of every permission with `has: false`. */
  missing: string[]
  message?: string
}

// ── Resource types ──

export interface FieldSpec {
  key: string
  label: string
  kind: 'string' | 'number' | 'boolean' | 'enum' | 'list' | 'object' | 'ref' | 'secret'
  required?: boolean
  help?: string
  default?: unknown
  /** `enum` choices. */
  options?: Array<{ value: string; label: string }>
  /**
   * The key of a `list` field of the CONNECTION whose values are the only choices for this one
   * (AWS `region` → the connection's `regions`). Forms offer those values; the adapter still
   * refuses anything else.
   */
  optionsFrom?: string
  /** `list`: the spec of one item (its own `key` is ignored). */
  items?: FieldSpec
  /** `object`: its fields. */
  fields?: FieldSpec[]
  /** `ref`: the resource type key it points at (e.g. 'aws.vpc'). Value = `RefValue`. */
  refType?: string
  /** Set by the provider, shown, never edited (an ARN, a URL). */
  readOnly?: boolean
  /** A change to this field forces a replace (delete + create). */
  replaceOnChange?: boolean
  /** Changeable only on create. */
  createOnly?: boolean
  min?: number
  max?: number
  /** A regular expression source the value must match (strings). */
  pattern?: string
  /**
   * A one-shot trigger of a named op (GitHub `dispatch`, a build request): the engine clears it
   * from the stored desired state once the op that used it applied, so a re-apply, a resume or
   * drift never runs it again. (An op may also list such fields in `data.$oneShot`.)
   */
  trigger?: boolean
}

export interface ResourceCapabilities {
  create: boolean
  update: boolean
  delete: boolean
  adopt: boolean
  snapshot: boolean
  tag: boolean
}

/** A field of this type that points at another managed resource (dependency order, SHARED_IN_USE). */
export interface ResourceTypeRef {
  /** The field key (a `ref` field, or a `list` of `ref`). */
  field: string
  /** The type it points at. */
  type: string
  /** Deleting this resource requires deleting the referencing ones first. Default true. */
  required?: boolean
}

export interface ResourceTypeSpec {
  /** `<provider>.<snake>`, e.g. 'aws.security_group'. */
  key: string
  label: string
  scope: ResourceScope
  fields: FieldSpec[]
  capabilities: ResourceCapabilities
  /** Whether the engine may generate an undo (per field when a function). */
  reversible: boolean | ((field: string) => boolean)
  refs: ResourceTypeRef[]
  /** The field whose value a typed confirm asks for (default: 'name'). */
  nameField?: string
  /** Risk flags of one planned op (pure). `desired` is null for a delete. */
  risk(op: PlannedOp, desired: DesiredResource | null): RiskFlag[]
  /**
   * `monthly` = the resource bills while it exists above a small free/cheap class; `yearly` = it
   * bills once a year (a domain); `one_time` = one charge at create (Task 34). Every value but
   * `none` adds the `cost` risk to a create or replace (owner → `pending_approval`).
   */
  costClass?(desired: DesiredResource): CostClass
  /**
   * Task 13: values the provider hands out for this resource (a DSN, an API key, a URL) that the
   * Hub seals and pushes into bound settings. Never part of `fields`, `Observed` or a plan.
   */
  outputs?: OutputSpec[]
  /**
   * Task 13: resources of this type send messages (a Slack channel, a Teams webhook): notify
   * routes may name them, and `adapter.notify` is called with them. Other types never send.
   */
  sends?: boolean
}

// ── Values that travel between the engine and adapters ──

/** The stored value of a `ref` field: the Hub resource row it points at. */
export interface RefValue {
  resourceId: number
}

/**
 * A `secret` field's value as an adapter sees it. `plain` is present only inside `apply` (opened
 * for that call); `plan` sees the fingerprint and whether the person sent a new value.
 */
export interface SecretValue {
  fingerprint: string
  changed: boolean
  plain?: string
}

/** What the Hub wants a resource to be. */
export interface DesiredResource {
  /** The Hub row id; null for a create the engine has not stored yet. */
  resourceId: number | null
  type: string
  /** The provider's id (ARN, repo id…); null before create. */
  externalId: string | null
  scope: ResourceScope
  appId: number | null
  environmentId: number | null
  /**
   * Values by FieldSpec key. `ref` fields hold `RefValue` (or `RefValue[]` for a list of refs);
   * `secret` fields hold `SecretValue`; everything else is plain JSON.
   */
  fields: Record<string, unknown>
  /**
   * The provider ids of every ref field, resolved by the engine (`null` = the referenced
   * resource is not created yet — only at plan time; apply runs parents first).
   */
  refs: Record<string, string | string[] | null>
  /** Tags the engine wants on it: `nivaro-hub:app`, `nivaro-hub:env`, `nivaro-hub:resource`. */
  tags: Record<string, string>
}

/** What the provider says a resource is. No secret values, no raw provider bodies. */
export interface Observed {
  type: string
  externalId: string
  /** Display name. */
  name: string | null
  /**
   * Values by FieldSpec key where readable (write-only secrets are absent). `ref` fields hold the
   * referenced resource's provider id (string or string[]), not a RefValue.
   */
  fields: Record<string, unknown>
  tags: Record<string, string>
  /** ETag / version for compare-and-set writes, when the provider has one. */
  version?: string | null
  /** Provider lifecycle state ('available', 'pending', 'archived'…). */
  status?: string | null
  /** A link to the resource in the provider's own console. */
  url?: string | null
}

export interface FieldChange {
  field: string
  /** Omitted for secret fields (and replaced by `secret: true`). */
  from?: unknown
  to?: unknown
  secret?: boolean
}

export interface PlannedOp {
  kind: OpKind
  type: string
  resourceId: number | null
  externalId: string | null
  /** One plain sentence why ("Port 22 open to 0.0.0.0/0 added"). */
  reason: string
  changes: FieldChange[]
  /**
   * The observed values this op depends on (field → value). The engine hashes them into the
   * plan's precondition fingerprint and re-reads before the step; a moved value stops the run
   * with PRECONDITION_CHANGED. Empty for a create.
   */
  preconditions: Record<string, unknown>
  /** Filled by the engine from `ResourceTypeSpec.risk` (an adapter may leave it []). */
  risk: RiskFlag[]
  /**
   * A named non-CRUD action an op runs (kind 'update'): 'dispatch' (github.workflow),
   * 'promote' / 'rollback' (vercel.deployment), 'point' (expo.channel). Absent = plain write.
   */
  action?: string
  /** The adapter's own step data (non-secret JSON), handed back to `apply` unchanged. */
  data?: Record<string, unknown>
}

export interface SnapshotRef {
  /** 'rds_snapshot', 'ebs_snapshot', 'before_state', … */
  kind: string
  /** The provider's snapshot id (or the engine's before-state key). */
  id: string
  label?: string
  createdAt: string
}

export interface OpError {
  code: string
  /** Scrubbed of secrets. */
  message: string
  retryable: boolean
  status?: number
}

export interface OpResult {
  ok: boolean
  /** The provider id after the op (a create's new id; the old one after a delete). */
  externalId: string | null
  /** The state after the op when the adapter read it (null after a delete or when not read). */
  observed: Observed | null
  /** A short, non-secret summary of the provider's answer (request id, status). */
  answer?: Record<string, unknown>
  error?: OpError
  snapshot?: SnapshotRef
  /**
   * Task 13: output values this op produced, by OutputSpec key (undeclared keys are dropped). The
   * engine seals each at once and strips them from the result: they never reach `observed`, the
   * step, the audit row or a log.
   */
  outputs?: Record<string, string>
}

export interface ListPage {
  items: Observed[]
  /** Next page; null = last. */
  cursor: string | null
}

export interface HealthAnswer {
  status: 'ok' | 'warn' | 'down' | 'unknown'
  message?: string
  checkedAt: string
  details?: Record<string, string | number | boolean>
}

// ── The adapter ──

export interface ProviderAdapter {
  /** `/^[a-z][a-z0-9-]{1,30}$/` — 'aws', 'github', or an extension's 'acme'. */
  key: string
  label: string
  connection: ConnectionSpec
  types: ResourceTypeSpec[]
  testConnection(ctx: ProviderContext): Promise<ConnectionTest>
  /** null = the resource is gone. */
  observe(ctx: ProviderContext, type: string, externalId: string): Promise<Observed | null>
  /** Everything of `type` the connection can see (Unmanaged + adopt). */
  list(ctx: ProviderContext, type: string, cursor?: string | null): Promise<ListPage>
  /**
   * Pure diff (no calls): desired null = delete `observed`; observed null = create `desired`;
   * nothing to do = one `noop` op (or []).
   */
  plan(
    ctx: ProviderContext,
    desired: DesiredResource | null,
    observed: Observed | null
  ): PlannedOp[]
  /** One op, idempotent (read-before-write). Throws ProviderError on failure. */
  apply(ctx: ProviderContext, op: PlannedOp, desired: DesiredResource | null): Promise<OpResult>
  /** Before a delete / replace when the type's `capabilities.snapshot` is true. */
  snapshot?(ctx: ProviderContext, type: string, externalId: string): Promise<SnapshotRef>
  health?(ctx: ProviderContext, type: string, externalId: string): Promise<HealthAnswer>
  /**
   * Optional: the resource a create would collide with (same name / key at the provider), read
   * while planning a create. A hit makes the plan's blocker ALREADY_EXISTS ("adopt it instead");
   * the engine never adopts on its own. `apply` must still refuse a collision itself.
   */
  findExisting?(
    ctx: ProviderContext,
    type: string,
    desired: DesiredResource
  ): Promise<Observed | null>
  /**
   * Task 13: reads the outputs the provider shows again (a connection URL). The engine asks only
   * for keys that are NOT `onceOnly`, and drops any `onceOnly` key an answer carries anyway.
   */
  readOutputs?(
    ctx: ProviderContext,
    type: string,
    externalId: string,
    /** The Hub resource row the outputs belong to (additive): lets an adapter refuse another row's. */
    resourceId?: number
  ): Promise<Record<string, string>>
  /**
   * Task 13: sends one message through this resource (a Slack channel, a Teams webhook, a
   * PagerDuty service, a SendGrid sender). One call = one message; throws ProviderError (429 →
   * retryable). The Hub calls it in the background, at most 10 s per send.
   */
  notify?(ctx: ProviderContext, resource: HubResourceRow, msg: OutboundMessage): Promise<OpResult>
}

// ── Outputs + notify (Task 13, Wave 2 framework) ──

export interface OutputSpec {
  /** `/^[a-z][a-z0-9_]{0,63}$/`, e.g. 'dsn', 'api_key', 'url'. */
  key: string
  label: string
  /** Bound only to secret targets (a stack secret, an app credential), never a plain setting. */
  secret: boolean
  /**
   * The provider shows it at create only (Stripe webhook secret, OpenAI service-account key,
   * SendGrid key, GitLab deploy token): when the sealed copy is lost it can only be rotated,
   * never re-read.
   */
  onceOnly?: boolean
}

/**
 * The trigger field a type with `onceOnly` outputs declares to offer a rotation (kind 'boolean',
 * `trigger: true`): an update with `{rotate_outputs: true}` plans the adapter's rotate op, whose
 * result carries the new outputs. The engine clears it after the op like every trigger.
 */
export const ROTATE_OUTPUTS_FIELD = 'rotate_outputs'

export type NotifySeverity = 'info' | 'warning' | 'critical'

export interface OutboundMessage {
  kind: 'text' | 'card'
  title: string
  body: string
  /** An absolute link back into the Hub. */
  link?: string
  severity: NotifySeverity
  /** Same key = the same item at the provider (PagerDuty incident, Jira issue). */
  dedupKey?: string
  /** With `dedupKey`: open a new item, update it or resolve it (default open). */
  action?: 'open' | 'update' | 'resolve'
}

// ── Errors ──

/** What an adapter throws. The engine records it on the step (message already scrubbed). */
export class ProviderError extends Error {
  code: string
  retryable: boolean
  status?: number
  constructor(code: string, message: string, opts: { retryable?: boolean; status?: number } = {}) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
    this.retryable = opts.retryable ?? false
    if (opts.status !== undefined) this.status = opts.status
  }
}

/** 408 / 425 / 429 / 5xx are worth retrying; the rest are not. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599)
}

// ── Costs and estimates (Task 44a) ──
// Grouped here (interface merging) so the cost contract stays one additive block. Spec: "Live
// costs and estimates". Every amount is in CENTS of `currency` (fractions allowed on unit prices,
// rounded on totals). Estimates are list prices and say so; they are never part of `plan_hash`.

/** Where a figure's price came from. */
export type CostBasis = 'price_list' | 'plan_price' | 'rate_card' | 'usage' | 'free'

/** How far the figure can be trusted. `unknown` = no estimate (shown as "No estimate"). */
export type CostConfidence = 'exact' | 'list_price' | 'usage_varies' | 'unknown'

/** One line of an estimate: quantity × unit price = a monthly amount. */
export interface CostLine {
  label: string
  qty: number
  /** 'hour', 'GB-month', 'GB', 'month', 'seat' … */
  unit: string
  /** Price of one unit in cents (fractions allowed, e.g. 1.04 for $0.0104). */
  unitCents: number
  /** This line's monthly amount in cents (negative for a discount). */
  monthlyCents: number
  /** `base` = the resource itself; `transfer` = data out; `tax`; `discount` (a minus line). */
  kind: 'base' | 'transfer' | 'tax' | 'discount'
  /** Where the line's figure came from. */
  source: 'price_list' | 'plan_price' | 'measured' | 'assumed' | 'learned_from_bill' | 'admin_rate'
}

export interface CostEstimate {
  /** ISO 4217 ('USD'). */
  currency: string
  /** Sum of every line's monthlyCents (tax and discount lines included). */
  monthlyCents: number
  oneTimeCents: number
  yearlyCents: number
  basis: CostBasis
  confidence: CostConfidence
  lines: CostLine[]
  /** The price's own date (a bundled table's, the price list's), null when not known. */
  priceAsOf: string | null
  /** One plain sentence ("plus usage", "tax not included", "no traffic assumed"). */
  note?: string
}

/**
 * Expected data out of a resource, GB per month: from the form (`form`), else prefilled by the
 * engine from what the Hub measured for the same app (`measured`). Absent = no traffic assumed.
 */
export interface EstimateTraffic {
  egressGbMonth: number
  source: 'form' | 'measured'
}

/**
 * One cost row a provider reports (its bill or near-live usage). Task 34's cost feed and
 * `usageNow` both answer these. `recordType` lets the price book learn tax and discount rates.
 */
export interface CostRow {
  /** The day the cost belongs to (YYYY-MM-DD, UTC). */
  date: string
  /** Negative for a credit, discount or refund. */
  amountCents: number
  currency: string
  /** The managed resource's provider id, when the row names one. */
  externalId?: string
  /** The `nivaro-hub:app` tag value, when the row carries one. */
  appTag?: string
  service?: string
  recordType?: 'usage' | 'tax' | 'credit' | 'discount' | 'refund'
}

/** One price the price book answers (priceLookup). */
export interface PriceAnswer {
  /** Price of one unit in cents (fractions allowed). */
  unitCents: number
  unit: string
  currency: string
  /** The price's own date. */
  asOf: string | null
}

/**
 * A provider's bundled, dated plan-price table (the fallback when its API has no price or is
 * not asked): sku key → unit + price, optionally per region (absent = the same everywhere).
 */
export interface BundledPriceTable {
  /** The date these prices were copied from the provider's pricing page (YYYY-MM-DD). */
  asOf: string
  currency: string
  items: Record<
    string,
    {
      unit: string
      unitCents: number
      regions?: Record<string, number>
      /** true = the price holds only in the regions listed (no default for other regions). */
      regionsOnly?: boolean
      label?: string
    }
  >
}

export interface ProviderContext {
  /**
   * Set by the engine for `estimate` only: the traffic the person entered (or the Hub measured)
   * for this resource. Absent = no traffic assumed.
   */
  traffic?: EstimateTraffic
}

export interface ResourceTypeSpec {
  /**
   * What this resource costs (Task 44a). Required for every type that has a `costClass`
   * (guard test hub-providers-estimate.guard.test.ts). `desired: null` = a delete: answer what
   * it costs now (the engine shows it as the saving). Never throws: unknown →
   * `confidence: 'unknown'`. Prices through `priceLookup` (providers/pricing), never a fetch
   * outside `ctx.fetch`. Tax and discount lines are the engine's, never the adapter's.
   */
  estimate?(
    ctx: ProviderContext,
    desired: DesiredResource | null,
    observed: Observed | null
  ): Promise<CostEstimate>
}

export interface PlannedOp {
  /**
   * Filled by the engine (Task 44a): the estimate before and after this op and the monthly
   * difference. Never part of `plan_hash` (prices move).
   */
  cost?: {
    before: CostEstimate | null
    after: CostEstimate | null
    deltaMonthlyCents: number
  }
}

export interface ProviderAdapter {
  /**
   * Optional: what usage-priced resources used so far in `range` (Anthropic / OpenAI usage,
   * Vercel bandwidth, Twilio records), so the run-rate counts it, not zero.
   */
  usageNow?(ctx: ProviderContext, range: { from: string; to: string }): Promise<CostRow[]>
  /** Optional: the adapter's bundled plan-price table (pricing/bundled.ts reads it). */
  bundledPrices?: BundledPriceTable
  /**
   * Optional: read one price from the provider's own price API (AWS has a core one in
   * pricing/aws-price-list.ts). null = no price there. May throw; the price book falls back.
   */
  priceApi?(ctx: ProviderContext, skuKey: string, region: string): Promise<PriceAnswer | null>
}

// ── Cost feed and domains (Task 34) ──
// Additive, like the block above. Spec: "Wave 3 providers" (cost feed, domains).

export interface ProviderAdapter {
  /**
   * Optional (Task 34): the provider's billed spend per day in `range` (YYYY-MM-DD, both ends
   * included, UTC) — AWS Cost Explorer, Azure Cost Management, Anthropic / OpenAI cost reports.
   * Read once a day by the `hub-provider-costs` job. Set `externalId` when a row names one
   * resource and `appTag` when it carries the `nivaro-hub:app` tag; set `recordType` (tax,
   * credit, discount, refund) so the price book learns tax and discount rates. Throws
   * ProviderError on failure (the job records the scrubbed message and tries again tomorrow).
   */
  costs?(ctx: ProviderContext, range: { from: string; to: string }): Promise<CostRow[]>
}

export interface ResourceTypeSpec {
  /**
   * Task 34: a domain registration at a registrar (Route 53 Domains, Cloudflare Registrar,
   * Namecheap). Its adapter's `health` answers `details` with `expiresAt` (ISO date),
   * `autoRenew` and `locked` (booleans) — see `DomainHealthDetails`; the Hub's domain watch
   * lists it beside TLS expiry on /hub/security and warns 45 and 14 days before it expires.
   */
  registrar?: boolean
}

/** What a registrar type's `health().details` carries (Task 34). */
export interface DomainHealthDetails {
  /** When the registration ends (ISO 8601). */
  expiresAt: string
  autoRenew?: boolean
  /** The registrar transfer lock is on. */
  locked?: boolean
}
