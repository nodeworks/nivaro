import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SCAN_DIRS, scanModuleState } from './module-state-scan.js'

// Hub phase 6 Task 22 (ruling P6-4): the phase-wide sweep of module-level state. One process of a
// Hub shared deployment serves many apps (and Nivaro Cloud many tenants), often copies of each
// other — same collection names, same record and user ids. Every module-level Map / Set / `let` /
// written literal / cache factory under the scanned folders (module-state-scan.ts) is either
//
//   keyed per app    detected by the scan (tenantState() / appMap() / appSet() / appBox(), or every
//                    write's key names the app), or listed in KEYED with how its key names the app;
//   process-wide     listed in SHARED with why it may be shared by every app on the process.
//
// Self-hosted the app key is '' (one app), so keying changes nothing there. A new module-level
// state fails here until it is keyed or listed; a listed one that is gone (or is now detected as
// keyed) fails as stale. Folds in Task 13's hook-module guard (its modules are all scanned here).

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '../../..')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

const TENANT_REF =
  /currentTenantKey\(|getTenantId\(|tenantState\(|appKey\(|appKeyPart\(|dropAppEntries\(|tenantScopedRoom\(|currentStoreId\(|AsyncLocalStorage\.snapshot\(|\btenantStoreId\(/

// ── reasons ──
const APP_REF = 'the Fastify / Socket.io instance of this process (one per process)'
const REGISTRY = 'registered by code at boot, or a register-once flag: the same for every app'
const DIAG = 'process diagnostics (counts, timings, a log-once flag), no app data'
const FIXED = 'a fixed lookup table: exported or passed on for reading, never written'
const CHAOS = 'chaos drills never run on a multi-tenant deployment (chaos/gate.ts)'
const HUB_ONLY = 'Hub-only (HUB=on), which a shared deployment refuses (deploymentModeProblem)'
const HUB_LINK =
  'hub link of a dedicated app: never mounted on a shared deployment (one app per process)'
const RETIRE =
  'retire state of a dedicated app process (Task 9): one app per dedicated process, never a shared deployment'
const TIMER = 'a timer handle of this process'
const CONN = 'a Redis / database connection of this process'
const FN_SLOT = 'a function slot set once at boot or by tests (code, not data)'
const WEAK =
  'WeakMap / WeakSet keyed by a per-request or per-object value (request, context, schema, row object): nothing outlives its object'
const GEN = 'a change counter; any app moving it only makes readers refetch'
const PROC = 'process / machine state (event loop, pool, boot phases, node signals), no app data'
const CFG = 'configuration of this process (environment)'
const LAZY = 'a lazily imported module or code-built object'
const PATCH = 'a driver patch applied once per process (code)'
const DB_KEYED = 'keyed by the database itself (host / name): each app has its own database'
const DB_HEALTH =
  "health of this process's own configured database (the static DB_* pool), not an app's"
const STATIC_DB =
  "a connection to this process's own configured database (static DB_*), not an app's"
const L2 =
  "metadata L2 serves only the static primary database's reads (usable() refuses any other scope); app databases never match"
const RT_BOARD = 'the realtime board of this process: its entries are keyed by tenant-scoped rooms'
const STORAGE =
  'the storage provider of this process; keys are app-scoped under the hub source (Task 11)'
const TELEMETRY =
  'Traffic Map / telemetry of the whole deployment (counters, timers, taps, node health); per-app map data lives in the per-store maps, one store per tenant'
const TM_ACTIONS =
  'Traffic Map breakers / timed rules are deployment operator actions; their Redis sync never starts on a multi-tenant deployment'
const CACHE_CFG =
  'stored cache config is never read on a multi-tenant deployment (env + defaults only)'
const HUBSIGNIN_PER_CLIENT =
  "keyed by the Hub + the app's own client id (each app on a shared deployment has its own client from the tenant list; never in Nivaro Cloud)"
const HUBSIGNIN_PUBLIC =
  "public signing keys by key-set URL (the Hub's, the deployment's own Microsoft tenant): no app data"
const OFF_PERMCACHE =
  'the permission cache is off on any multi-tenant deployment (cache-config permission.enabled)'
const OFF_EPOCH = 'the config epoch is off on any multi-tenant deployment (config-epoch.ts ENABLED)'
const OFF_CHANGEWARM =
  'change warms never run on a multi-tenant deployment (cache-warm-on-change.ts)'
const OFF_DOCKER = 'Docker sources answer nothing on a multi-tenant deployment (docker-source.ts)'
const OFF_STORED_LIMITS =
  'stored export limits are never read on a multi-tenant deployment (env + defaults only)'
const OFF_MEDIA_HANDOFF =
  'media hand-offs are off on any multi-tenant deployment (media-handoff.ts)'
const OFF_FILES_FALLBACK =
  'the source-environment file fallback is off on any multi-tenant deployment'
const OFF_DRIFT =
  'config drift is never tracked on a multi-tenant deployment (config-drift/store.ts)'

/** Process-wide by design (never app data on a shared deployment), with why. */
const SHARED: Record<string, string> = {
  'realtime-server.ts :: served':
    'the routes this realtime-only process registered at boot (code, the same for every app)',
  'db/metadata-query-cache.ts :: counters': DIAG,
  'middleware/authenticate.ts :: identityCounters': DIAG,
  'routes/collection-layouts.ts :: layoutBundleCounters': DIAG,
  'routes/presence.ts :: presenceOnlineCounters': DIAG,
  'services/collection-live-mode.ts :: stats': DIAG,
  'services/event-journal.ts :: replayStats': DIAG,
  'services/related-announce.ts :: stats': DIAG,
  'services/permission-cache.ts :: entries': OFF_PERMCACHE,
  'auth/hub-signin.ts :: discoveries': HUBSIGNIN_PER_CLIENT,
  'auth/hub-signin.ts :: hubRequestTimeoutS':
    'the Hub request timeout in seconds: a constant only tests change (no app data)',
  'auth/hub-signin.ts :: keySets': HUBSIGNIN_PUBLIC,
  'auth/login-limits.ts :: lastFailOpenWarn': DIAG,
  'auth/oidc.ts :: _dynConfigs':
    "discovery metadata keyed by provider row id but every hit is checked against that row's issuer + client id + secret (sig) before use: an app never gets discovery for another app's provider",
  'auth/oidc.ts :: _oidcConfig': CFG,
  'auth/saml.ts :: _redis': CONN,
  'auth/saml.ts :: _saml': CFG,
  'auth/saml.ts :: memory':
    'fallback store (Redis down) for random SAML request ids; ids are unique per request and hold no app data',
  'auth/saml.ts :: seenMemory':
    'assertion replay memory keyed by a hash of the signed assertion; an assertion seen once is refused anywhere, which is the point',
  'auth/secret-policy.ts :: KNOWN_PLACEHOLDER_SECRETS': FIXED,
  'db/chaos-seam.ts :: dbChaos': CHAOS,
  'db/config-epoch.ts :: WATCHED_SET': OFF_EPOCH,
  'db/config-epoch.ts :: bumpGen': OFF_EPOCH,
  'db/config-epoch.ts :: bumpsInFlight': OFF_EPOCH,
  'db/config-epoch.ts :: direct': OFF_EPOCH,
  'db/config-epoch.ts :: dirty': OFF_EPOCH,
  'db/config-epoch.ts :: handlers': OFF_EPOCH,
  'db/config-epoch.ts :: knexRef': OFF_EPOCH,
  'db/config-epoch.ts :: lastAssignedSeq': OFF_EPOCH,
  'db/config-epoch.ts :: lastBumpAt': OFF_EPOCH,
  'db/config-epoch.ts :: lastReadAt': OFF_EPOCH,
  'db/config-epoch.ts :: lastStatement': OFF_EPOCH,
  'db/config-epoch.ts :: latestKnown': OFF_EPOCH,
  'db/config-epoch.ts :: missingUntil': OFF_EPOCH,
  'db/config-epoch.ts :: moves': OFF_EPOCH,
  'db/config-epoch.ts :: opSeq': OFF_EPOCH,
  'db/config-epoch.ts :: own': OFF_EPOCH,
  'db/config-epoch.ts :: pending': OFF_EPOCH,
  'db/config-epoch.ts :: pollFailing': OFF_EPOCH,
  'db/config-epoch.ts :: primed': OFF_EPOCH,
  'db/config-epoch.ts :: remoteClear': OFF_EPOCH,
  'db/config-epoch.ts :: appOnlyClear':
    'a flag set only for the synchronous span of one app-only clear (runAppOnlyClear), inside that app',
  'db/config-epoch.ts :: resetListeners': OFF_EPOCH,
  'db/config-epoch.ts :: run': OFF_EPOCH,
  'db/config-epoch.ts :: seen': OFF_EPOCH,
  'db/config-epoch.ts :: stampListeners': OFF_EPOCH,
  'db/config-epoch.ts :: watcher': OFF_EPOCH,
  'db/config-epoch.ts :: writeListeners': `${REGISTRY} (on a shared deployment: the per-app config announcer, services/app-config-epoch.ts)`,
  'db/config-epoch.ts :: writesSeen': OFF_EPOCH,
  'db/connect-retry.ts :: lastWarnAt': DIAG,
  'db/index.ts :: migrationKnex': STATIC_DB,
  'db/index.ts :: probeKnex': STATIC_DB,
  'db/metadata-l2.ts :: counters': L2,
  'db/metadata-l2.ts :: downUntil': L2,
  'db/metadata-l2.ts :: epochs': L2,
  'db/metadata-l2.ts :: identityAt': L2,
  'db/metadata-l2.ts :: identityDb': L2,
  'db/metadata-l2.ts :: identityListeners': L2,
  'db/metadata-l2.ts :: identityLoading': L2,
  'db/metadata-l2.ts :: identitySource': L2,
  'db/metadata-l2.ts :: identityTag': L2,
  'db/metadata-l2.ts :: inIdentityChange': L2,
  'db/metadata-l2.ts :: knownTag': L2,
  'db/metadata-l2.ts :: primaryScope': L2,
  'db/metadata-l2.ts :: recentGens': L2,
  'db/metadata-l2.ts :: redis': L2,
  'db/metadata-query-cache.ts :: WRITE_TABLES': FIXED,
  'db/metadata-query-cache.ts :: cache': DB_KEYED,
  'db/metadata-query-cache.ts :: generation': GEN,
  'db/metadata-query-cache.ts :: inflight': DB_KEYED,
  'db/mysql-ddl-compat.ts :: done': PATCH,
  'db/mysql-flavor.ts :: bindingsPatched': PATCH,
  'db/mysql-flavor.ts :: columnTypeCache': DB_KEYED,
  'db/ops-signal.ts :: listeners': REGISTRY,
  'db/owner-signal.ts :: listeners': REGISTRY,
  'db/owner-signal.ts :: raised': DIAG,
  'db/people-signal.ts :: listeners': REGISTRY,
  'db/pg-utc.ts :: done': PATCH,
  'db/sqlite-tenant.ts :: replacing':
    'database files a move is replacing now, keyed by the file: each SQLite app has its own file',
  'db/sqlite-tenant.ts :: heldFiles':
    'lock releases keyed by the database file: each SQLite app has its own file (app-db/<tenant id>/)',
  'db/sqlite-transfer.ts :: busyFiles':
    'database files a copy is being made of now, keyed by the file: each SQLite app has its own file',
  'db/sqlite-transfer.ts :: reservedBytes':
    'bytes copies in flight reserve, keyed by the volume (device id): the room every app on it shares',
  'db/sqlite-transfer.ts :: checkers':
    'running integrity-check child processes, killed at process exit; each checks one copy',
  'db/sqlite-transfer.ts :: checkerExitHook': PROC,
  'services/hub-transfer/database-jobs.ts :: jobs':
    'database copy and checksum jobs keyed by `<app scope>|<job id>`: each app reads only its own; forgotten when the app leaves',
  'db/sqlite.ts :: heldLockReleases':
    'lock-file releases keyed by the database file (one per SQLite app), run at process exit',
  'db/sqlite.ts :: exitListening': PROC,
  'db/sqlite.ts :: fileWriteLocks':
    'one write lock per database file: each SQLite app has its own file, so its own lock',
  'db/sqlite.ts :: likes': 'compiled LIKE patterns by pattern text; no app data',
  'db/sqlite.ts :: patched': PATCH,
  'db/sqlite.ts :: regexps': 'compiled regular expressions by pattern text; no app data',
  'db/tenant-context.ts :: poolCreatedHooks': `${REGISTRY} (driver seams for every app pool)`,
  'db/tenant-context.ts :: pools':
    'one knex per connection string: each app has its own connection string, so its own pool',
  'extensions/loader.ts :: _app': APP_REF,
  'extensions/loader.ts :: deprecatedMemberUses': DIAG,
  'extensions/loader.ts :: extensionEnvDecls': REGISTRY,
  'extensions/loader.ts :: extensionHealthChecks': REGISTRY,
  'extensions/loader.ts :: extensionLogs':
    'log lines of the extension code this process loaded (one code base for every app); admins of the deployment read them',
  'extensions/loader.ts :: extensionQualityRerun': REGISTRY,
  'extensions/loader.ts :: extensionRegistrations': REGISTRY,
  'extensions/loader.ts :: extensionRegistry': REGISTRY,
  'extensions/loader.ts :: extensionRoutes': REGISTRY,
  'extensions/loader.ts :: extensionRunbooks': REGISTRY,
  'extensions/loader.ts :: extensionSettingsDecls': REGISTRY,
  'extensions/loader.ts :: observedCapabilities': REGISTRY,
  'extensions/loader.ts :: settingsReadinessRegistered': REGISTRY,
  'extensions/loader.ts :: sharedExtensionsReadinessRegistered': REGISTRY,
  'extensions/loader.ts :: sharedRefusals':
    'what this shared deployment refused at boot (extension ids and reasons), the same for every app',
  'flows/registry.ts :: _listeners': REGISTRY,
  'flows/registry.ts :: _ops': REGISTRY,
  'flows/registry.ts :: _triggers': REGISTRY,
  'flows/registry.ts :: executorModule': LAZY,
  'flows/tenant-event-flows.ts :: started': APP_REF,
  'hooks/agent-triggers.ts :: registered': REGISTRY,
  'hooks/aggregate-caps.ts :: _app': APP_REF,
  'hooks/ai-validation.ts :: _app': APP_REF,
  'hooks/ai-validation.ts :: loggedNoKey': DIAG,
  'hooks/alerts.ts :: _app': APP_REF,
  'hooks/core-hooks.ts :: registered': REGISTRY,
  'hooks/cross-triggers.ts :: _app': APP_REF,
  'hooks/embeddings.ts :: _app': APP_REF,
  'hooks/field-watches.ts :: _app': APP_REF,
  'hooks/notification-subscriptions.ts :: _app': APP_REF,
  'hooks/record-integrity.ts :: queue':
    "process queue (CONCURRENCY is per process); each entry carries its app and is checked inside that app's context",
  'hooks/record-integrity.ts :: running': 'process worker count (CONCURRENCY is per process)',
  'lib/client-credential.ts :: accepted': WEAK,
  'lib/drain-streams.ts :: endless': 'open HTTP responses of this process, ended at shutdown',
  'lib/ssrf.ts :: allowCache': CFG,
  'lib/trust-proxy.ts :: cached': CFG,
  'middleware/authenticate.ts :: identityGen': GEN,
  'middleware/authenticate.ts :: identityRegistered': REGISTRY,
  'middleware/authenticate.ts :: identitySeamAttached': REGISTRY,
  'middleware/authenticate.ts :: identitySeams': WEAK,
  'plugins/api-logger.ts :: internalDispatchStamps':
    "random one-request tokens of this process's in-process dispatches, removed as soon as read",
  'plugins/api-logger.ts :: internalDispatchTokens':
    "random one-request tokens of this process's in-process dispatches, removed as soon as read",
  'plugins/cron.ts :: holdSeq': GEN,
  'plugins/cron.ts :: securityModule': LAZY,
  'plugins/etag.ts :: ETAG_ROUTES': FIXED,
  'plugins/graphql.ts :: _everBuilt': DIAG,
  'plugins/metrics.ts :: loopHist': TELEMETRY,
  'plugins/metrics.ts :: series': TELEMETRY,
  'plugins/socketio.ts :: _ioRef': APP_REF,
  'plugins/socketio.ts :: broadcastRoom':
    'the room being written during one synchronous adapter call; rooms carry the app (tenantScopedRoom)',
  'plugins/socketio.ts :: pagePrefixReader': FN_SLOT,
  'plugins/socketio.ts :: pagePresenceReader': FN_SLOT,
  'plugins/socketio.ts :: pageSnapshotReader': FN_SLOT,
  'services/flow-script-isolated.ts :: headroomReader': FN_SLOT,
  'services/flow-script-isolated.ts :: headroomUnreadableWarned': DIAG,
  'plugins/socketio.ts :: presenceNoter': FN_SLOT,
  'plugins/socketio.ts :: socketMeta': 'per socket id; each socket is bound to its app',
  'routes/access-requests.ts :: digestRegistered': REGISTRY,
  'routes/activity.ts :: CLIENT_ACTIVITY_ACTIONS': FIXED,
  'routes/auth.ts :: dummyHash':
    'a bcrypt hash of a fixed dummy password (timing equaliser); no app data',
  'routes/chaos-ops.ts :: pushTries': CHAOS,
  'routes/chaos-report.ts :: readinessRegistered': REGISTRY,
  'routes/collection-layouts.ts :: driftCheckRegistered': REGISTRY,
  'routes/collection-layouts.ts :: layoutBundleGen': GEN,
  'routes/collection-layouts.ts :: layoutBundleWired': REGISTRY,
  'routes/config-conformance.ts :: agreementCheckRegistered': REGISTRY,
  'routes/custom-queries.ts :: shapeCheckRegistered': REGISTRY,
  'routes/erp-submissions.ts :: ERP_STATUSES': FIXED,
  'routes/external-apis.ts :: readinessRegistered': REGISTRY,
  'routes/flows.ts :: flowHealthCheckRegistered': REGISTRY,
  'services/app-seeds.ts :: seeds': `${REGISTRY}; each seed runs inside the app it seeds`,
  'services/app-pool-pressure.ts :: listening': WEAK,
  'services/app-pool-pressure.ts :: sampler': TIMER,
  'services/app-config-epoch.ts :: wiring': `${CONN} (its publish function), set once at boot`,
  'services/app-config-epoch.ts :: announced': DIAG,
  'services/app-config-epoch.ts :: heard': DIAG,
  'routes/geocode-suggest.ts :: cache':
    'public geocoder answers keyed by the typed address text; the same for every app',
  'routes/geocode-suggest.ts :: lastCall':
    'rate pacing of calls to the public geocoder from this process',
  'routes/geocode.ts :: cache':
    'public geocoder answers keyed by the address text; the same for every app',
  'routes/geocode.ts :: lastCall': 'rate pacing of calls to the public geocoder from this process',
  'routes/health.ts :: changelogCache': "the image's own changelog file",
  'routes/hub-create.ts :: memoryTries': HUB_ONLY,
  'routes/hub-docker.ts :: checkNameSeen': HUB_ONLY,
  'routes/hub-link.ts :: boundMs': HUB_LINK,
  'routes/hub-link.ts :: flightStaleMs': HUB_LINK,
  'routes/hub-link.ts :: lastPreflight': HUB_LINK,
  'routes/hub-link.ts :: preflightFlight': HUB_LINK,
  'routes/hub-oidc.ts :: signinRecordWaitMs': HUB_ONLY,
  'routes/hub-shared.ts :: reapplyAfterRotation': HUB_ONLY,
  'routes/infrastructure-host.ts :: checksRegistered': REGISTRY,
  'routes/integration-obligations.ts :: noteSourcesRegistered': REGISTRY,
  'routes/integration-obligations.ts :: readinessRegistered': REGISTRY,
  'routes/internal-file-source.ts :: readinessRegistered': REGISTRY,
  'routes/internal-render.ts :: readinessRegistered': REGISTRY,
  'routes/item-locks.ts :: _app': APP_REF,
  'routes/layout-collab.ts :: memoryHits':
    'fallback (Redis down) rate counter keyed by a random preview-link token + the caller address; counts only',
  'routes/mail-log.ts :: relayCheckRegistered': REGISTRY,
  'routes/mail-log.ts :: retryCheckRegistered': REGISTRY,
  'routes/mcp.ts :: mcpModules': LAZY,
  'routes/ops-db.ts :: deadColumnsCheckRegistered': REGISTRY,
  'routes/ops-runtime.ts :: cpuProfileRunning':
    'one CPU profile of this process at a time (the profile is of the process, not an app)',
  'routes/partner-dependencies.ts :: readinessRegistered': REGISTRY,
  'routes/pipelines.ts :: ownerFilterCheckRegistered': REGISTRY,
  'routes/pool-holders.ts :: checkRegistered': REGISTRY,
  'routes/preflight.ts :: rootReadinessRegistered': REGISTRY,
  'routes/presence.ts :: PRESENCE_HEARTBEAT_ROUTES': FIXED,
  'routes/presence.ts :: lastNotRecordedLog': DIAG,
  'routes/stream.ts :: clients':
    "per open response; each stream records the tenant it was opened under and only gets that app's events",
  'routes/stream.ts :: hooksRegistered': REGISTRY,
  'routes/support.ts :: sendClaims':
    'fallback (Redis down) for the claim key nvr:support-send:<tenant>:…, which already carries the app',
  'routes/tracker-hooks.ts :: verified': WEAK,
  'routes/traffic-map-extras/topology.ts :: providersRegistered': REGISTRY,
  'routes/user-scopes.ts :: rawSqlCheckRegistered': REGISTRY,
  'routes/users.ts :: identityTouchListening': REGISTRY,
  'services/access-pending.ts :: accessPendingRefusals': WEAK,
  'services/access-stamp.ts :: bumpListeners': REGISTRY,
  'services/access-stamp.ts :: generation': GEN,
  'services/activity-trail/lock.ts :: held':
    'names of tenants this process holds the sealer lock for (the set is keyed by tenant)',
  'services/activity-trail/lock.ts :: override': CONN,
  'services/activity-trail/readiness.ts :: registered': REGISTRY,
  'services/activity.ts :: _pulseApp': APP_REF,
  'services/addendum-approve.ts :: PARENT_WRITE_BLOCKED_COLUMNS': FIXED,
  'services/addendum-summary.ts :: FINAL_ADDENDUM_STATUSES': FIXED,
  'services/ai-actions.ts :: RECORD_WRITE_ACTIONS': FIXED,
  'services/ai-allowance.ts :: byOwner': REGISTRY,
  'services/ai-allowance.ts :: checks': REGISTRY,
  'services/ai-answer-code.ts :: CODE_TOOLS': FIXED,
  'services/ai-catalogue.ts :: registered': REGISTRY,
  'services/ai-chat.ts :: BUILTIN_TOOL_NAMES': FIXED,
  'services/ai-chat.ts :: FILTER_OPS': FIXED,
  'services/ai-client.ts :: bearerCache':
    'keyed by the gateway token URL + client id: one token per credential, whoever asks',
  'services/ai-client.ts :: fallbackCount': DIAG,
  'services/ai-client.ts :: imageFallbackLogged': DIAG,
  'services/ai-client.ts :: imageFallbacks': DIAG,
  'services/ai-context-tool-defs.ts :: CONTEXT_TOOL_NAMES': FIXED,
  'services/ai-conversations.ts :: EXPORTABLE_TOOLS': FIXED,
  'services/ai-conversations.ts :: REPLAYABLE_TOOLS': FIXED,
  'services/ai-explain-weekly.ts :: registered': REGISTRY,
  'services/ai-explain.ts :: memory':
    'content-addressed: a hash of the exact instructions and facts, so the same input gives the same answer',
  'services/ai-health.ts :: registered': REGISTRY,
  'services/ai-knowledge-check.ts :: timer': TIMER,
  'services/ai-knowledge-suggest.ts :: correctionSources': REGISTRY,
  'services/ai-local-dates.ts :: formatters': 'date formatters by time zone; no app data',
  'services/ai-panel-tool-defs.ts :: PANEL_TOOL_NAMES': FIXED,
  'services/ai-panel-tools.ts :: VIEW_OPS': FIXED,
  'services/ai-panel.ts :: ANSWER_COMMANDS': FIXED,
  'services/ai-plan-steps.ts :: kinds': REGISTRY,
  'services/ai-quality.ts :: fallbackNotes':
    'keyed by a random request id; read back by that request only',
  'services/ai-query-widget.ts :: AI_QUERY_TOOLS': FIXED,
  'services/ai-replay.ts :: replayRuns':
    'keyed by a random run id; a run is shown only to its admin in its own Traffic Map store (canSeeReplay)',
  'services/ai-routing.ts :: MAIN_MODEL_TOOLS': FIXED,
  'services/ai-stream-delivery.ts :: active':
    'keyed by a random stream id (unguessable) and checked against the asker; holds a stop function, no app data',
  'services/ai-tool-reuse.ts :: REUSABLE_TOOLS': FIXED,
  'services/ai-tool-reuse.ts :: everythingChangedAt':
    'a system-table change in any app makes every app re-run its tools: it only ever makes reuse stricter',
  'services/ai-tool-reuse.ts :: listeningSince':
    'when this process started listening for change events (a process fact)',
  'services/ai-tool-reuse.ts :: wired': REGISTRY,
  'services/ai-topic-map.ts :: vecCache':
    'content-addressed: embedding of a question text by model tag + text hash',
  'services/ai-watch-tool-defs.ts :: WATCH_TOOL_NAMES': FIXED,
  'services/ai-watches.ts :: digestRegistered': REGISTRY,
  'services/ai-watches.ts :: evaluator': FN_SLOT,
  'services/alert-fired.ts :: listeners': REGISTRY,
  'services/app-boot-passes.ts :: bootPassQueue':
    "the process-wide turn queue for every app's boot passes (code scheduling: at most two apps at once on this process); it holds wake-up callbacks, no app data",
  'services/app-boot-passes.ts :: bootQueryWarmQueue':
    'the process-wide turn queue for the boot query warms (code scheduling: at most two at once on this process); it holds wake-up callbacks, no app data',
  'services/app-forget.ts :: registered':
    'the hand-keyed containers themselves (forgetAppState walks them); holds no app data',
  'services/app-links.ts :: registered': REGISTRY,
  'services/app-state.ts :: registered':
    'the per-app containers themselves (forgetAppState walks them); holds no app data',
  'services/approval-brief-lines.ts :: providers': REGISTRY,
  'services/approval-changes.ts :: resolvedIds': WEAK,
  'services/background-inflight.ts :: running':
    'background work in flight in this process (kind + label), for the shutdown drain and the stall watchdog',
  'services/background-inflight.ts :: seq': GEN,
  'services/background-runs.ts :: mem':
    'fallback (Redis down) for the run keys nvr:bgrun:<tenant>:…, which already carry the app',
  'services/batch-read.ts :: BATCH_READ_QUERY_KEYS': FIXED,
  'services/boot-phases.ts :: phases': PROC,
  'services/boot-phases.ts :: readyAt': PROC,
  'services/boot-phases.ts :: shuttingDownAt': PROC,
  'services/boot-phases.ts :: stored': PROC,
  'services/bulk-actions.ts :: BUILTIN_KEYS': FIXED,
  'services/business-hours.ts :: wallCache': 'wall-clock parts by time zone + instant; no app data',
  'services/business-hours.ts :: wallCacheSize':
    'wall-clock parts by time zone + instant; no app data',
  'services/business-hours.ts :: zoneFormatters': 'date formatters by time zone; no app data',
  'services/cache-config.ts :: effective': CACHE_CFG,
  'services/cache-config.ts :: inflight': CACHE_CFG,
  'services/cache-config.ts :: listeners': REGISTRY,
  'services/cache-config.ts :: loaded': CACHE_CFG,
  'services/cache-config.ts :: loadedAt': CACHE_CFG,
  'services/cache-config.ts :: registered': REGISTRY,
  'services/cache-config.ts :: stored': CACHE_CFG,
  'services/cache-config.ts :: timer': TIMER,
  'services/cache-registry.ts :: registry': REGISTRY,
  'services/cache-warm-on-change.ts :: active': OFF_CHANGEWARM,
  'services/cache-warm-on-change.ts :: allowed': OFF_CHANGEWARM,
  'services/cache-warm-on-change.ts :: allowedAt': OFF_CHANGEWARM,
  'services/cache-warmers.ts :: warmers': REGISTRY,
  'services/changed-filter.ts :: resolved': WEAK,
  'services/chaos/armed-visibility.ts :: resolver': CHAOS,
  'services/chaos/blind.ts :: bus': CHAOS,
  'services/chaos/blind.ts :: stopAllWired': CHAOS,
  'services/chaos/blind.ts :: sub': CHAOS,
  'services/chaos/blind.ts :: windows': CHAOS,
  'services/chaos/catalog.ts :: faults': CHAOS,
  'services/chaos/chaos-ai-tool.ts :: CHAOS_TOOL_NAMES': CHAOS,
  'services/chaos/claims.ts :: claims': CHAOS,
  'services/chaos/clock.ts :: offsetMs': CHAOS,
  'services/chaos/cron-test-job.ts :: manager': CHAOS,
  'services/chaos/db-point.ts :: curSql': CHAOS,
  'services/chaos/db-point.ts :: curTable': CHAOS,
  'services/chaos/drill.ts :: hooks': CHAOS,
  'services/chaos/drill.ts :: jobRuns': CHAOS,
  'services/chaos/drill.ts :: wired': CHAOS,
  'services/chaos/faults/pool.ts :: holds': CHAOS,
  'services/chaos/faults/pool.ts :: source': CHAOS,
  'services/chaos/faults/process.ts :: heap': CHAOS,
  'services/chaos/faults/process.ts :: retained': CHAOS,
  'services/chaos/gameday.ts :: localClaims': CHAOS,
  'services/chaos/gameday.ts :: timers': CHAOS,
  'services/chaos/gameday.ts :: tries': CHAOS,
  'services/chaos/matrix.ts :: placements': CHAOS,
  'services/chaos/monitors.ts :: alertSeen': CHAOS,
  'services/chaos/monitors.ts :: deps': CHAOS,
  'services/chaos/monitors.ts :: unsubs': CHAOS,
  'services/chaos/monitors.ts :: watches': CHAOS,
  'services/chaos/partition-point.ts :: catchUp': CHAOS,
  'services/chaos/partition-point.ts :: deliveries': CHAOS,
  'services/chaos/partition.ts :: expectedHere': CHAOS,
  'services/chaos/preflight-hook.ts :: wired': CHAOS,
  'services/chaos/preflight.ts :: activeDeps': CHAOS,
  'services/chaos/preflight.ts :: builtIns': CHAOS,
  'services/chaos/preflight.ts :: checks': CHAOS,
  'services/chaos/presets.ts :: forcedMode': CHAOS,
  'services/chaos/presets.ts :: mem': CHAOS,
  'services/chaos/presets.ts :: tableSeen': CHAOS,
  'services/chaos/push-stop.ts :: bus': CHAOS,
  'services/chaos/push-stop.ts :: pushOverride': CHAOS,
  'services/chaos/push-stop.ts :: spent': CHAOS,
  'services/chaos/recovery.ts :: watching': CHAOS,
  'services/chaos/recovery.ts :: wired': CHAOS,
  'services/chaos/redis-hook.ts :: errorTimes': CHAOS,
  'services/chaos/redis-hook.ts :: stats': CHAOS,
  'services/chaos/redis-samplers.ts :: last': CHAOS,
  'services/chaos/registry.ts :: appRef': CHAOS,
  'services/chaos/registry.ts :: armed': CHAOS,
  'services/chaos/registry.ts :: bus': CHAOS,
  'services/chaos/registry.ts :: byPoint': CHAOS,
  'services/chaos/registry.ts :: listeners': CHAOS,
  'services/chaos/registry.ts :: stopAllHooks': CHAOS,
  'services/chaos/registry.ts :: subscribed': CHAOS,
  'services/chaos/runs.ts :: forcedMode': CHAOS,
  'services/chaos/runs.ts :: memEvents': CHAOS,
  'services/chaos/runs.ts :: memRuns': CHAOS,
  'services/chaos/runs.ts :: tableSeen': CHAOS,
  'services/chaos/settings.ts :: testOverride': CHAOS,
  'services/chaos/steady-state.ts :: builtIns': CHAOS,
  'services/chaos/steady-state.ts :: ring': CHAOS,
  'services/chaos/steady-state.ts :: samplers': CHAOS,
  'services/chaos/steady-state.ts :: watches': CHAOS,
  'services/chaos/steady-state.ts :: wired': CHAOS,
  'services/chat-bot-audience.ts :: RECORD_TOOLS': FIXED,
  'services/chat-bot-stream.ts :: owners':
    'owner of a random chat-bot stream id (who may stop it); grants nothing',
  'services/chat-bot.ts :: extensionBotTools': REGISTRY,
  'services/chat-commands.ts :: commands': REGISTRY,
  'services/chat-commands.ts :: isEnabled': FN_SLOT,
  'services/chat-digest.ts :: registered': REGISTRY,
  'services/chat-link-preview.ts :: memory':
    'cache of a public URL preview keyed by the URL hash; holds no app data',
  'services/chat-message-actions.ts :: actions': REGISTRY,
  'services/chat-message-actions.ts :: isEnabled': FN_SLOT,
  'services/chat-send.ts :: claimed':
    'claims of chat client ids under the key nvr:chatcid:<app part>…, which already carries the app',
  'services/chat.ts :: relayClear': FN_SLOT,
  'services/coedit-fields.ts :: SAVE_META_KEYS': FIXED,
  'services/collections.ts :: metadataGen': GEN,
  'services/comment-listeners.ts :: isEnabled': FN_SLOT,
  'services/comment-listeners.ts :: listeners': REGISTRY,
  'services/command-center/throughput.ts :: fmtCache': 'date formatters by time zone; no app data',
  'services/command-center/work-math.ts :: ZONE_FORMATS':
    'date formatters by time zone; no app data',
  'services/config-drift/report-section.ts :: registered': REGISTRY,
  'services/config-drift/store.ts :: cached': OFF_DRIFT,
  'services/config-live.ts :: lastRouteAt':
    'read only by the config-epoch stamp listener, which never fires on a multi-tenant deployment (db/config-epoch.ts ENABLED)',
  'services/config-review/pure.ts :: FILE_COLLECTIONS': FIXED,
  'services/config-search/index.ts :: personal':
    'the static index of personal screens (no app data; the same for every app)',
  'services/config-search/rank.ts :: kindWordCache':
    'word lists per config kind (code constants); no app data',
  'services/config-seeds.ts :: seeds': REGISTRY,
  'services/config-stamps.ts :: registered': REGISTRY,
  'services/context-rows.ts :: sources': WEAK,
  'services/copy-rules.ts :: COPY_AUDIT_FIELDS': FIXED,
  'services/crash-sourcemap.ts :: cache':
    'source maps of the admin build in this image; no app data',
  'services/crash-sourcemap.ts :: cachedBytes':
    'source maps of the admin build in this image; no app data',
  'services/crash-sourcemap.ts :: decodeChain': 'one source-map decode at a time in this process',
  'services/cron-misses.ts :: probe': FN_SLOT,
  'services/daily-digest.ts :: audiences': REGISTRY,
  'services/daily-digest.ts :: providers': REGISTRY,
  'services/db-health.ts :: downSince': DB_HEALTH,
  'services/db-health.ts :: failStreak': DB_HEALTH,
  'services/db-health.ts :: healthy': DB_HEALTH,
  'services/db-health.ts :: lastError': DB_HEALTH,
  'services/db-health.ts :: timer': TIMER,
  'services/db-outage.ts :: current': DB_HEALTH,
  'services/db-outage.ts :: deps': FN_SLOT,
  'services/db-outage.ts :: timer': TIMER,
  'services/db-outage.ts :: writing': DB_HEALTH,
  'services/db-tuning/observers/registry.ts :: registry': REGISTRY,
  'services/db-tuning/rewrites/junction-exists.ts :: ON_END': FIXED,
  'services/db-tuning/rewrites/junction-exists.ts :: WHERE_END': FIXED,
  'services/db-tuning/rewrites/scan.ts :: NOT_ALIAS': FIXED,
  'services/db-tuning/rewrites/scan.ts :: STMT': FIXED,
  'services/deploy-readiness.ts :: registered': REGISTRY,
  'services/dev-extension-watch.ts :: started':
    'development-only file watcher (NODE_ENV=development); never on a deployment',
  'services/dev-staleness.ts :: state':
    "development-only check that this process's source changed since it started",
  'services/dev-staleness.ts :: timer': TIMER,
  'services/docker-source.ts :: cache': OFF_DOCKER,
  'services/docker-source.ts :: fetchImpl': FN_SLOT,
  'services/docker-source.ts :: inflight': OFF_DOCKER,
  'services/docs-search.ts :: indexPromise': 'the docs index shipped in this image; no app data',
  'services/docs-search.ts :: prepared': WEAK,
  'services/docs-search.ts :: versionPromise': 'the docs index shipped in this image; no app data',
  'services/document-extract.ts :: pdftotextPath': 'where the pdftotext tool sits on this machine',
  'services/env-refresh/directions.ts :: registered': REGISTRY,
  'services/env-refresh/registry.ts :: extensionKeeps': REGISTRY,
  'services/event-journal-store.ts :: buffer':
    "process write buffer; each entry carries its own app's database handle (getTenantDb()) and is written there",
  'services/event-journal-store.ts :: flushing':
    'the process flush in progress (entries carry their own database)',
  'services/event-journal-store.ts :: stats': DIAG,
  'services/event-journal-store.ts :: timer': TIMER,
  'services/event-journal.ts :: _redis': CONN,
  'services/event-journal.ts :: emitScriptMisses': DIAG,
  'services/event-journal.ts :: emitScriptUnusable': DIAG,
  'services/event-journal.ts :: fallbackSub': CONN,
  'services/event-journal.ts :: observer': FN_SLOT,
  'services/event-journal.ts :: pendingReads': WEAK,
  'services/event-journal.ts :: tableActive': 'process concurrency count of durable replays',
  'services/event-journal.ts :: tableQueue':
    'process concurrency queue of durable replays; each waiter resumes its own request',
  'services/event-stream.ts :: lastId':
    'the process stream reader (one per process); every event names a tenant-scoped room',
  'services/event-stream.ts :: pub': CONN,
  'services/event-stream.ts :: reader': CONN,
  'services/event-stream.ts :: running':
    'the process stream reader (one per process); every event names a tenant-scoped room',
  'services/event-stream.ts :: stats': DIAG,
  'services/event-stream.ts :: trimTimer': TIMER,
  'services/export-files.ts :: processTag': "this process's own id in the work folder",
  'services/export-files.ts :: sweeper': TIMER,
  'services/export-files.ts :: workDirUsage': "disk use of this process's export work folder",
  'services/export-limits.ts :: inflight': OFF_STORED_LIMITS,
  'services/export-limits.ts :: loaded': OFF_STORED_LIMITS,
  'services/export-limits.ts :: loadedAt': OFF_STORED_LIMITS,
  'services/export-limits.ts :: registered': REGISTRY,
  'services/export-limits.ts :: stored': OFF_STORED_LIMITS,
  'services/export-worker.ts :: closing': 'set once the process is stopping',
  'services/export-worker.ts :: drainer': 'the process drain loop handle',
  'services/export-worker.ts :: passing':
    "a drainer's per-app pass in flight on this process (it walks every app; one at a time)",
  'services/extension-events.ts :: handlers': REGISTRY,
  'services/extension-schema-steps.ts :: declared': REGISTRY,
  'services/extension-tools.ts :: isEnabled': FN_SLOT,
  'services/extension-tools.ts :: registries': REGISTRY,
  'services/ffmpeg.ts :: available': 'whether ffmpeg is installed on this machine',
  'services/field-rules.ts :: DYNAMIC_TARGET_TYPES': FIXED,
  'services/field-rules.ts :: VALID_OPS': FIXED,
  'services/field-rules.ts :: VALID_TARGET_TYPES': FIXED,
  'services/field-write-sources.ts :: redisOverride': FN_SLOT,
  'services/file-processing.ts :: running': 'process concurrency count of file processing',
  'services/file-processing.ts :: waiting':
    "process concurrency queue of file processing; each waiter resumes its own app's work",
  'services/file-serving-safety.ts :: TEXT_EXTENSIONS': FIXED,
  'services/flow-executor.ts :: runIdOf': WEAK,
  'services/gitlab-client.ts :: commitCache':
    'commit titles by commit sha (immutable, public to whoever reads that repository); no app records',
  'services/gitlab-health.ts :: fetchImpl': FN_SLOT,
  'services/graphql-nested-access.ts :: perRequest': WEAK,
  'services/graphql-nested-guard.ts :: budgets': WEAK,
  'services/grid-presence.ts :: readersCache':
    'keyed by the socket room, which carries the app (tenantScopedRoom), + field + access stamp',
  'services/help-video-captions.ts :: chain': 'one caption run at a time in this process',
  'services/help-video-captions.ts :: localChecked':
    "whether the caption tool configured in this process's env is installed (keyed by command + model path)",
  'services/help-video-clips.ts :: chain': 'one clip run at a time in this process',
  'services/help-video-encoder.ts :: brokenUntil': 'hardware encoders of this machine',
  'services/help-video-encoder.ts :: detection': 'hardware encoders of this machine',
  'services/help-video-music.ts :: generatedCache':
    'generated library music files of this image; no app data',
  'services/help-video-music.ts :: manifest':
    "the deployment's HELP_VIDEO_MUSIC_DIR folder; no app data",
  'services/help-video-openverse.ts :: items': 'public Openverse track records; no app data',
  'services/help-video-openverse.ts :: previews': 'public Openverse audio previews; no app data',
  'services/help-video-openverse.ts :: searches': 'public Openverse search answers; no app data',
  'services/help-video-openverse.ts :: token':
    "the deployment's Openverse client token (env credentials)",
  'services/help-video-package.ts :: sessions':
    'keyed by a random import session id; no app records',
  'services/help-video-render.ts :: scratchCleaned':
    "this process's scratch folder was cleaned once",
  'services/help-video-starters.ts :: regs': REGISTRY,
  'services/help-video-starters.ts :: running':
    'never runs on a shared deployment: the loader skips applyExtensionHelpVideos under the hub source',
  'services/help-video-uploads.ts :: conversionTail':
    'one conversion at a time in this process (a full-CPU encode)',
  'services/help-video-uploads.ts :: lastSweep':
    'this process sweeps its own work folder at most hourly',
  'services/help-videos.ts :: TARGET_KINDS': FIXED,
  'services/help-videos.ts :: changeCache':
    'comparisons of two immutable help-video version ids (both versions never change once they exist)',
  'services/help-videos.ts :: masqueradeAuthors': WEAK,
  'services/help-videos.ts :: sidTagWritten':
    'keyed by an HMAC tag of a random session id; a write throttle, no app data',
  'services/host-facts.ts :: cache':
    'host facts of the machine this process runs on (Infrastructure page, admin)',
  'services/host-facts.ts :: inflight':
    'host facts of the machine this process runs on (Infrastructure page, admin)',
  'services/hub-link/first-admin.ts :: queue': HUB_LINK,
  'services/hub-link/retire.ts :: bootRetryMs': RETIRE,
  'services/hub-link/retire.ts :: listeners': RETIRE,
  'services/hub-link/retire.ts :: state': RETIRE,
  'services/hub-link/retire.ts :: timer': RETIRE,
  'services/hub-link/retire.ts :: watched': RETIRE,
  'services/hub-signin/link-client.ts :: linkDownUntil':
    "keyed by a tag of the app's own hub token (each app on a shared deployment has its own, from the tenant list)",
  'services/hub-signin/probe.ts :: inflight': HUBSIGNIN_PER_CLIENT,
  'services/hub-signin/probe.ts :: lastReason': HUBSIGNIN_PER_CLIENT,
  'services/hub-signin/probe.ts :: memo': HUBSIGNIN_PER_CLIENT,
  'services/hub/create/run.ts :: launched': HUB_ONLY,
  'services/hub/create/run.ts :: live': HUB_ONLY,
  'services/hub/create/steps.ts :: syncsInFlight': HUB_ONLY,
  'services/hub/create/store.ts :: memCancels': HUB_ONLY,
  'services/hub/db/db-lock.ts :: memLocks': HUB_ONLY,
  'services/hub/data/lock.ts :: memLocks': HUB_ONLY,
  'services/hub/config/channel.ts :: fetchImpl': HUB_ONLY,
  'services/hub-link/config-promote-map.ts :: SPEC_BY_TABLE': FIXED,
  'services/hub-link/config-promote-secrets.ts :: SECRET_CONTAINERS': FIXED,
  'services/hub-link/config-promote-secrets.ts :: INBOUND_AUTH_KEYS': FIXED,
  'services/hub/data/app-calls.ts :: fetchImpl': HUB_ONLY,
  'services/hub/shared/upgrade-run.ts :: cancelledHere': HUB_ONLY,
  'services/hub/shared/upgrade-run.ts :: live': HUB_ONLY,
  'services/hub/shared/upgrade-run.ts :: recovered': HUB_ONLY,
  'services/hub/db/provision-common.ts :: KNEX_SECRETS': HUB_ONLY,
  'services/hub/deploy-evidence.ts :: inflight': HUB_ONLY,
  'services/hub/deploy-evidence.ts :: jobsCache': HUB_ONLY,
  'services/hub/deploy-evidence.ts :: pinCache': HUB_ONLY,
  'services/hub/link-token.ts :: backfill': HUB_ONLY,
  'services/hub/link-token.ts :: backfilled': HUB_ONLY,
  'services/hub/oidc/evidence.ts :: warnedMultiTenant': HUB_ONLY,
  'services/hub/oidc/keys.ts :: creating': HUB_ONLY,
  'services/hub/oidc/keys.ts :: keyCache': HUB_ONLY,
  'services/hub/oidc/keys.ts :: testClock': HUB_ONLY,
  'services/hub/move/heal.ts :: liveHere': HUB_ONLY,
  'services/hub/move/ops.ts :: sharedStackRouter': HUB_ONLY,
  'services/hub/move/plan-port.ts :: override': HUB_ONLY,
  'services/hub/move/run.ts :: base': HUB_ONLY,
  'services/hub/move/run.ts :: running': HUB_ONLY,
  'services/hub/promote-heal.ts :: liveHere': HUB_ONLY,
  'services/hub/promote-lock.ts :: memCancels': HUB_ONLY,
  'services/hub/promote-lock.ts :: memLocks': HUB_ONLY,
  'services/hub/promote-lock.ts :: memShared': HUB_ONLY,
  'services/hub/promote-lock.ts :: memBranch': HUB_ONLY,
  'services/hub/promote-run.ts :: live': HUB_ONLY,
  'services/hub/promote-run.ts :: recoveryStarted': HUB_ONLY,
  'services/hub/shared/sightings.ts :: deps': HUB_ONLY,
  'services/hub/shared/place.ts :: bootRecovery': HUB_ONLY,
  'services/hub/shared/place.ts :: running': HUB_ONLY,
  'services/hub/shared/sightings.ts :: memory': HUB_ONLY,
  'services/hub/shared/tenants.ts :: warned': HUB_ONLY,
  'services/hub/capacity/advisor.ts :: blockerCache': HUB_ONLY,
  'services/capacity/app-usage.ts :: cpu': PROC,
  'services/capacity/app-usage.ts :: redisOverride': FN_SLOT,
  'services/capacity/scale-figures.ts :: redisOverride': FN_SLOT,
  'services/capacity/app-usage.ts :: timer': TIMER,
  'services/capacity/enforce.ts :: redisOverride': FN_SLOT,
  'services/capacity/enforce.ts :: JOB_SLOT_WAIT_MS': FN_SLOT,
  'services/capacity/enforce.ts :: countInjected': FN_SLOT,
  'services/capacity/enforce.ts :: redisState': PROC,
  'services/hub/capacity/sample.ts :: sampling': HUB_ONLY,
  'services/huddle-marks.ts :: markSeq': GEN,
  'services/huddle.ts :: staleEvictor': FN_SLOT,
  'services/import-processors.ts :: processors': REGISTRY,
  'services/import-templates.ts :: BOOLEAN_TYPES': FIXED,
  'services/import-templates.ts :: INTEGER_TYPES': FIXED,
  'services/import-templates.ts :: NUMBER_TYPES': FIXED,
  'services/inactive-people-notice.ts :: defaultApp': APP_REF,
  'services/inflight-cluster.ts :: redisRef': CONN,
  'services/inflight-cluster.ts :: timer': TIMER,
  'services/infra-ai-tools.ts :: INFRA_TOOL_NAMES': FIXED,
  'services/infra-drift/store.ts :: localLocks':
    'stack drift checks lock per stack + environment (deployment infrastructure, not app data)',
  'services/infra-swarm/updates.ts :: IN_FLIGHT_STATES': FIXED,
  'services/instance-roster.ts :: redisRef': CONN,
  'services/instance-roster.ts :: timer': TIMER,
  'services/integration-alerts.ts :: _app': APP_REF,
  'services/integration-error-explain.ts :: extensionRules': REGISTRY,
  'services/integration-event-sources.ts :: sources': REGISTRY,
  'services/integration-obligations.ts :: registry': REGISTRY,
  'services/integration-obligations.ts :: warned': DIAG,
  'services/integration-signal-alerts.ts :: _app': APP_REF,
  'services/integration-signals.ts :: actions': REGISTRY,
  'services/integration-signals.ts :: signals': REGISTRY,
  'services/integrity-checks.ts :: registry': REGISTRY,
  'services/io-holder.ts :: _app': APP_REF,
  'services/io-holder.ts :: _io': APP_REF,
  'services/issue-raise.ts :: listeners': REGISTRY,
  'services/item-action-runs.ts :: local':
    'fallback (Redis down) claims under nvr:item-action-run:<tenant>:…, which already carry the app',
  'services/item-events.ts :: listeners': REGISTRY,
  'services/item-events.ts :: pub': CONN,
  'services/item-events.ts :: sub': CONN,
  'services/item-events.ts :: touchListeners': REGISTRY,
  'services/items.ts :: FILTER_OPS': FIXED,
  'services/items.ts :: dryReports': WEAK,
  'services/items.ts :: outOfView': WEAK,
  'services/items.ts :: serverBuiltFilterNodes': WEAK,
  'services/items.ts :: upsertMarks': WEAK,
  'services/job-busy.ts :: BUSY_KINDS': FIXED,
  'services/job-run-sentences.ts :: formatters': REGISTRY,
  'services/journal-listeners.ts :: listeners': REGISTRY,
  'services/layout-change-log.ts :: GROUP_IGNORE': FIXED,
  'services/layout-change-log.ts :: LAYOUT_IGNORE': FIXED,
  'services/layout-change-log.ts :: PLACEMENT_IGNORE': FIXED,
  'services/layout-crossform.ts :: CROSSFORM_TYPES': FIXED,
  'services/layout-dependencies.ts :: declared': REGISTRY,
  'services/layout-dependencies.ts :: declaring': REGISTRY,
  'services/layout-test-readiness.ts :: registered': REGISTRY,
  'services/line-sla.ts :: digestRegistered': REGISTRY,
  'services/live-query.ts :: liveTypesBySchema': WEAK,
  'services/live-query.ts :: perUser':
    'keyed by `${args.tenantKey}\u0000<user>` (capKey); the tenant comes with the query',
  'services/live-query.ts :: total': 'process cap on live queries (LIVE_QUERY_MAX is per process)',
  'services/lock-presence.ts :: judgingSince': 'when this process started judging connections',
  'services/lock-presence.ts :: probe': FN_SLOT,
  'services/mail-types.ts :: registry': REGISTRY,
  'services/mail.ts :: engine': 'the Liquid engine over those folders (Task 13)',
  'services/mail.ts :: hubEngine': `the standalone Hub's Liquid engine over the same folders; ${HUB_ONLY}`,
  'services/mail.ts :: mailLogWarned': DIAG,
  'services/mail.ts :: templateRoots': 'template folders of the image and its extensions (Task 13)',
  'services/maintenance-live.ts :: announceImpl': FN_SLOT,
  'services/maintenance-live.ts :: readImpl': FN_SLOT,
  'services/maintenance-live.ts :: watchTimer': TIMER,
  'services/managed-procedures/deploy.ts :: readinessRegistered': REGISTRY,
  'services/mcp-sessions.ts :: unlisten': REGISTRY,
  'services/mcp-suggestions.ts :: DISCOVERY_TOOLS': FIXED,
  'services/mcp-tool-catalog.ts :: builtins': 'the built-in MCP tool list (code)',
  'services/media-handoff.ts :: worker': OFF_MEDIA_HANDOFF,
  'services/notification-snapshot.ts :: SNAPSHOT_IGNORED_FIELDS': FIXED,
  'services/ops-assistant.ts :: OPS_TOOL_NAMES': FIXED,
  'services/ops-live.ts :: wired': REGISTRY,
  'services/ops-report/sections.ts :: sections': REGISTRY,
  'services/ops-signals.ts :: book': PROC,
  'services/ops-signals.ts :: redisRef': CONN,
  'services/ops-signals.ts :: stallPublish': TIMER,
  'services/ops-signals.ts :: stalls': LAZY,
  'services/ops-signals.ts :: timer': TIMER,
  'services/ops-tasks.ts :: nextLocalId': GEN,
  'services/ops-tasks.ts :: tasks': REGISTRY,
  'services/outbox.ts :: handlers': REGISTRY,
  'services/outside-write-system.ts :: COLUMN_TRACKED': FIXED,
  'services/owner-change-live.ts :: deps': FN_SLOT,
  'services/owner-change-live.ts :: openRecordsLoader': FN_SLOT,
  'services/owner-change-live.ts :: wired': REGISTRY,
  'services/owner-matrix-sheet.ts :: FIXED_HEADERS': FIXED,
  'services/owner-matrix-versions.ts :: DIM_IGNORE': FIXED,
  'services/owner-matrix-versions.ts :: GROUP_IGNORE': FIXED,
  'services/partial-reads.ts :: notes': WEAK,
  'services/partner-dependencies.ts :: schemaProvider': FN_SLOT,
  'services/partner-needs/index.ts :: analysisCache':
    'content-addressed: keyed by the analysed template text itself (mode + body)',
  'services/payload-filters.ts :: shared': 'the Liquid engine with the payload filters (code)',
  'services/payload-templates/evaluate.ts :: pathCache':
    'parsed path segments by path text; no app data',
  'services/payload-templates/evaluate.ts :: templateCache':
    'content-addressed: parsed Liquid by its own text',
  'services/payload-templates/render.ts :: filterRegistered': REGISTRY,
  'services/pdf-layout.ts :: browser': 'the Chromium of this process',
  'services/pdf-layout.ts :: localChromium': 'whether Chromium is installed on this machine',
  'services/pdf-pages.ts :: sources': 'the pdf.js files of this image',
  'services/people-live.ts :: emit': FN_SLOT,
  'services/people-live.ts :: wired': REGISTRY,
  'services/permission-cache.ts :: attached': WEAK,
  'services/permission-cache.ts :: counters': OFF_PERMCACHE,
  'services/permission-cache.ts :: generation': OFF_PERMCACHE,
  'services/permission-cache.ts :: kinds': WEAK,
  'services/permission-cache.ts :: lastNonceReset': OFF_PERMCACHE,
  'services/permission-cache.ts :: lastOn': OFF_PERMCACHE,
  'services/permission-cache.ts :: pinned': OFF_PERMCACHE,
  'services/permission-cache.ts :: procGeneration': OFF_PERMCACHE,
  'services/permission-cache.ts :: procLookup': OFF_PERMCACHE,
  'services/permission-cache.ts :: procPending': OFF_PERMCACHE,
  'services/permission-cache.ts :: procTouches': OFF_PERMCACHE,
  'services/permission-cache.ts :: redis': OFF_PERMCACHE,
  'services/permission-cache.ts :: resetListeners': REGISTRY,
  'services/permission-cache.ts :: seenGlobal': OFF_PERMCACHE,
  'services/permission-cache.ts :: seenUser': OFF_PERMCACHE,
  'services/permission-cache.ts :: tokenSeq': OFF_PERMCACHE,
  'services/permission-cache.ts :: trailing': OFF_PERMCACHE,
  'services/permission-cache.ts :: userGeneration': OFF_PERMCACHE,
  'services/permission-cache.ts :: verdictMemo': OFF_PERMCACHE,
  'services/permission-cache.ts :: versionMemo': WEAK,
  'services/permission-cache.ts :: wired': OFF_PERMCACHE,
  'services/permission-cache.ts :: wiring': OFF_PERMCACHE,
  'services/permission-cache.ts :: wroteAccess': OFF_PERMCACHE,
  'services/permissions.ts :: degradedColumns': WEAK,
  'services/phone-push.ts :: pushRedis': CONN,
  'services/pipeline-engine.ts :: ownerCacheGen': GEN,
  'services/pool-attribution.ts :: sampleListener': FN_SLOT,
  'services/pool-attribution.ts :: sampler': TIMER,
  'services/pool-attribution.ts :: trackers': PROC,
  'services/pool-holders.ts :: hogRedis': CONN,
  'services/pool-holders.ts :: hogSince': PROC,
  'services/pool-holders.ts :: hogs': PROC,
  'services/pool-holders.ts :: nameCache':
    'user labels for the cluster pool-holder view, which is off on any multi-tenant deployment (clusterPoolHolders answers available:false)',
  'services/pool-holders.ts :: redisRef': CONN,
  'services/pool-holders.ts :: timer': TIMER,
  'services/predictive-sla.ts :: redis': CONN,
  'services/presence-topics.ts :: RECORD_SIGNAL_KINDS': FIXED,
  'services/presence-topics.ts :: TOPIC_SIGNAL_KINDS': FIXED,
  'services/presence-topics.ts :: viewersByRoom':
    'keyed by the socket room, which carries the app (opsRoomOf → tenant-scoped room); per process like the record viewer lists',
  'services/process-guards.ts :: installed': REGISTRY,
  'services/queue-keyset.ts :: QUEUE_KEYSET_SORTS': FIXED,
  'services/queue-owner-status.ts :: judged': WEAK,
  'services/raw-write-announcer.ts :: queued': 'process count of queued announcements (Task 13)',
  'services/raw-write-announcer.ts :: stats': DIAG,
  'services/raw-write-announcer.ts :: timer': TIMER,
  'services/raw-write-fanout.ts :: budget': 'process fan-out budget per window (counts only)',
  'services/raw-write-fanout.ts :: stats': DIAG,
  'services/read-caches.ts :: externalActivity': REGISTRY,
  'services/read-caches.ts :: globalEpoch': GEN,
  'services/read-caches.ts :: wired': REGISTRY,
  'services/read-gate.ts :: cfg': CFG,
  'services/readiness.ts :: redis': CONN,
  'services/readiness.ts :: registry': REGISTRY,
  'services/readiness.ts :: retired': REGISTRY,
  'services/realtime-ack-sample.ts :: lastStampAt': PROC,
  'services/realtime-board.ts :: liveBoards': RT_BOARD,
  'services/realtime-board.ts :: liveReadAt': RT_BOARD,
  'services/realtime-board.ts :: loneConfirmedAt': RT_BOARD,
  'services/realtime-board.ts :: peerChange': FN_SLOT,
  'services/realtime-board.ts :: peersOn': RT_BOARD,
  'services/realtime-board.ts :: publisher': RT_BOARD,
  'services/realtime-board.ts :: publisherRedis': CONN,
  'services/realtime-board.ts :: reader': RT_BOARD,
  'services/realtime-board.ts :: readerOn': RT_BOARD,
  'services/realtime-board.ts :: statsBoards': RT_BOARD,
  'services/realtime-board.ts :: statsReadAt': RT_BOARD,
  'services/realtime-delivery-slo.ts :: _redis': CONN,
  'services/realtime-delivery-slo.ts :: buckets':
    'ack sampling budget per person id (delivery telemetry, counts only); a shared id only shares a sampling budget',
  'services/realtime-leak-audit.ts :: pending': PROC,
  'services/realtime-leak-audit.ts :: state': PROC,
  'services/realtime-leak-audit.ts :: stateReadAt': PROC,
  'services/realtime-leak-audit.ts :: stats': DIAG,
  'services/realtime-leak-audit.ts :: tokens': PROC,
  'services/realtime-leak-audit.ts :: tokensAt': PROC,
  'services/realtime-probe.ts :: lastLocal': PROC,
  'services/record-change-notices.ts :: entries': REGISTRY,
  'services/record-instance.ts :: requestBatches': WEAK,
  'services/record-notes.ts :: noteSources': REGISTRY,
  'services/record-split.ts :: SPLIT_AUDIT_FIELDS': FIXED,
  'services/record-transition.ts :: backgroundMoves': DIAG,
  'services/recovery/settings.ts :: testOverride': FN_SLOT,
  'services/related-announce.ts :: forwardTimer': TIMER,
  'services/replay-auto-signals.ts :: fallback':
    'fallback memory store (Redis down) for the auto-signal keys, which already carry the app (credential guard)',
  'services/request-trace.ts :: appOfTrace': WEAK,
  'services/request-trace.ts :: byRequest': WEAK,
  'services/request-trace.ts :: keepNextMatchers': DIAG,
  'services/request-trace.ts :: keptListeners': DIAG,
  'services/request-trace.ts :: traceFallbacks': DIAG,
  'services/request-trace.ts :: wideTables': DIAG,
  'services/requirement-writes.ts :: memo': WEAK,
  'services/row-schedules.ts :: publisher': CONN,
  'services/row-schedules.ts :: resyncers': REGISTRY,
  'services/run-long.ts :: touched': WEAK,
  'services/runtime-monitor.ts :: breachStreak': PROC,
  'services/runtime-monitor.ts :: lastSample': PROC,
  'services/runtime-monitor.ts :: maxLag1m': PROC,
  'services/runtime-monitor.ts :: recentLags': PROC,
  'services/runtime-monitor.ts :: timer': TIMER,
  'services/save-progress.ts :: open': WEAK,
  'services/screen-share-socket.ts :: budgetOne':
    'process frame budget of screen shares (bytes per minute per process)',
  'services/screen-share.ts :: SHARE_SIGN_IN_KINDS': FIXED,
  'services/search-extra.ts :: endUserCache': WEAK,
  'services/search-scopes.ts :: registered': REGISTRY,
  'services/secret-columns.ts :: SECRET_NAME_ALLOW': FIXED,
  'services/secret-mask.ts :: SENSITIVE_HEADER_NAMES': FIXED,
  'services/secret-mask.ts :: SENSITIVE_QUERY_NAMES': FIXED,
  'services/security-alerts.ts :: depsOverride': FN_SLOT,
  'services/session-replay-cost.ts :: flushTimer': TIMER,
  'services/session-replay-export.ts :: assets': 'the replay player files of this image',
  'services/session-replay-export.ts :: chain': 'one replay export at a time in this process',
  'services/session-replay-export.ts :: depsOverride': FN_SLOT,
  'services/session-replay-health.ts :: registered': REGISTRY,
  'services/session-replay-index.ts :: draining':
    'the process drain loop of replay indexing (each job runs in its own app, fix)',
  'services/session-replay-index.ts :: queuedEvents':
    'process count of queued replay index events (a memory bound)',
  'services/session-replay-index.ts :: warned': DIAG,
  'services/session-replay-storage.ts :: objectStore': FN_SLOT,
  'services/settings-overrides.ts :: envParsed': CFG,
  'services/single-flight.ts :: flights':
    "generic single-flight helper: every caller's key names its scope (read-gate keys carry the tenant; short caches key per caller)",
  'services/single-flight.ts :: stats': DIAG,
  'services/socket-access.ts :: pending':
    'a process recheck request over sockets; each socket is judged as its own app (Task 13)',
  'services/socket-access.ts :: pendingTimer': TIMER,
  'services/socket-access.ts :: recheckQueued': 'the process recheck run (Task 13)',
  'services/socket-access.ts :: recheckRunning': 'the process recheck run (Task 13)',
  'services/socket-chaos.ts :: listening': CHAOS,
  'services/socket-chaos.ts :: local': CHAOS,
  'services/socket-chaos.ts :: who': CHAOS,
  'services/socket-health.ts :: redisRef': CONN,
  'services/socket-health.ts :: sampler': TIMER,
  'services/socket-health.ts :: tracked': 'per socket id (each socket belongs to one app)',
  'services/socket-replay.ts :: runs':
    'staging-only socket replay runs (REALTIME_REPLAY=on), one at a time per process, random run ids',
  'services/socket-transport.ts :: encodedOfPayload': WEAK,
  'services/socket-transport.ts :: inspections':
    'socket transport inspections by a random inspection id (admin diagnostics of this process)',
  'services/socket-transport.ts :: lastParsed':
    'the last parsed frame of this process (a one-slot parse memo by encoded text; no lookup by app)',
  'services/sql-checks/sqlfluff.ts :: transport': FN_SLOT,
  'services/sql-read-set.ts :: contexts': 'parser contexts per SQL dialect (code); no app data',
  'services/sse-hub.ts :: bridgeOff': FN_SLOT,
  'services/sse-hub.ts :: listeners':
    'open SSE subscribers of this process; each carries its own app filter',
  'services/sse-hub.ts :: seq': GEN,
  'services/staged-import-worker.ts :: drainer':
    "the process drain loop handle (a shared deployment: the deployment's kick subscriber)",
  'services/staged-import-worker.ts :: processDriving':
    'the count of import runs this process drives across every app (a shared deployment caps the process at IMPORT_MAX_PARALLEL, not each app); a number, no app data',
  'services/staged-import-worker.ts :: passing':
    "the importer's per-app pass in flight on this process (it walks every app; one at a time)",
  'services/staged-imports.ts :: xlsxEntry': 'where the xlsx worker file sits in this image',
  'services/stall-causes.ts :: book': PROC,
  'services/stall-causes.ts :: onCaptured': FN_SLOT,
  'services/stall-watchdog.ts :: helperMaxMs': PROC,
  'services/stall-watchdog.ts :: timer': TIMER,
  'services/storage-readiness.ts :: registered': REGISTRY,
  'services/storage/fallback-url.ts :: lastWarnAt': OFF_FILES_FALLBACK,
  'services/storage/fallback-url.ts :: misses': OFF_FILES_FALLBACK,
  'services/storage/fallback-url.ts :: plainAgent': OFF_FILES_FALLBACK,
  'services/storage/fallback-url.ts :: tlsAgent': OFF_FILES_FALLBACK,
  'services/storage/fallback-url.ts :: troubleUntil': OFF_FILES_FALLBACK,
  'services/storage/index.ts :: _appScoped': STORAGE,
  'services/storage/index.ts :: _provider': STORAGE,
  'services/storage/index.ts :: _storage': STORAGE,
  'services/submission-status.ts :: FREE_MAIL_DOMAINS': FIXED,
  'services/support-ticket-events.ts :: listeners': REGISTRY,
  'services/swallow-counter.ts :: stats': DIAG,
  'services/teams-bot/jwt.ts :: jwkDocs':
    "Microsoft's public Bot Framework signing keys (one metadata URL for every bot): no app data",
  'services/telemetry-ai.ts :: ASK_TOOL_NAMES': FIXED,
  'services/telemetry-ai.ts :: ROLLUP_METRICS': FIXED,
  'services/telemetry-ai.ts :: TELEMETRY_TOOL_NAMES': FIXED,
  'services/telemetry-status.ts :: cache': TELEMETRY,
  'services/telemetry-store.ts :: accessLines': DIAG,
  'services/telemetry-store.ts :: statusCache': TELEMETRY,
  'services/telemetry-store.ts :: transport': FN_SLOT,
  'services/tenancy/app-lifecycle.ts :: leftHooks': REGISTRY,
  'services/tenancy/app-lifecycle.ts :: readyHooks': REGISTRY,
  'services/tenancy/app-keys.ts :: keys':
    'Task 14: app keys by tenant id (the map is keyed by the app)',
  'services/tenancy/app-hub-links.ts :: links':
    "each app's Hub link (sign-in client, hub token) by tenant id (the map is keyed by the app)",
  'services/tenancy/app-migrations.ts :: follower':
    "the realtime process's re-read loop over every app's stored state (a process mode; the states it writes are keyed by tenant id)",
  'services/tenancy/app-migrations.ts :: gateOn':
    'Task 8: whether this process gates requests on app migrations (a process mode)',
  'services/tenancy/app-migrations.ts :: inFlight':
    'Task 8: one migration run per app, keyed by tenant id',
  'services/tenancy/app-migrations.ts :: lastRequestNudge':
    'Task 8: process throttle of request-driven re-checks',
  'services/tenancy/app-migrations.ts :: loop': 'Task 8: the process re-check loop over every app',
  'services/tenancy/app-migrations.ts :: passAgain':
    'final review M2: the process loop asked for one more pass over every app (no app data)',
  'services/tenancy/app-migrations.ts :: passRunning':
    'final review M2: the process loop over every app is running a pass (no app data)',
  'services/tenancy/app-migrations.ts :: newestMigration':
    'the newest migration file in this image',
  'services/tenancy/app-migrations.ts :: nowFn': FN_SLOT,
  'services/tenancy/app-migrations.ts :: randomFn': FN_SLOT,
  'services/tenancy/app-migrations.ts :: readinessRegistered': REGISTRY,
  'services/tenancy/app-migrations.ts :: redisRef': CONN,
  'services/tenancy/app-migrations.ts :: states':
    'Task 8: migration state per app, keyed by tenant id',
  'services/tenancy/app-migrations.ts :: verifying':
    'Task 8: verification per app, keyed by tenant id',
  'services/tenancy/app-status.ts :: DB_CHECK_CLIENTS': FIXED,
  'services/tenancy/app-status.ts :: boundMs': CFG,
  'services/tenancy/app-status.ts :: flightStaleMs': CFG,
  'services/tenancy/app-status.ts :: preflightCache':
    'Task 7: per-app preflight, keyed by tenant id',
  'services/tenancy/app-status.ts :: preflightFlights':
    'Task 7: per-app preflight single-flight, keyed by tenant id',
  'services/tenancy/cloud-meta-source.ts :: _metaDb':
    'the cloud meta database connection (cloud tenant source only)',
  'services/tenancy/hub-source.ts :: active':
    "the deployment's tenant list from the Hub (one per deployment by design; Task 4 / 14 own this file)",
  'services/tenancy/readiness.ts :: registered': REGISTRY,
  'services/tenancy/registry.ts :: cached':
    "the deployment's tenant registry (one per process by design)",
  'services/tenancy/registry.ts :: override': FN_SLOT,
  'services/trace-export.ts :: instanceName': CFG,
  'services/trace-export.ts :: queue': TELEMETRY,
  'services/trace-export.ts :: send': FN_SLOT,
  'services/trace-export.ts :: sending': TELEMETRY,
  'services/trace-export.ts :: stats': DIAG,
  'services/trace-export.ts :: timer': TIMER,
  // GitLab sync per app (0.3.215): the issue-write listener is registered once at boot (outside
  // any app) and each write runs in the writer's app; the per-issue queues, sweep tally, held
  // reconcile issues, the failure-log limiters and the switch cache are appSet / appMap / appBox
  // (detected as keyed).
  'services/trackers/crons.ts :: unsubscribe': REGISTRY,
  'services/trackers/crons.ts :: unsubscribeTickets': REGISTRY,
  'services/trackers/flow-events.ts :: logger': APP_REF,
  'services/trackers/flow-ops.ts :: registered': REGISTRY,
  'services/trackers/inbound.ts :: lockRedis': CONN,
  'services/trackers/outbox.ts :: autoSend': FN_SLOT,
  'services/traefik-source.ts :: fetchImpl': FN_SLOT,
  'services/traffic-actions/debug-window.ts :: wired': TELEMETRY,
  'services/traffic-actions/ext-lenses.ts :: inflight': TELEMETRY,
  'services/traffic-actions/ext-lenses.ts :: lenses': TELEMETRY,
  'services/traffic-actions/temp-cache.ts :: CACHEABLE_ROUTES': TELEMETRY,
  'services/traffic-actions/temp-cache.ts :: local': TELEMETRY,
  'services/traffic-actions/temp-cache.ts :: statsRedis': TELEMETRY,
  'services/traffic-actions/temp-cache.ts :: totalBytes': TELEMETRY,
  'services/traffic-actions/temp-cache.ts :: trailing': TELEMETRY,
  'services/traffic-actions/temp-cache.ts :: wired': TELEMETRY,
  'services/traffic-actions/timed-rules.ts :: active': TM_ACTIONS,
  'services/traffic-actions/timed-rules.ts :: changeListeners': TELEMETRY,
  'services/traffic-actions/timed-rules.ts :: endListeners': TELEMETRY,
  'services/traffic-actions/timed-rules.ts :: endTimers': TELEMETRY,
  'services/traffic-actions/timed-rules.ts :: redis': TELEMETRY,
  'services/traffic-actions/timed-rules.ts :: syncTimer': TELEMETRY,
  'services/traffic-baselines.ts :: redisOverride': TELEMETRY,
  'services/traffic-breaker.ts :: active': TM_ACTIONS,
  'services/traffic-breaker.ts :: lastSync': TELEMETRY,
  'services/traffic-breaker.ts :: redis': TELEMETRY,
  'services/traffic-breaker.ts :: syncTimer': TELEMETRY,
  'services/traffic-cluster.ts :: relay': TELEMETRY,
  'services/traffic-detectors.ts :: current': TELEMETRY,
  'services/traffic-detectors.ts :: loadedAt': TELEMETRY,
  'services/traffic-detectors.ts :: loading': TELEMETRY,
  'services/traffic-detectors.ts :: timer': TELEMETRY,
  'services/traffic-digest.ts :: registered': TELEMETRY,
  'services/traffic-down-history.ts :: providers': TELEMETRY,
  'services/traffic-entity-history.ts :: OWN_DOWN_NODES': TELEMETRY,
  'services/traffic-geoip.ts :: builtAt': TELEMETRY,
  'services/traffic-geoip.ts :: cache': TELEMETRY,
  'services/traffic-geoip.ts :: checkedAt': TELEMETRY,
  'services/traffic-geoip.ts :: dbType': TELEMETRY,
  'services/traffic-geoip.ts :: lastError': TELEMETRY,
  'services/traffic-geoip.ts :: loadedMtime': TELEMETRY,
  'services/traffic-geoip.ts :: loadedPath': TELEMETRY,
  'services/traffic-geoip.ts :: reader': TELEMETRY,
  'services/traffic-inflight.ts :: byReq': TELEMETRY,
  'services/traffic-inflight.ts :: byTrace': TELEMETRY,
  'services/traffic-inflight.ts :: endListener': TELEMETRY,
  'services/traffic-inspect.ts :: sources': TELEMETRY,
  'services/traffic-inspect/request-capture.ts :: gqlChains': TELEMETRY,
  'services/traffic-inspect/request-capture.ts :: nodeId': TELEMETRY,
  'services/traffic-inspect/request-capture.ts :: publish': TELEMETRY,
  'services/traffic-inspect/request-capture.ts :: relayStarted': TELEMETRY,
  'services/traffic-inspect/request-statements.ts :: seenTraces': TELEMETRY,
  'services/traffic-inspect/request-statements.ts :: shapes': TELEMETRY,
  'services/traffic-map-settings.ts :: listeners': TELEMETRY,
  'services/traffic-map.ts :: cluster': TELEMETRY,
  'services/traffic-map.ts :: extCompiled': TELEMETRY,
  'services/traffic-map.ts :: extRoutes': TELEMETRY,
  'services/traffic-map.ts :: extSig': TELEMETRY,
  'services/traffic-map.ts :: listIds': TELEMETRY,
  'services/traffic-map.ts :: nextListId': TELEMETRY,
  'services/traffic-map.ts :: nowSec': TELEMETRY,
  'services/traffic-map.ts :: outboundResolver': TELEMETRY,
  'services/traffic-map.ts :: requestTaps': TELEMETRY,
  'services/traffic-map.ts :: socketEntityCache': TELEMETRY,
  'services/traffic-map.ts :: thisNode': TELEMETRY,
  'services/traffic-minutes.ts :: pushTimer': TELEMETRY,
  'services/traffic-minutes.ts :: recordEdges': TELEMETRY,
  'services/traffic-minutes.ts :: recording': TELEMETRY,
  'services/traffic-minutes.ts :: settingsTimer': TELEMETRY,
  'services/traffic-node-info.ts :: LANE_IDS': TELEMETRY,
  'services/traffic-overhead.ts :: threshold': TELEMETRY,
  'services/traffic-rollups.ts :: dataFromCache': TELEMETRY,
  'services/traffic-security-alerts.ts :: app': TELEMETRY,
  'services/traffic-security-alerts.ts :: hour': TELEMETRY,
  'services/traffic-security-alerts.ts :: raisedPeople': TELEMETRY,
  'services/traffic-security.ts :: proxyCache': TELEMETRY,
  'services/traffic-source.ts :: runListeners': TELEMETRY,
  'services/traffic-taps.ts :: storeOverride': TELEMETRY,
  'services/traffic-taps.ts :: taps': TELEMETRY,
  'services/traffic-taps/auth-mix.ts :: tap': TELEMETRY,
  'services/traffic-taps/auth-rejections.ts :: REJECT_STATUSES': TELEMETRY,
  'services/traffic-taps/auth-rejections.ts :: tap': TELEMETRY,
  'services/traffic-taps/cache-ratio.ts :: CACHED_LANES': TELEMETRY,
  'services/traffic-taps/cache-ratio.ts :: tap': TELEMETRY,
  'services/traffic-taps/capacity.ts :: poolSamples': TELEMETRY,
  'services/traffic-taps/capacity.ts :: poolTimer': TELEMETRY,
  'services/traffic-taps/change-markers.ts :: epochMoves': TELEMETRY,
  'services/traffic-taps/change-markers.ts :: epochTimer': TELEMETRY,
  'services/traffic-taps/change-markers.ts :: lastEpoch': TELEMETRY,
  'services/traffic-taps/change-markers.ts :: versionRecorded': TELEMETRY,
  'services/traffic-taps/conflicts.ts :: CONFLICT_CODES': TELEMETRY,
  'services/traffic-taps/conflicts.ts :: tap': TELEMETRY,
  'services/traffic-taps/db-time.ts :: attached': TELEMETRY,
  'services/traffic-taps/db-time.ts :: pending': TELEMETRY,
  'services/traffic-taps/duplicates.ts :: tap': TELEMETRY,
  'services/traffic-taps/graphql-resolvers.ts :: lastFrameAt': TELEMETRY,
  'services/traffic-taps/masquerade.ts :: tap': TELEMETRY,
  'services/traffic-taps/metadata-cache.ts :: timer': TELEMETRY,
  'services/traffic-taps/misconfigured.ts :: ownCache': TELEMETRY,
  'services/traffic-taps/near-timeout.ts :: tap': TELEMETRY,
  'services/traffic-taps/node-health.ts :: gc': TELEMETRY,
  'services/traffic-taps/node-health.ts :: heapPoints': TELEMETRY,
  'services/traffic-taps/node-health.ts :: hist': TELEMETRY,
  'services/traffic-taps/node-health.ts :: journal': TELEMETRY,
  'services/traffic-taps/node-health.ts :: observer': TELEMETRY,
  'services/traffic-taps/node-health.ts :: samples': TELEMETRY,
  'services/traffic-taps/node-health.ts :: started': TELEMETRY,
  'services/traffic-taps/node-health.ts :: timer': TELEMETRY,
  'services/traffic-taps/nodes.ts :: nodes': TELEMETRY,
  'services/traffic-taps/rehearsal.ts :: tap': TELEMETRY,
  'services/traffic-taps/response-bytes.ts :: tap': TELEMETRY,
  'services/traffic-taps/roles.ts :: tap': TELEMETRY,
  'services/traffic-taps/session-guard.ts :: onTwoPlaces': TELEMETRY,
  'services/traffic-taps/telemetry-out.ts :: instance': TELEMETRY,
  'services/traffic-taps/workspaces.ts :: tap': TELEMETRY,
  'services/transition-checks.ts :: checks': REGISTRY,
  'services/transition-guard.ts :: _redis': CONN,
  'services/unit-of-work.ts :: detachedOut': 'process count of detached effects (Task 13)',
  'services/user-scopes.ts :: resetGen': GEN,
  'services/users.ts :: FILTERABLE_USER_COLS': FIXED,
  'services/virtual-filters.ts :: riskModule': LAZY,
  'services/wait-reasons.ts :: redisRef': CONN,
  'services/wait-reasons.ts :: timer': TIMER,
  'services/watch-list/user-store.ts :: saveListeners': REGISTRY,
  'services/widget-live.ts :: budget':
    'process recompute budget (WIDGET_LIVE_MAX_PER_MIN is per process)',
  'services/widget-live.ts :: bySocket': "per socket id; each socket watches its own app's widgets",
  'services/widget-live.ts :: running': 'process concurrency count of widget recomputes',
  'services/widget-live.ts :: stats': DIAG,
  'services/widget-live.ts :: sweepTimer': TIMER,
  'services/widget-live.ts :: unlisten': REGISTRY,
  'services/widget-live.ts :: waiting': 'process concurrency queue of widget recomputes',
  'services/widget-live.ts :: watchCount': PROC,
  'services/workflow-conditions.ts :: CONDITION_RULE_OPS': FIXED,
  'services/workflow-conditions.ts :: RELATED_OPS': FIXED
}

/** Keyed per app in a way the scan cannot follow (the key comes from a caller or a helper). */
const KEYED: Record<string, string> = {
  'services/capacity/app-usage.ts :: storage':
    'keyed by the tenant id (t.id, read inside withTenant) — "" on a dedicated app',
  'services/capacity/enforce.ts :: localCounts':
    'key = `<tenant id>|<minute>`, tenant id = getTenantId() of the request',
  'services/capacity/enforce.ts :: gates': 'keyed by the tenant id of the fan-out turn (t.id)',
  'services/capacity/enforce.ts :: stored': 'keyed by the tenant id = getTenantId() of the upload',
  'services/cache-warm.ts :: usageMemo':
    'key = usageMemoKey() = `${currentTenantKey()}|<slice>`; handed to pruneUsageMemo, which only drops expired entries',
  'services/cache-warm.ts :: queueUsageMemo':
    'key = usageMemoKey() (starts with currentTenantKey()); pruneUsageMemo only drops expired entries',
  'services/command-center/work-access.ts :: memos':
    'tenantMemo() key = `${currentTenantKey()}|<name>`; also aliased as `store` for the same writes',
  'services/raw-write-announcer.ts :: queue':
    'keyed by currentTenantKey() (Task 13); swapped out whole by the flush',
  'services/read-caches.ts :: totals':
    'totalKey() = scopeKey(tenant, collection) + statement, tenant = currentTenantKey()',
  'services/read-caches.ts :: rows':
    'the row key starts with scopeKey(tenant, collection), tenant = currentTenantKey()',
  'flows/registry.ts :: orderChains': 'key starts with currentTenantKey()',
  'plugins/graphql.ts :: _schemas':
    'rememberSchema(key) with key = schemaTenantKey() = currentTenantKey()',
  'routes/form-status.ts :: sigs': 'sharedSignature key = `${currentTenantKey()}|<submission>`',
  'routes/message-actions.ts :: linkSigs':
    'sharedSignature key = `${currentTenantKey()}|<instance>|<holder>`',
  'routes/presence.ts :: adminExtrasCache': 'get(tenant, …): the key is currentTenantKey()',
  'routes/presence.ts :: baseCache': 'get(tenant, …): the key is currentTenantKey()',
  'routes/presence.ts :: restrictionsCache':
    'key `${tenant}|<viewer>`, tenant = currentTenantKey()',
  'routes/presence.ts :: signatureCache':
    'key `${tenant}|<signature>`, tenant = currentTenantKey()',
  'routes/presence.ts :: viewerCache': 'key `${tenant}|<viewer key>`, tenant = currentTenantKey()',
  'routes/share-links.ts :: shareSigs': 'sharedSignature key = `${currentTenantKey()}|<token>`',
  'routes/team-board.ts :: boardCache': 'key `${currentTenantKey()}|<viewer>`',
  'routes/traffic-map.ts :: catalogCaches':
    'keyed by Traffic Map store id = currentStoreId() (one store per tenant)',
  'routes/traffic-map.ts :: catalogInflights':
    'keyed by Traffic Map store id = currentStoreId() (one store per tenant)',
  'routes/widget.ts :: feedSigs': 'sharedSignature key = `${currentTenantKey()}|<token>`',
  'services/activity-feed.ts :: scopeCache':
    'routes/activity.ts builds the key from the tenant + the person + the sources',
  'services/ai-tool-lane.ts :: lanes': 'laneFor(currentTenantKey())',
  'services/flow-script-isolated.ts :: gate':
    'script-step slots: byApp keyed by currentTenantKey(); active + queue are the process-wide cap (no app data)',
  'services/ai-tool-reuse.ts :: changedAt':
    "key `${tenant}|<collection>`, tenant = the event's own tenant",
  'services/app-links.ts :: appCache':
    'remember(appCache, key) with key = appKey(<user>), bounded by LINK_CACHE_MAX',
  'services/app-links.ts :: emailCache':
    'remember(emailCache, appKey(<address>)), bounded by LINK_CACHE_MAX',
  'services/approval-changes.ts :: localGate':
    'claimOnce keys start with currentTenantKey() (burstKey / claim callers)',
  'services/client-versions-cluster.ts :: cache':
    'listClusterClientsCached(io, tenant) keys by the tenant its caller passes',
  'services/command-center/work-access.ts :: pinnedMemos':
    'tenantMemo() key = `${currentTenantKey()}|<name>`',
  'services/config-conformance.ts :: liveRowRuleCache':
    'one lookup cache per currentTenantKey() (Task 13)',
  'services/dashboard-feed.ts :: pulseCache':
    'key = `${currentTenantKey()}|<user>|<dimension>` (setCapped)',
  'services/dashboard-feed.ts :: tallyCache':
    'key = `${currentTenantKey()}|<cache key>` (setCapped)',
  'services/field-change-relay.ts :: readCache':
    'remember(readCache, key) with key = `${currentTenantKey()}|<user>|…`',
  'services/field-change-relay.ts :: valueFieldCache':
    'remember(valueFieldCache, key) with key = `${currentTenantKey()}|…|<collection>`',
  'services/huddle-marks.ts :: invalidated':
    'markKey(tenant, room): the tenant its caller passes (the tenant comes from the caller: services/huddle.ts passes scope.tenantNow(), set by plugins/socketio.ts)',
  'services/huddle-ring.ts :: timers':
    'ringKey(input.tenant, input.room): the tenant of the call (the tenant comes from the caller: services/huddle.ts passes scope.tenantNow(), set by plugins/socketio.ts)',
  'services/huddle-sessions.ts :: tableSeen':
    'hasTable(tenant) keys by the tenant its caller passes (the tenant comes from the caller: services/huddle.ts passes scope.tenantNow(), set by plugins/socketio.ts)',
  'services/items.ts :: relCache':
    'RelationCache prefixes every key with getTenantId() (get / has / set / delete)',
  'services/layout-analysis.ts :: memo':
    'memoSet(key) with key = memoKey() = getTenantId() + kind + collection',
  'services/log-ring.ts :: ring':
    "every line carries the app it was logged in (currentTenantKey()); readLog returns the reader's app's lines only",
  'services/mcp-sessions.ts :: localStreams':
    'streamKey(s) = `${s.tenant}\u0000${s.id}` (the tenant comes from the caller, routes/mcp-live.ts)',
  'services/mcp-sessions.ts :: mem':
    "metaKey(meta.tenant, id): the session's own tenant (the tenant comes from the caller, routes/mcp-live.ts)",
  'services/owner-change-live.ts :: memos': 'memoFor(tenant): one memo map per tenant',
  'services/pipeline-engine.ts :: ownerGroupCache': 'key = app + template (Task 13)',
  'services/raw-write-fanout.ts :: tenantCache': 'cacheFor(tenant): one cache per tenant',
  'services/read-gate.ts :: gates': 'one gate per tenant (gates.set(tenant, …))',
  'services/readiness.ts :: freshRuns':
    'keyed by readiness scope = currentTenantKey() + API version',
  'services/readiness.ts :: inflight':
    'keyed by readiness scope = currentTenantKey() + API version',
  'services/readiness.ts :: memory':
    'one map per readiness scope = currentTenantKey() + API version',
  'services/readiness.ts :: refreshing':
    'keyed by readiness scope = currentTenantKey() + API version',
  'services/record-header-signals.ts :: ownerSetup':
    'the lookup helper keys by `${currentTenantKey()}\u0000<key>`',
  'services/record-header-signals.ts :: partnerPush':
    'the lookup helper keys by `${currentTenantKey()}\u0000<key>`',
  'services/recovery/status.ts :: refreshing': 'keyed by tenant (refreshing.set(tenant, …))',
  'services/recovery/status.ts :: slow': 'keyed by tenant (slow.set(tenant, …))',
  'services/request-trace.ts :: buffer':
    "every kept trace is tagged with its app (appOfTrace); listTraces / getTrace return the reader's app's traces only",
  'services/screen-share-socket.ts :: shareCache':
    "key = `${tenant}|${ticket}`, the socket's tenant (the tenant comes from the caller, plugins/socketio.ts)",
  'services/screen-share.ts :: personCache':
    'keyed by tenant + user id (credential guard, Task 12) (the tenant comes from the caller, routes/support-screen-share.ts)',
  'services/screen-share.ts :: ticketCache':
    'keyed by tenant + ticket id (credential guard, Task 12) (the tenant comes from the caller, routes/support-screen-share.ts)',
  'services/search-fts.ts :: answerCache': 'searchAnswerKey() starts with currentTenantKey()',
  'services/search-fts.ts :: ftsCache': "get(currentTenantKey() || '-', \u2026)",
  'services/search-signals.ts :: learnedCache':
    'passed to the short memo with key `${currentTenantKey()}\u0000<query>`',
  'services/search-signals.ts :: recentCache':
    'passed to the short memo with key `${currentTenantKey()}\u0000<user>`',
  'services/session-replay-index.ts :: queue':
    'each job carries the async context of the app that scheduled it (AsyncLocalStorage.snapshot()) and runs in it',
  'services/snooze-wake.ts :: perTenant': "keyed by the timer's tenant",
  'services/socket-health.ts :: scopes':
    'scopeOf(tenant): one scope per tenant (the tenant comes from the caller, plugins/socketio.ts)',
  'services/socket-transport.ts :: byTenant':
    'keyed by tenant (the tenant comes from the caller, plugins/socketio.ts)',
  'services/socket-transport.ts :: scopes':
    'scopeOf(tenant): one scope per tenant (the tenant comes from the caller, plugins/socketio.ts)',
  'services/traffic-actions/temp-cache.ts :: entries':
    'cacheKey() hashes the Traffic Map store (one per tenant) into every key',
  'services/traffic-actions/temp-cache.ts :: epochs':
    "keyed `${store}|<collection>`, store = the tenant's Traffic Map store",
  'services/traffic-map-batch.ts :: states':
    'stateOf(store): one state per Traffic Map store; services/traffic-map.ts passes currentStoreId() (one store per tenant)',
  'services/traffic-map.ts :: mapStores':
    'one Traffic Map store per tenant (S() keys by currentStoreId())',
  'services/unit-of-work.ts :: lanes': 'key = getTenantId() (Task 13)',
  'services/usage-live.ts :: cache': 'entry(key) with key = currentTenantKey()',
  'services/widget-live.ts :: groups': "groupId(w.tenant, spec): the watch's own tenant",
  'services/widget-live.ts :: tenantBudgets': 'keyed by tenant'
}

// ── Final review (rest) I-1: an app that leaves keeps nothing behind ──
// A keyed module state must also be DROPPED when its app leaves the process (unplaced, or moved
// away; forgetAppState from services/tenancy/hub-source.ts), or a later return reads entries
// cached before it left: rollups, relations and columns added while it ran elsewhere stay
// unknown here. appMap / appSet / appBox / tenantState() do it by construction; a hand-keyed Map
// / Set does it by `registerAppKeyed(new Map…())` (services/app-forget.ts). A createShortCache
// expires by construction. Every other keyed state is listed here with why it may stay.
const INFLIGHT =
  'work running in this process now (a run flag, a claim, a queued flush and its timer): it ends by itself, and dropping it mid-run could start the same work twice'
const LIVE =
  'state of open sockets, sessions or live watches of this process: they close when the app leaves'
const GATE =
  'a concurrency lane or gate holding queued callers: dropping it mid-wait would strand them; it holds no app data'
const TELEM =
  'telemetry of this process (counters, Traffic Map stores, trace / log lines tagged with their app), never read as app data'
const LEFT_ON_LEAVE: Record<string, string> = {
  'functions/queue-materialization-jobs.ts :: runningHere': INFLIGHT,
  'functions/queue-materialization-jobs.ts :: rerunHere': INFLIGHT,
  'hooks/notification-subscriptions.ts :: pendingRecordChanges': INFLIGHT,
  'hooks/record-integrity.ts :: pending': INFLIGHT,
  'hooks/task-done-when.ts :: pending': INFLIGHT,
  'plugins/socketio.ts :: recordViewers': LIVE,
  'routes/activity-trail.ts :: verifyRunning': INFLIGHT,
  'routes/presence.ts :: broadcastPending': INFLIGHT,
  'routes/traffic-map.ts :: catalogCaches': TELEM,
  'routes/traffic-map.ts :: catalogInflights': TELEM,
  'flows/registry.ts :: orderChains': INFLIGHT,
  'services/activity-undo-deps.ts :: localClaims': INFLIGHT,
  'services/ai-tool-lane.ts :: lanes': GATE,
  'services/approval-changes.ts :: bursts': INFLIGHT,
  'services/approval-changes.ts :: localGate': INFLIGHT,
  'services/bulk-change-notice.ts :: bursts': INFLIGHT,
  'services/catalog-impact.ts :: pending': INFLIGHT,
  'services/collection-live-mode.ts :: batches': INFLIGHT,
  'services/config-conformance.ts :: liveRowRuleCache':
    'a `let` filled lazily; each entry lives 60 s (LIVE_CACHE_MS) and is rebuilt after',
  'services/db-tuning/observe-run.ts :: running': INFLIGHT,
  'services/export-runs.ts :: local': INFLIGHT,
  'services/export-worker.ts :: runningHere': INFLIGHT,
  'services/flow-executor.ts :: runningFlows': INFLIGHT,
  'services/flow-script-isolated.ts :: gate': GATE,
  'services/help-video-render.ts :: queueStates': INFLIGHT,
  'services/hub-transfer/pull.ts :: runs': INFLIGHT,
  'services/huddle-marks.ts :: invalidated': LIVE,
  'services/huddle-ring.ts :: timers': INFLIGHT,
  'services/log-ring.ts :: ring': TELEM,
  'services/maintenance-live.ts :: recheckTimers': INFLIGHT,
  'services/mcp-sessions.ts :: localStreams': LIVE,
  'services/mcp-sessions.ts :: mem': LIVE,
  'services/ops-proposals.ts :: memoryClaims': INFLIGHT,
  'services/ops-report/run.ts :: running': INFLIGHT,
  'services/owner-change-live.ts :: pending': INFLIGHT,
  'services/owner-change-live.ts :: running': INFLIGHT,
  'services/people-live.ts :: pending': INFLIGHT,
  'services/pipeline-engine.ts :: ownerRefreshes': INFLIGHT,
  'services/queue-owner-refresh.ts :: pending': INFLIGHT,
  'services/raw-write-announcer.ts :: queue': INFLIGHT,
  'services/read-gate.ts :: gates': GATE,
  'services/recovery/drill.ts :: running': INFLIGHT,
  'services/recovery/status.ts :: queued': INFLIGHT,
  'services/related-announce.ts :: forwards': INFLIGHT,
  'services/related-announce.ts :: pending': INFLIGHT,
  'services/relay-retry-queue.ts :: queues': INFLIGHT,
  'services/request-trace.ts :: buffer': TELEM,
  'services/session-replay-cost.ts :: pendings': INFLIGHT,
  'services/session-replay-index.ts :: queue': INFLIGHT,
  'services/snooze-wake.ts :: perTenant': INFLIGHT,
  'services/snooze-wake.ts :: timers': INFLIGHT,
  'services/socket-health.ts :: scopes': TELEM,
  'services/socket-transport.ts :: byTenant': LIVE,
  'services/socket-transport.ts :: scopes': TELEM,
  'services/sql-checks/run.ts :: running': INFLIGHT,
  'services/traffic-actions/temp-cache.ts :: entries':
    'keys are hashes of the Traffic Map store and the request (no app key to match); every entry expires with its TTL',
  'services/traffic-map-batch.ts :: states': TELEM,
  'services/traffic-map.ts :: mapStores': TELEM,
  'services/traffic-taps.ts :: stores': TELEM,
  'services/trackers/crons.ts :: recurAgain': INFLIGHT,
  'services/trackers/crons.ts :: recurInFlight': INFLIGHT,
  'services/unit-of-work.ts :: lanes': GATE,
  'services/widget-live.ts :: groups': LIVE,
  'services/workflow-transitions.ts :: transitionsInFlight': INFLIGHT
}

describe('module-level state on a shared deployment (Task 22 guard)', () => {
  const found = scanModuleState(SRC)
  const byId = new Map(found.map((f) => [f.id, f]))

  it('scans the folders a shared deployment runs', () => {
    expect(SCAN_DIRS).toEqual(
      expect.arrayContaining(['db/', 'flows/', 'hooks/', 'routes/', 'services/', 'plugins/'])
    )
    expect(found.length).toBeGreaterThan(1000)
    expect(found.some((f) => f.file === 'hooks/activity.ts')).toBe(true)
  })

  it('every module-level state is keyed per app or listed with a reason', () => {
    const missing = found
      .filter((f) => !f.keyed && !SHARED[f.id] && !KEYED[f.id])
      .map((f) => `${f.id} (${f.kind}, line ${f.line})`)
    expect(
      missing,
      `key it per app (appMap/appSet/appBox) or list it:\n${missing.join('\n')}`
    ).toEqual([])
  })

  it('no stale entry (gone, or now detected as keyed)', () => {
    const listed = [...Object.keys(SHARED), ...Object.keys(KEYED)]
    const stale = listed.filter((id) => !byId.has(id) || byId.get(id)?.keyed)
    expect(stale, `remove from the lists:\n${stale.join('\n')}`).toEqual([])
  })

  it('no id is listed twice', () => {
    const all = [...Object.keys(SHARED), ...Object.keys(KEYED)]
    expect(all.length).toBe(new Set(all).size)
  })

  it('a state listed as keyed sits in a module that names the app (or its reason names the file that builds the key)', () => {
    // A tenant helper call, not just the word "tenant" in a comment (review M-5).
    const names = (file: string) => existsSync(join(SRC, file)) && TENANT_REF.test(read(file))
    const bad = Object.entries(KEYED)
      .filter(([id, why]) => {
        const file = id.split(' :: ')[0] as string
        const via = [
          ...why.matchAll(/\b((?:services|routes|plugins|db|hooks|flows)\/[\w/.-]+\.ts)\b/g)
        ]
        return !names(file) && !via.some((m) => names(m[1] as string))
      })
      .map(([id]) => id)
    expect(bad).toEqual([])
  })

  it('every entry says why', () => {
    for (const [id, why] of [
      ...Object.entries(SHARED),
      ...Object.entries(KEYED),
      ...Object.entries(LEFT_ON_LEAVE)
    ])
      expect(why.length, id).toBeGreaterThan(10)
  })

  it('every keyed state is dropped when its app leaves (registerAppKeyed) or listed with why it stays', () => {
    const keyedHere = found.filter((f) => f.keyed || KEYED[f.id])
    const missing = keyedHere
      .filter((f) => !f.forgets && f.kind !== 'createShortCache' && !LEFT_ON_LEAVE[f.id])
      .map((f) => `${f.id} (${f.kind}, line ${f.line})`)
    expect(
      missing,
      `wrap it: registerAppKeyed(new Map…()) (services/app-forget.ts), or list it in LEFT_ON_LEAVE:\n${missing.join('\n')}`
    ).toEqual([])
  })

  it('LEFT_ON_LEAVE lists only keyed states that are not registered', () => {
    const stale = Object.keys(LEFT_ON_LEAVE).filter((id) => {
      const f = byId.get(id)
      return !f || !(f.keyed || KEYED[id]) || f.forgets
    })
    expect(stale, `remove from LEFT_ON_LEAVE:\n${stale.join('\n')}`).toEqual([])
  })

  it('a registered state is keyed per app (its keys name the app)', () => {
    const unkeyed = found.filter((f) => f.forgets && !f.keyed && !KEYED[f.id]).map((f) => f.id)
    expect(unkeyed).toEqual([])
  })
})
