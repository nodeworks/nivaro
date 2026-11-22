import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// Hub phase 6, Task 13 (ruling P6-4): on a Hub shared deployment one process runs the core record
// hooks for many apps. Every module-level Map / Set / `let` in a module those hooks reach — the
// registrars' modules (hooks/core-hooks.ts) and the event-flow dispatcher, plus every module they
// import directly — is either kept per app (tenantState(), or a key that starts with the app,
// currentTenantKey() / getTenantId()) or listed below with the reason it may be shared.
// Self-hosted the app key is '' (one app), so keying changes nothing there.
//
// Not covered here: modules reached only through routes, or deeper than one import — the
// phase-wide sweep (Task 22) owns those.

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '../../..')
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8')

function importsOf(rel: string): string[] {
  const out: string[] = []
  for (const m of read(rel).matchAll(/(?:from\s*|import\(\s*)'(\.\.?\/[\w/.-]+)\.js'/g)) {
    const p = `${normalize(join(dirname(rel), m[1] as string))}.ts`
    if (existsSync(join(SRC, p))) out.push(p)
  }
  return out
}

/** The registrars' modules and the dispatcher, then everything they import directly. */
function reachedModules(): string[] {
  const roots = ['hooks/core-hooks.ts', 'flows/tenant-event-flows.ts']
  const hookMods = new Set(roots)
  for (const r of roots)
    for (const p of importsOf(r)) if (/^(hooks|flows)\//.test(p)) hookMods.add(p)
  const all = new Set(hookMods)
  for (const m of hookMods) for (const p of importsOf(m)) all.add(p)
  return [...all].sort()
}

interface StateDecl {
  id: string
  kind: string
}

/** Module-level `let`s and Map / Set consts (ALL_CAPS consts are fixed lookup tables). WeakMap /
 *  WeakSet are keyed by an object (a request, a context, a knex handle) and tenantState() is per
 *  app by construction: both pass without a listing. */
function stateOf(rel: string): StateDecl[] {
  const sf = ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true)
  const out: StateDecl[] = []
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue
    const isLet = (st.declarationList.flags & ts.NodeFlags.Let) !== 0
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name)) continue
      const name = d.name.text
      const init = d.initializer
      let kind = ''
      if (isLet) kind = 'let'
      else if (
        init &&
        ts.isNewExpression(init) &&
        ts.isIdentifier(init.expression) &&
        /^(Map|Set)$/.test(init.expression.text)
      )
        kind = init.expression.text
      if (!kind) continue
      if (!isLet && /^[A-Z][A-Z0-9_]*$/.test(name)) continue
      out.push({ id: `${rel}#${name}`, kind })
    }
  }
  return out
}

type Verdict = { keyed: string } | { shared: string }

const APP_REF = 'the Fastify / Socket.io instance of this process (one per process)'
const CODE_REGISTRY = 'registered by code at boot, the same for every app'
const DIAG = 'process diagnostics (counts, timings, a log-once flag), no app data'

