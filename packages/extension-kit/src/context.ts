import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Knex } from 'knex'
import type { FlowOpRegistration, FlowTriggerRegistration } from './flows.js'
import type { HelpVideoContextDecl, HelpVideoPageDecl, HelpVideoStarterDef } from './help-videos.js'
import type { ExtensionHookHandler, HookAction } from './hooks.js'
import type { ImportProcessorDef } from './imports.js'
import type {
  DigestSectionProvider,
  MailTypeDef,
  NotificationChannelDef,
  NotificationSourceProvider,
  NotifyUserOptions
} from './notifications.js'
import type {
  ObligationKindDef,
  ObligationResolvePatch,
  ObligationTrigger,
  ObligationTriggerContext
} from './obligations.js'
import type { IntegrationErrorRule, JobRunFormatter } from './readable-ops.js'
import type {
  BotToolDef,
  BriefLineProvider,
  BulkActionDef,
  CallOptions,
  CallResult,
  ChainTable,
  CollectionViewDef,
  ConfigSeedDef,
  DashboardWidgetDef,
  EventSourceDef,
  FieldTypeDef,
  ImportParserDef,
  IntegrityCheck,
  ItemActionDef,
  LinkRegistration,
  MachineMarkerSet,
  OpsTaskDef,
  ReadinessCheck,
  RelatedNoteProvider,
  SchemaStepDef,
  StorageAdapter,
  TuningObserverDef,
  ValidatorDef
} from './registrations.js'
import type {
  IntegrationSignal,
  SignalActionHandler,
  TrafficLensDef,
  TrafficNodeDef
} from './signals.js'
import type { ChatMessageActionDef, ExtensionAiMembers, ExtensionMcpMembers } from './tools.js'

export type ExtensionSettingValue = string | number | boolean | null

/** A handler for the extension's own durable events (ctx.events). */
export type ExtensionEventHandler = (event: {
  id: number
  extension: string
  event_type: string
  payload: unknown
}) => void | Promise<void>

export interface ExtensionCronOpts {
  /** Plain-language purpose — what the job does and what it touches. */
  description?: string
  /** Serialised with every other heavy job; yields to pool pressure. */
  heavy?: boolean
  /** 'unsafe' = run-now duplicates mail or mutations. */
  idempotent?: 'safe' | 'unsafe' | 'unknown'
  /** The job's own no-write report, offered on Background Jobs. */
  dryRun?: () => Promise<unknown>
}

export interface ExtensionCronMeta {
  description?: string
  heavy?: boolean
  idempotent?: 'safe' | 'unsafe' | 'unknown'
  /** The deployment flag this job no-ops behind, and whether it currently
   *  lets the job run. */
  gate?: { flag: string; enabled: boolean }
}

/** A scheduled job as the core's cron manager lists it. */
export interface ExtensionCronEntry {
  id: string
  expression: string
  defaultExpression: string
  overridden: boolean
  extensionId?: string
  nextRun: Date | null
  heavy?: boolean
  idempotent?: 'safe' | 'unsafe' | 'unknown'
  description?: string
  gate?: { flag: string; enabled: boolean }
  paused?: boolean
  supports_dry_run?: boolean
}

/** The core's cron manager as extensions may read it (`ctx.app.cron`). */
export interface ExtensionCronManager {
  list(): ExtensionCronEntry[]
  pause(id: string): void
  resume(id: string): void
}

/** The Fastify instance with the core decorations an extension may rely on. */
export type ExtensionApp = FastifyInstance & { cron: ExtensionCronManager }

/**
 * What `register()` receives. Every member is a capability the core exposes
 * to extensions; members marked optional arrived in a later core release
 * than the earliest an extension may run against, so an extension checks
 * before using them.
 */
export interface ChatCommandDef {
  name: string
  /** One line in the slash list. */
  description: string
  /** e.g. `/standup <what you did>` */
  usage?: string
  run(
    args: string,
    ctx: { userId: string; room: string }
  ): Promise<{ post?: string; reply?: string } | void> | { post?: string; reply?: string } | void
}

/** What a cache warmer is handed (ctx.cache.registerWarm). */
export interface CacheWarmContext {
  /** Aborts when this warmer's time is up. */
  signal: AbortSignal
  /** Milliseconds this warmer may take. */
  budgetMs: number
}

