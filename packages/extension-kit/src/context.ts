import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Knex } from 'knex'
import type { FlowOpRegistration, FlowTriggerRegistration } from './flows.js'
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
import type { IntegrationSignal, SignalActionHandler, TrafficNodeDef } from './signals.js'

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
  }
  /** Bulk actions in the collection browser / queue selection bar. */
  bulkActions: { register(def: BulkActionDef): void }
  /** Contextual buttons in the record form's toolbar. */
  itemActions: { register(def: ItemActionDef): void }
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
  /** Checked-in rows of a configuration collection, applied by a task —
   *  never at boot — with a drift report as its dry run. */
  seeds: { register(def: ConfigSeedDef): void }
  /** A versioned schema change the extension owns, run at load under the
   *  migration lock and recorded once per database (#826). */
  schema: { step(id: string, def: Omit<SchemaStepDef, 'id'>): void }
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