/** Every reached module-level state, by `<file>#<name>`. */
const VERDICTS: Record<string, Verdict> = {
  // ── db ──
  'db/index.ts#probeKnex': { shared: 'health probe connection of this process (static DB)' },
  'db/index.ts#migrationKnex': { shared: 'migration connection of this process (static DB)' },
  // ── flows ──
  'flows/registry.ts#_ops': { shared: CODE_REGISTRY },
  'flows/registry.ts#_triggers': { shared: CODE_REGISTRY },
  'flows/registry.ts#_listeners': { shared: CODE_REGISTRY },
  'flows/registry.ts#orderChains': { keyed: 'key starts with currentTenantKey()' },
  'flows/registry.ts#executorModule': { shared: 'a lazily imported module' },
  'flows/tenant-event-flows.ts#cache': { keyed: 'key = currentTenantKey()' },
  'flows/tenant-event-flows.ts#started': { shared: APP_REF },
  // ── hooks ──
  'hooks/activity.ts#levelCache': { keyed: 'levelKey() = app + collection' },
  'hooks/agent-triggers.ts#registered': { shared: 'registration flag' },
  'hooks/aggregate-caps.ts#_app': { shared: APP_REF },
  'hooks/ai-validation.ts#_app': { shared: APP_REF },
  'hooks/ai-validation.ts#settingsCache': { keyed: 'settingsKey() = app + collection' },
  'hooks/ai-validation.ts#loggedNoKey': { shared: DIAG },
  'hooks/alerts.ts#_app': { shared: APP_REF },
  'hooks/core-hooks.ts#registered': { shared: 'registration flag' },
  'hooks/cross-triggers.ts#_app': { shared: APP_REF },
  'hooks/embeddings.ts#_app': { shared: APP_REF },
  'hooks/embeddings.ts#fieldCache': { keyed: 'app + collection' },
  'hooks/field-watches.ts#_app': { shared: APP_REF },
  'hooks/notification-subscriptions.ts#_app': { shared: APP_REF },
  'hooks/notification-subscriptions.ts#parentRelCache': { keyed: 'app + collection' },
  'hooks/notification-subscriptions.ts#boundCache': { keyed: 'app + collection' },
  'hooks/notification-subscriptions.ts#pendingRecordChanges': {
    keyed: 'app + record + actor; flush runs in the writes app context'
  },
  'hooks/record-integrity.ts#pending': { keyed: 'app + record' },
  'hooks/record-integrity.ts#running': {
    shared: 'process worker count (CONCURRENCY is per process)'
  },
  'hooks/record-integrity.ts#checkable': { keyed: 'app + collection' },
  'hooks/task-done-when.ts#pending': { keyed: 'app + record' },
  'hooks/workflow-auto.ts#autoStates': { keyed: 'one state per currentTenantKey()' },
  // ── plugins ──
  'plugins/socketio.ts#_ioRef': { shared: APP_REF },
  'plugins/socketio.ts#recordViewers': {
    shared: 'per socket room; record rooms carry the app (tenantScopedRoom)'
  },
  'plugins/socketio.ts#socketMeta': { shared: 'per socket id' },
  'plugins/socketio.ts#broadcastRoom': { shared: 'a function set at boot' },
  'plugins/socketio.ts#presenceNoter': { shared: 'a function set at boot' },
  'plugins/socketio.ts#pagePresenceReader': { shared: 'a function set at boot' },
  'plugins/socketio.ts#pageSnapshotReader': { shared: 'a function set at boot' },
  'plugins/socketio.ts#pagePrefixReader': { shared: 'a function set at boot' },
  // ── services ──
  'services/activity-pattern-gate.ts#indexes': { keyed: 'key = currentTenantKey()' },
  'services/activity-pattern-gate.ts#loading': { keyed: 'key = currentTenantKey()' },
  'services/activity.ts#_pulseApp': { shared: APP_REF },
  'services/activity.ts#hasOriginCol': { keyed: 'key = getTenantId()' },
  'services/ai-client.ts#bearerCache': {
    shared: 'keyed by the gateway token URL + client id: one token per credential, whoever asks'
  },
  'services/ai-client.ts#imageFallbackLogged': { shared: DIAG },
  'services/ai-client.ts#imageFallbacks': { shared: DIAG },
  'services/ai-client.ts#fallbackCount': { shared: DIAG },
  'services/alert-banners.ts#memos': { keyed: 'one memo per currentTenantKey()' },
  'services/app-links.ts#registered': { shared: CODE_REGISTRY },
  'services/app-links.ts#settingsCache': { keyed: 'one entry per currentTenantKey()' },
  'services/app-links.ts#appCache': { keyed: 'app + user id' },
  'services/app-links.ts#emailCache': { keyed: 'app + email' },
  'services/approval-changes.ts#bursts': { keyed: 'key starts with currentTenantKey()' },
  'services/approval-changes.ts#localGate': { keyed: 'key starts with currentTenantKey()' },
  'services/bulk-change-notice.ts#bursts': { keyed: 'key starts with the tenant id' },
  'services/chain-columns.ts#probes': { keyed: 'key = getTenantId() + table' },
  'services/collections.ts#collectionCache': { keyed: 'metaKey() = app + collection' },
  'services/collections.ts#fieldsCache': { keyed: 'metaKey() = app + collection' },
  'services/collections.ts#physicalColumnsCache': { keyed: 'key = getTenantId() + table' },
  'services/collections.ts#metadataGen': {
    shared: 'a change counter; any app moving it only makes readers refetch'
  },
  'services/config-conformance.ts#physicalColsCache': { keyed: 'app + table' },
  'services/config-conformance.ts#compiledCache': { keyed: 'app + collection' },
  'services/config-conformance.ts#liveRowRuleCache': { keyed: 'one lookup cache per app' },
  'services/flow-executor.ts#runningFlows': { keyed: 'app + flow id' },
  'services/flow-executor.ts#lastErrorNotifyAt': { keyed: 'app + flow id' },
  'services/inactive-people-notice.ts#defaultApp': { shared: APP_REF },
  'services/io-holder.ts#_app': { shared: APP_REF },
  'services/io-holder.ts#_io': { shared: APP_REF },
  'services/items.ts#_formulaSnapshots': { keyed: 'one snapshot per currentTenantKey()' },
  'services/items.ts#tableColumnsCache': { keyed: 'app + table' },
  'services/items.ts#columnShapesCache': { keyed: 'getTenantId() + collection' },
  'services/items.ts#columnCache': { keyed: 'columnCacheKey() = getTenantId() + table' },
  'services/items.ts#columnTypeCache': { keyed: 'getTenantId() + table' },
  'services/items.ts#wsColumnCache': { keyed: 'getTenantId() + collection' },
  'services/items.ts#inheritableFieldsCache': { keyed: 'app + collection' },
  'services/items.ts#readLogThrottle': { keyed: 'app + record + user' },
  'services/items.ts#unbuiltAliases': { keyed: 'getTenantId() + collection' },
  'services/mail-types.ts#registry': { shared: CODE_REGISTRY },
  'services/mail.ts#templateRoots': { shared: 'template folders of the image and its extensions' },
  'services/mail.ts#engine': { shared: 'the Liquid engine over those folders' },
  'services/mail.ts#overrideCache': { keyed: 'one entry per currentTenantKey()' },
  'services/mail.ts#mailLogWarned': { shared: DIAG },
  'services/note-authorship.ts#hasOrigin': { keyed: 'getTenantId() + table' },
  'services/notification-channels.ts#prefsCache': { keyed: 'prefsKey() = app + user' },
  'services/notification-templates.ts#cache': { keyed: 'one entry per currentTenantKey()' },
  'services/owner-mail-flows.ts#cache': { keyed: 'key = currentTenantKey()' },
  'services/permissions.ts#readableColumnsCache': { keyed: 'app + collection' },
  'services/pipeline-engine.ts#ownerGroupCache': { keyed: 'app + template' },
  'services/pipeline-engine.ts#fallbackMetaCache': { keyed: 'app + template' },
  'services/pipeline-engine.ts#bindingsCache': { keyed: 'app + collection' },
  'services/pipeline-engine.ts#ownerCacheGen': {
    shared: 'a change counter; any app moving it only makes readers refetch'
  },
  'services/pipeline-engine.ts#ownerRefreshes': {
    keyed: 'one refresh run + queue per currentTenantKey(), run in that app'
  },
  'services/queues.ts#cacheRebuildAskedAt': { keyed: 'key starts with currentTenantKey()' },
  'services/raw-write-announcer.ts#queue': { keyed: 'key = currentTenantKey()' },
  'services/raw-write-announcer.ts#queued': { shared: 'process count of queued announcements' },
  'services/raw-write-announcer.ts#timer': { shared: 'the process flush timer' },
  'services/request-trace.ts#followBudget': { shared: DIAG },
  'services/request-trace.ts#keepNextMatchers': { shared: DIAG },
  'services/request-trace.ts#keptListeners': { shared: DIAG },
  'services/request-trace.ts#traceFallbacks': { shared: DIAG },
  'services/request-trace.ts#wideTables': { shared: DIAG },
  'services/rollups.ts#contributorCaches': { keyed: 'one map per currentTenantKey()' },
  'services/rollups.ts#scaleCache': { keyed: 'key starts with currentTenantKey()' },
  'services/socket-access.ts#knownTables': { keyed: 'key starts with currentTenantKey()' },
  'services/socket-access.ts#joinVerdicts': { keyed: 'key starts with currentTenantKey()' },
  'services/socket-access.ts#pending': {
    shared: 'a process recheck request over sockets; each socket is judged as its own app'
  },
  'services/socket-access.ts#pendingTimer': { shared: 'the process recheck timer' },
  'services/socket-access.ts#recheckRunning': { shared: 'the process recheck run' },
  'services/socket-access.ts#recheckQueued': { shared: 'the process recheck run' },
  'services/trigger-safe.ts#cache': { keyed: 'key = getTenantId()' },
  'services/trigger-safe.ts#inflight': { keyed: 'key = getTenantId()' },
  'services/unit-of-work.ts#lanes': { keyed: 'key = getTenantId()' },
  'services/unit-of-work.ts#detachedOut': { shared: 'process count of detached effects' },
  'services/workflow-conditions.ts#hopTargetCache': { keyed: 'app + collection + hop' },
  'services/workflow-transitions.ts#friendlyFieldCache': { keyed: 'app + collection' },
  'services/workflow-transitions.ts#transitionsInFlight': { keyed: 'app + collection + item' }
}