export type CacheWarmFn = (ctx: CacheWarmContext) => Promise<unknown> | unknown

/** One thing wrong with a payload template render, anchored to its field-map row. */
export type PayloadTemplateProblem = {
  field_id: string
  /** Where in the output body, e.g. `orderLines[0].quantity`. */
  path: string
  message: string
  severity: 'error' | 'warning'
}

export type PayloadTemplateMode = 'map' | 'code'

/** A partner payload template an extension ships (spec 2026-10-22 §7.1). Seeded once
 *  (draft = published = `default`, version 1); an existing template is never overwritten. */
export type PayloadTemplateDef = {
  /** Lowercase letters, digits and dashes (at most 120). */
  key: string
  label: string
  description?: string
  /** The external API's name, as `callExternalApi` looks it up. */
  external_api: string
  /** Display + preview context only — the sender still makes the call. */
  endpoint_path?: string
  /** The record type previews pick from. */
  collection: string
  /** Map spec JSON (`mode: 'map'`) or Liquid text (`mode: 'code'`). */
  default: { mode: PayloadTemplateMode; body: string }
  /** Output keys Nivaro reads back; they cannot be removed or renamed in the editor. */
  locked_keys?: string[]
  /** Extra data lookups merged into `context` (same shape as an erp_submit action's context). */
  lookups?: Record<string, unknown>
  /** The render scope for one record — the same function the push uses, so preview == push. */
  scope?: (id: string) => Promise<Record<string, unknown>>
  /** Record ids "Check recent records" renders (newest first). */
  recent?: (limit: number) => Promise<string[]>
  /** Human labels for "Used by", e.g. `efp-ops: Push to Fusion button`. */
  senders?: string[]
}

export interface ExtensionContext {
  app: ExtensionApp
  database: Knex
  logger: FastifyInstance['log']
  /** Admin-editable extension settings — declared on the export. Values are
   *  parsed by the declared type (number/boolean), 30s cache. */
  settings?: {
    get(key: string): Promise<ExtensionSettingValue>
    getAll(): Promise<Record<string, ExtensionSettingValue>>
  }
  /** Durable event outbox — publish inserts a pending row delivered by the
   *  sweep cron; `on` registers a delivery handler for this extension's
   *  events ('*' = every type). Delivery retries with exponential backoff. */
  events: {
    publish(eventType: string, payload?: unknown): Promise<number | null>
    on(eventType: string | '*', fn: ExtensionEventHandler): void
  }
  /** Call a configured external API by name or numeric ID. Auth resolved
   *  automatically; every call lands in the API's call log. */
  callExternalApi(nameOrId: string | number, options?: CallOptions): Promise<CallResult>
  /** Long-running SQL outside knex.raw's request timeout — one statement,
   *  its own timeout (default 20 minutes), rows back. Bind nothing: the
   *  batch is sent as text, so only interpolate values you built yourself. */
  sql: {
    runLong<T = Record<string, unknown>>(sql: string, opts?: { timeoutMs?: number }): Promise<T[]>
    /** True when this core's id-returning writes (`.returning()`) work on tables
     *  that carry triggers — SQL Server refuses a plain OUTPUT there (error 334).
     *  Absent on older cores: an extension must not put triggers on a table the
     *  core writes when it is missing. */
    triggerSafeReturning?: boolean
    /** Tell open pages that a raw write (a procedure, a set-based UPDATE) changed
     *  records: ids + field NAMES, never values. No ids = "records in this
     *  collection changed"; more than 100 ids collapse into one such event.
     *  Optional — an older API does not provide it. Never throws. */
    announceWrites?(
      collection: string,
      ids?: Array<string | number> | null,
      opts?: { action?: 'create' | 'update' | 'delete'; changed_fields?: string[] }
    ): Promise<void>
  }
  /** Write an audit entry to nivaro_activity for a mutation that bypasses
   *  the items service. The action is namespaced `<extId>:<action>`. Never
   *  throws. */
  logActivity(entry: {
    action: string
    user?: string | null
    collection?: string
    item?: string | number
    comment?: string
    /** person | machine | import | integration — default: machine with no user. */
    origin?: 'person' | 'machine' | 'import' | 'integration'
  }): Promise<number | null>
  /** Deliver a notification through the full channel stack — inbox row,
   *  live socket event, browser push, optional email — honouring the
   *  recipient's notification rules. The only way an extension may notify a
   *  person; a raw nivaro_notifications insert bypasses every preference.
   *  Never throws. */
  notifyUser(userId: string, opts: NotifyUserOptions): Promise<void>
  /** Chat (#972): post into a channel, General or a record room — as the
   *  assistant (default, when the instance has one) or as a platform line.
   *  Never into direct messages. Resolves the new message id, or null when
   *  the room does not exist. Never throws. */
  chat: {
    post(
      room: string,
      text: string,
      opts?: { as?: 'bot' | 'system'; parent_id?: number | null }
    ): Promise<number | null>
    /** Add a slash command to the chat composer (#2338). The name is
     *  lower-case letters/digits/dashes and cannot reuse a built-in
     *  (`task`, `remind`, `poll`, `note`). `run` receives the text after the
     *  command, the person typing and the room; return `post` to send that
     *  text into the room as the person, and/or `reply` to show them a private
     *  line. Runs AS the person: read data through `readItems`, not raw SQL. */
    registerCommand(def: ChatCommandDef): void
    /** Add an item to a message's menu (#2763) — "Log to record", "Open in
     *  partner system". `when` limits it to room kinds or message shapes; the
     *  handler runs AS the person clicking, in a room they can see, and any
     *  text it returns to post goes through the normal send path. Returns
     *  false for a bad id or label. Optional — an older API does not provide it. */
    registerMessageAction?(def: ChatMessageActionDef): boolean
  }
  /** Hook helpers scoped to this extension — hooks are tagged and can be
   *  disabled / removed with it. */
  hooks: {
    before(collection: string | '*', action: HookAction | '*', fn: ExtensionHookHandler): void
    after(collection: string | '*', action: HookAction | '*', fn: ExtensionHookHandler): void
  }
  /** Cron helpers scoped to this extension — jobs pause and resume with it. */
  cron: {
    /** Register a recurring job. `id` is scoped to this extension. */
    schedule(
      id: string,
      expression: string,
      fn: () => void | Promise<void>,
      opts?: ExtensionCronOpts
    ): void
    /** Cancel a previously scheduled job. */
    unschedule(id: string): void
    /** Attach a description / heavy / idempotent flag / gate after scheduling. */
    annotate(id: string, meta: ExtensionCronMeta): void
    /** How a run of this job reads on the Jobs hub ("Nightly forecast: 4,210 rows in 3m12s").
     *  `id` is scoped like `schedule`; pass `{ exact: true }` for a job id started another way.
     *  Optional: an older core has no such member. */
    describeRun?(id: string, fn: JobRunFormatter, opts?: { exact?: boolean }): void
  }
  /** Bulk actions in the collection browser / queue selection bar. */
  bulkActions: { register(def: BulkActionDef): void }
  /** Contextual buttons in the record form's toolbar. */
  itemActions: { register(def: ItemActionDef): void }
  /** Partner payload templates (spec 2026-10-22): bodies editable in the admin, versioned,
   *  published before a push ever uses them. */
  payloadTemplates: {
    /** Register (and seed, once) a template. Rejects on an invalid definition before any
     *  side effect; a seeding failure is logged, never thrown. */
    register(def: PayloadTemplateDef): Promise<void>
    /** Render the PUBLISHED version for a scope. Rejects (with `problems`) on an unknown key,
     *  nothing published, or blocking problems — nothing should be sent then. Body secrets come
     *  back as `⟦nvr-secret:<name>⟧` placeholders; pass `bodySecrets: true` to
     *  `callExternalApi` to have them substituted at send time. */
    render(
      key: string,
      scope: Record<string, unknown>
    ): Promise<{
      body: Record<string, unknown> | null
      problems: PayloadTemplateProblem[]
      version: number | null
    }>
    /** Whether the named external API carries this body secret. */
    hasBodySecret(apiName: string, name: string): Promise<boolean>
    /** A partner's answer with every body secret of that API (instance-resolved) put back as
     *  its `⟦nvr-secret:<name>⟧` placeholder — for what an extension STORES from a response
     *  (a partner may echo the token). Never for the value ack parsing reads. Never returns the
     *  raw value when it cannot tell (the API's config cannot be read): returns
     *  `{ _scrub_failed: true }` instead (a string value gets it as JSON text,
     *  `'{"_scrub_failed":true}'`). An API with no body secrets gets the value unchanged. Never
     *  throws. Absent on cores before it shipped. */
    scrubResponse<T>(apiName: string, value: T): Promise<T>
  }
  /** Custom notification delivery channels (SMS, Slack, Teams…). */
  notificationChannels: { register(def: NotificationChannelDef): void }
  /** Extension-owned alert subscriptions on the profile's notification
   *  sources card. */
  notificationSources: { register(provider: NotificationSourceProvider): void }
  /** Read-only entries in a record's Notes thread, and the machine markers
   *  the thread should drop. */
  notes: {
    registerSource(provider: RelatedNoteProvider): void
    registerMachineMarkers(set: MachineMarkerSet): void
  }
  dashboardWidgets: { register(def: DashboardWidgetDef): void }
  /** Named file storage adapters (S3, Azure Blob…). */
  storage: {
    register(name: string, adapter: StorageAdapter): void
    /** Activate a registered adapter for all new uploads. */
    setActive(name: string): void
  }
  fieldTypes: { register(def: FieldTypeDef): void }
  collectionViews: { register(def: CollectionViewDef): void }
  importParsers: { register(def: ImportParserDef): void }
  /** Processors for staged imports whose file spans several collections;
   *  `key` is `<extension>:<name>` and is what an import definition names. */
  importProcessors: { register(def: ImportProcessorDef): void }
  validators: { register(def: ValidatorDef): void }
  approvalBrief: {
    /** One short line on the transition confirm's approval brief. */
    registerLine(collection: string, fn: BriefLineProvider): void
  }
  digest: {
    /** A per-user section of the daily action digest email. */
    registerSection(fn: DigestSectionProvider): void
  }
  readiness: {
    /** A scored check on the go-live readiness scorecard. */
    registerCheck(check: ReadinessCheck): void
  }
  /** Operational tasks — repairs, backfills, migrations — run from the admin
   *  console (dry run by default, one at a time, every run recorded). */
  tasks: { register(def: OpsTaskDef): void }
  /** Database tuning observers (#996). */
  tuning: { registerObserver(def: TuningObserverDef): void }
  /** Cache warm (#2445): an expensive READ of the extension's own, run by the
   *  core warm after a boot (once per cluster per version) and at 06:30 on
   *  weekdays, after the core queries, inside the same time budget and the
   *  heavy-job slot, holding one heavy-read slot. Each warmer gets its own
   *  timeout (`budgetMs`, default 60 s, never more than the run has left);
   *  on timeout `signal` aborts and the run moves on. Errors are logged, never
   *  thrown. A warmer must not write — fill your own Redis cache, run the read
   *  that warms the database — and should pass `budgetMs` to its statements
   *  (`ctx.sql.runLong(sql, { timeoutMs })`). Not run in cloud mode. */
  cache: {
    registerWarm(name: string, fn: CacheWarmFn, opts?: { budgetMs?: number }): void
  }
  /** Global-search prefix scopes (`wf: canton` searches workflows only): a map of
   *  prefix → collection, e.g. `{ wf: 'workflows' }`. These are defaults — the
   *  `search_scopes` settings override ("" removes a prefix). `@` is always
   *  people. Optional: older APIs do not offer it — call
   *  `ctx.search?.registerScopes(…)`. */
  search?: {
    registerScopes(map: Record<string, string>): void
  }
  /** Layouts the extension's code opens (#2613), so the layout editor can show
   *  them before a layout is renamed, retyped or deleted. Name the layout by
   *  `slug` (its link name) or `layout_id`. Optional: older APIs do not offer
   *  it — call `ctx.layouts?.dependsOn(…)`. A malformed declaration is logged
   *  and skipped. */
  layouts?: {
    dependsOn(dep: {
      collection: string
      slug?: string
      layout_id?: number
      /** What uses it, in plain words ("Order PDF email"). */
      label: string
    }): void
  }
  /** The heavy-read gate for the extension's own expensive reads. Routes the
   *  core runs through it (custom queries, widget renders, queue items) wait
   *  for one of a few slots per process, so a burst of them never takes the
   *  whole database pool from the cheap reads around them. A heavy extension
   *  GET that skips it can: twelve people opening one worksheet together once
   *  stalled every other request for 30 s. Optional: older APIs do not offer
   *  it — fall back to calling the handler directly. */
  reads?: {
    /** Wrap a route handler so its whole body runs holding one slot. Reads
     *  the body makes that are gated themselves run inside it, never waiting
     *  for a second slot. The slot is let go when the client leaves first. */
    route<Req = any, Reply = any, R = unknown>(
      handler: (req: Req, reply: Reply) => Promise<R>,
      opts?: { label?: string }
    ): (req: Req, reply: Reply) => Promise<R>
  }
  /** Who holds what in the pipelines. Optional: older APIs do not offer it. */
  pipelines?: {
    /** Record ids of `collection` whose CURRENT step `userId` owns — the My
     *  Work / queue "mine" answer (owner groups, manual owners, teams,
     *  delegation). Seconds on a cold call; cached a minute per person and
     *  cleared when owners change. */
    ownedItemIds(userId: string, collection: string): Promise<string[]>
  }
  /** The role's read access for an extension's own raw-SQL read model.
   *  Optional: older APIs do not offer it. */
  access?: {
    /** `user` is the request's `req.user`. `allowed`: the role reads the
     *  collection at all. `apply(qb, alias)`: adds the role's row filter for
     *  rows of the collection under `alias`. User Scopes are not included.
     *  Admins: allowed, nothing applied. */
    readFilter(
      user: unknown,
      collection: string
    ): Promise<{ allowed: boolean; apply(qb: Knex.QueryBuilder, alias: string): void }>
  }
  /** Checked-in rows of a configuration collection, applied by a task —
   *  never at boot — with a drift report as its dry run. */
  seeds: { register(def: ConfigSeedDef): void }
  /** A versioned schema change the extension owns, run at load under the
   *  migration lock and recorded once per database (#826). */
  schema: { step(id: string, def: Omit<SchemaStepDef, 'id'>): void }
  /** Help videos (#1514): page keys for the Videos button, starter videos
   *  shipped with the extension, and screens to show them on. */
  helpVideos: {
    /** Name a page key (and its label) in the page registry authors pick from. */
    declarePage(def: HelpVideoPageDecl): void
    /** A package of starter videos, imported once per database as drafts. */
    registerStarter(def: HelpVideoStarterDef): void
    /** More screens for one starter video (by its id in a registered package),
     *  added when it is imported. */
    addContexts(videoId: string, contexts: HelpVideoContextDecl[]): void
  }
  chain: {
    /** Start a chain for one feed event (e.g. one shipment) and run fn inside it. */
    begin<T>(root: { source: string; ref: string }, fn: () => Promise<T>): Promise<T>
    /** The chain currently open, or null. */
    current(): { chain_id: string; parent: string | null } | null
    /** chain_id/chain_parent for an insert into a core table (probe-aware).
     *  A table outside ChainTable yields {}. */
    fields(
      table: ChainTable | (string & {}),
      opts?: { parent?: string | null }
    ): Promise<Record<string, string | null>>
  }
  integrations: {
    /** Declare an outbound obligation kind. Core owns the ledger and the
     *  sweep; the extension owns the sends. */
    registerObligationKind(def: ObligationKindDef): void
    /** Open an obligation for a decision point in the extension's own code.
     *  Null when no registered kind claims the context. */
    openObligation(
      ctx: ObligationTriggerContext,
      opts: { trigger: ObligationTrigger; trigger_ref?: string | null; due_at?: Date }
    ): Promise<number | null>
    /** Close an obligation with its outcome. A null id is a no-op. */
    resolveObligation(id: number | null, patch: ObligationResolvePatch): Promise<void>
    /** A signal on the Integrations console's Firefight list. */
    registerSignal(def: IntegrationSignal): void
    /** An action a signal row may offer (kind 'extension', id = def.id). */
    registerSignalAction(def: SignalActionHandler): void
    /** An event source on the Integrations console's Events feed. */
    registerEventSource(def: EventSourceDef): void
    /** A downstream node on the Traffic Map for the partner calls it matches (#1114). */
    registerTrafficNode(def: TrafficNodeDef): void
    /** Partner rules that turn a failed call into one plain sentence + a Fix it target; they run
     *  before the core rules. Optional: an older core has no such member. */
    registerErrorExplainers?(rules: IntegrationErrorRule[]): void
  }
  traffic: {
    /** A Traffic Map lens: node badges + an inspector panel from data `read` returns (#2229). */
    registerLens(def: TrafficLensDef): void
  }
  integrity: {
    /** A Data Integrity check the sweep, the record banner and Fix run. */
    registerCheck(check: IntegrityCheck): void
  }
  links: {
    /** The headless frontend's base URL + route map (Settings wins). */
    register(reg: LinkRegistration): void
  }
  mail: {
    /** An email type for the admin mail harness. */
    registerType(def: MailTypeDef): void
    /** Dry-run an active flow with a payload; what its mail op would send. */
    renderViaFlow(
      flowName: string,
      payload: Record<string, unknown>
    ): Promise<{ to: string; subject: string; html: string } | null>
    /** Render a named Liquid mail template (core or extension root). */
    renderTemplate(name: string, data: Record<string, unknown>): Promise<string>
  }
  flows: {
    /** A custom operation type: parsed options, current flow data, context. */
    registerOperation(op: FlowOpRegistration): void
    /** A custom trigger type; `flows.emit(type, payload)` fires it. */
    registerTrigger(trigger: FlowTriggerRegistration): void
    /** Fire every active flow on this trigger type. Fire-and-forget. */
    emit(triggerType: string, payload: Record<string, unknown>): void
  }
  /** Tools the AI chat bot may call, run as the asking user. */
  chatBot: { registerTool(def: BotToolDef): void }
  /** MCP tools (#2465): the hosted /api/mcp endpoint lists them by name and
   *  the npm server reaches them through `call_instance_tool`. The handler
   *  runs AS the MCP client's user. Optional — an older API does not provide it. */
  mcp?: ExtensionMcpMembers
  /** Ask AI tools (#2735): offered to Ask AI while it answers, run AS the
   *  asker. An answer that used one stays the asker's unless the tool is
   *  read-only AND declared replayable. Optional — an older API does not provide it. */
  ai?: ExtensionAiMembers
  /** Auth middleware — use as Fastify `onRequest` / `preHandler` handlers. */
  auth: {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
    requireAdmin: (req: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
  /** Cloud-only context — populated when CLOUD_META_DB_URL is set. */
  cloud?: {
    /** Immutable tenant UUID for the current request; undefined outside one. */
    getTenantId(): string | undefined
    /** Tenant slug for the current request; undefined outside one. */
    getTenantSlug(): string | undefined
    /** Knex client connected to the Nivaro Cloud meta database. */
    metaDb: Knex
  }
}

export interface ExtensionSettingDeclInput {
  key: string
  label: string
  type?: 'string' | 'number' | 'boolean' | 'secret'
  description?: string
  default?: string
  /** Legacy spelling of `type: 'secret'`. */
  secret?: boolean
  /** What production is expected to hold; the readiness scorecard warns
   *  when the live value differs. */
  production_expect?: string
  /** Refuse a value with a message (null = fine). */
  validate?: (value: ExtensionSettingValue) => string | null | Promise<string | null>
  /** Applied the moment a value is saved (no restart, no cache wait). */
  on_change?: (value: ExtensionSettingValue) => void | Promise<void>
}

/** A declared setting as the admin API serves it (types normalised,
 *  handlers reduced to flags). */
export interface ExtensionSettingDecl {
  key: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'secret'
  description?: string
  default?: string
  production_expect?: string
  has_validate?: boolean
  has_on_change?: boolean
}

/** An environment variable the extension reads. A missing REQUIRED one fails
 *  /api/preflight and the readiness scorecard by name; values are never
 *  reported. */
export interface ExtensionEnvDecl {
  name: string
  required?: boolean
  description?: string
  /** A credential: the registry says only whether it is set. */
  secret?: boolean
}

/**
 * A long, multi-step operator script the admin Runbooks console runs as a
 * detached process and watches (#720). A `local` runbook runs on the machine
 * serving the console (local development only); a `host` runbook is queued
 * from any instance and run by the host agent (`pnpm runbook:agent`) on the
 * machine that checked in for it. The script is started with
 * `npx tsx <script> <args> --events` (or `command`) from the api directory
 * and reports through `@@steps [names]` / `@@event {step, status, secs?,
 * lines?}` lines and a final `### DONE …` or `### FAILED at <step>: …`.
 */
export interface ExtensionRunbookDecl {
  /** Slug, unique within the extension. */
  key: string
  label: string
  description?: string
  /** Path relative to the api directory, inside this extension's folder.
   *  Required unless `command` is given. */
  script?: string
  /** Where the run executes: `local` (default) = the API's own machine,
   *  local development only; `host` = queued, run by the host agent. */
  runs_on?: 'local' | 'host'
  /** argv run from the api directory instead of `npx tsx <script>` (e.g.
   *  `['bash', 'extensions/<id>/scripts/job.sh', 'staging']`). The first
   *  element is bash, sh, node, npx or tsx; one element names a file inside
   *  this extension's folder. `--events` is not appended. */
  command?: string[]
  /** The phases the run reports (`@@event` step keys), in order — the
   *  console draws the track before any event arrives and offers
   *  "start from phase" (passed through `resume_flag`). */
  phases?: Array<{ key: string; label: string }>
  /** Host runbooks: directories (relative to the repository root, no `..`)
   *  holding past runs of the same job started OUTSIDE the console (a
   *  nightly cron), one sub-directory per run. The host agent reads their
   *  phase timings into the console's estimates: a `summary.txt` with
   *  `=== <n>-<phase> END … exit=0 elapsed=<m>m<s>s ===` lines, and per
   *  phase a `<n>-<phase>.log` whose `─── <step> done in <m>m<ss>s ───` lines
   *  are that phase's sub-steps. A run directory holding a
   *  `.nivaro-runbook-run` file was started by the console and is skipped
   *  (the queue already timed it). */
  history_dirs?: Array<{ path: string; mode: 'dry' | 'go' }>
  /** Arguments of the dry run — the report the console demands first. */
  dry_args: string[]
  /** Arguments of the real run. */
  go_args: string[]
  /** The flag that resumes at a step (`--from`); absent = no resume. */
  resume_flag?: string
  /** Environment variable the operator points at a target (DB_DATABASE). */
  target_env?: string
  /** Targets refused outright (production is run by hand). */
  refuse_targets?: string[]
  /** A real run needs no finished dry run first. Only for runbooks that
   *  write nothing to their target (a read-only check), never a rebuild. */
  skip_dry_gate?: boolean
}

/** The default export of an extension's entry module. */
export interface ExtensionDefinition {
  id: string
  register(ctx: ExtensionContext): void | Promise<void>
  /** Permission scopes: what this extension touches — a declared manifest
   *  shown before enabling, not an enforcement boundary. */
  scopes?: string[]
  /** Extension ids that must load FIRST. */
  requires?: string[]
  /** Command-palette entries served to the admin palette. */
  palette?: Array<{ label: string; path: string }>
  /** Admin-editable settings, stored in nivaro_extension_settings. */
  settings?: ExtensionSettingDeclInput[]
  /** Freeform declared capabilities ('routes', 'cron', 'hooks', …). */
  capabilities?: string[]
  /** Quick self-check surfaced on the Extensions page. */
  healthCheck?(): Promise<{ ok: boolean; note?: string }>
  /** The environment variables this extension reads. */
  env?: ExtensionEnvDecl[]
  /** Operator runbooks the admin Runbooks console runs (#720). */
  runbooks?: ExtensionRunbookDecl[]
  /** Staging quality checks: path of the checks module (a QualityCheckModule),
   *  relative to the API root, e.g. 'extensions/my-ext/scripts/quality/index.ts'. */
  quality_checks?: string
  /** Key of this extension's own host runbook that re-runs its quality checks
   *  (declared in `runbooks` with runs_on 'host' and skip_dry_gate). The
   *  quality console's Re-run button queues exactly this runbook. */
  quality_rerun?: string
  /** Which build this is (a commit sha, a release id), shown on GET
   *  /api/extensions so a deploy can check the expected build is mounted.
   *  Omit it to use the `.release-sha` file beside the extension (#1089). */
  build?: string
}