const TENANT_REF =
  /currentTenantKey\(|getTenantId\(|tenantState\(|tenantKey\(|appKey\(|dropAppEntries\(/

describe('module state reached by the hooks a shared deployment runs', () => {
  const modules = reachedModules()
  const found = modules.flatMap(stateOf)

  it('reaches the registrar modules and their direct imports', () => {
    expect(modules).toContain('hooks/activity.ts')
    expect(modules).toContain('services/config-conformance.ts')
    expect(modules).toContain('services/workflow-transitions.ts')
    expect(modules).toContain('services/flow-executor.ts')
    expect(modules.length).toBeGreaterThan(60)
  })

  it('every module-level Map / Set / let is keyed per app or listed with a reason', () => {
    const missing = found.filter((s) => !VERDICTS[s.id]).map((s) => `${s.id} (${s.kind})`)
    expect(missing, 'not keyed per app and not listed').toEqual([])
  })

  it('a state listed as keyed sits in a module that names the app', () => {
    const bad = Object.entries(VERDICTS)
      .filter(([, v]) => 'keyed' in v)
      .map(([id]) => id.split('#')[0] as string)
      .filter((file) => existsSync(join(SRC, file)) && !TENANT_REF.test(read(file)))
    expect([...new Set(bad)]).toEqual([])
  })

  it('no stale listing', () => {
    const ids = new Set(found.map((s) => s.id))
    expect(Object.keys(VERDICTS).filter((id) => !ids.has(id))).toEqual([])
  })
})
