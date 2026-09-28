/**
 * A test double for the extension context (#829): every registration is
 * recorded, every side effect is captured instead of sent, hooks and crons
 * can be run by the test, and the database is an in-memory fake with the
 * knex chain shape extensions actually use. Nothing here boots the API.
 *
 *   const ctx = createTestContext({ tables: { orders: [{ id: 1, total: 5 }] } })
 *   await myExtension.register(ctx)
 *   await ctx.runHooks('orders', 'create', 'after', { keys: [1], result: { id: 1, total: 5 } })
 *   expect(ctx.calls.notifications).toHaveLength(1)
 */
import type { Knex } from 'knex'
import type {
  ExtensionApp,
  ExtensionContext,
  ExtensionCronMeta,
  ExtensionCronOpts,
  ExtensionEventHandler,
  ExtensionSettingValue
} from './context.js'
import type { FlowOpRegistration, FlowTriggerRegistration } from './flows.js'
import type { ExtensionHookContext, ExtensionHookHandler, HookAction, HookTiming } from './hooks.js'
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
  CollectionViewDef,
  DashboardWidgetDef,
  EventSourceDef,
  FieldTypeDef,
  ImportParserDef,
  IntegrityCheck,
  ItemActionDef,
  LinkRegistration,
  MachineMarkerSet,
  OpsTaskDef,
  OpsTaskOutcome,
  ReadinessCheck,
  RelatedNoteProvider,
  StorageAdapter,
  ValidatorDef
} from './registrations.js'
import type { IntegrationSignal, SignalActionHandler } from './signals.js'
import type { ExtensionUser } from './user.js'

// ─── In-memory knex ─────────────────────────────────────────────────────────

type Row = Record<string, unknown>
type Where = (row: Row) => boolean

const OPS: Record<string, (a: unknown, b: unknown) => boolean> = {
  '=': (a, b) => String(a) === String(b),
  '<>': (a, b) => String(a) !== String(b),
  '!=': (a, b) => String(a) !== String(b),
  '>': (a, b) => Number(a) > Number(b),
  '>=': (a, b) => Number(a) >= Number(b),
  '<': (a, b) => Number(a) < Number(b),
  '<=': (a, b) => Number(a) <= Number(b),
  like: (a, b) =>
    new RegExp(
      `^${String(b)
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/%/g, '.*')}$`,
      'i'
    ).test(String(a ?? ''))
}

function stripAlias(col: string): string {
  const s = col.trim()
  const dot = s.lastIndexOf('.')
  return dot >= 0 ? s.slice(dot + 1) : s
}

export interface TestDbState {
  tables: Record<string, Row[]>
  /** Every statement the fake ran, in order — assert on writes. */
  log: Array<{
    table: string
    op: 'select' | 'insert' | 'update' | 'delete' | 'raw'
    detail?: unknown
  }>
}

/**
 * A knex-shaped in-memory database. Supports the chain extensions use:
 * select / where (object, col=val, col op val, callback) / whereIn /
 * whereNotIn / whereNull / whereNotNull / orderBy / limit / offset /
 * first / pluck / count / insert(+returning) / update / del, `db.raw`
 * (answers `[]` unless `raw` is given), `db.schema.hasColumn`,
 * `db.transaction`, `db.fn.now`. Joins are accepted and ignored — a test
 * seeds the joined columns on the row it expects back.
 */
export function createTestDb(
  opts: { tables?: Record<string, Row[]>; raw?: (sql: string, bindings?: unknown) => unknown } = {}
): Knex & { state: TestDbState } {
  const state: TestDbState = {
    tables: Object.fromEntries(
      Object.entries(opts.tables ?? {}).map(([k, v]) => [k, v.map((r) => ({ ...r }))])
    ),
    log: []
  }
  const rowsOf = (t: string) => {
    if (!state.tables[t]) state.tables[t] = []
    return state.tables[t]
  }
  let nextId = 1000

  function builder(tableExpr: string) {
    const table = tableExpr.split(/\s+/)[0]
    const filters: Where[] = []
    let columns: string[] | null = null
    let order: Array<{ col: string; dir: 'asc' | 'desc' }> = []
    let lim: number | null = null
    let off = 0
    const matching = () => {
      let rows = rowsOf(table).filter((r) => filters.every((f) => f(r)))
      for (const o of [...order].reverse())
        rows = [...rows].sort((a, b) => {
          const x = a[o.col] as never
          const y = b[o.col] as never
          const c = x === y ? 0 : x == null ? -1 : y == null ? 1 : x < y ? -1 : 1
          return o.dir === 'desc' ? -c : c
        })
      if (off) rows = rows.slice(off)
      if (lim != null) rows = rows.slice(0, lim)
      return rows
    }
    const project = (r: Row) => {
      if (!columns || columns.includes('*')) return { ...r }
      const out: Row = {}
      for (const c of columns) {
        const [expr, alias] = c.split(/\s+as\s+/i)
        out[alias ?? stripAlias(expr)] = r[stripAlias(expr)]
      }
      return out
    }
    const q: Record<string, unknown> = {}
    const chain = (f?: () => void) => {
      f?.()
      return q
    }
    q.select = (...cols: unknown[]) =>
      chain(() => {
        const flat = cols.flat().map(String)
        columns = flat.length ? flat : null
      })
    q.column = q.select
    q.distinct = q.select
    q.where = (a: unknown, b?: unknown, c?: unknown) =>
      chain(() => {
        if (typeof a === 'function') {
          // callback: run it against a sub-builder, AND its filters
          const sub = builder(tableExpr) as unknown as { _filters: Where[] }
          // knex hands the builder as both `this` and the first argument
          ;(a as (this: unknown, b: unknown) => void).call(sub, sub)
          filters.push((r) => sub._filters.every((f) => f(r)))
        } else if (typeof a === 'object' && a !== null) {
          for (const [k, v] of Object.entries(a as Row))
            filters.push((r) => OPS['='](r[stripAlias(k)], v))
        } else if (c === undefined) {
          filters.push((r) => OPS['='](r[stripAlias(String(a))], b))
        } else {
          const op = OPS[String(b).toLowerCase()] ?? OPS['=']
          filters.push((r) => op(r[stripAlias(String(a))], c))
        }
      })
    q.andWhere = q.where
    q.orWhere = (a: unknown, b?: unknown, c?: unknown) => {
      const prev = filters.splice(0)
      const combined = prev.length ? (r: Row) => prev.every((f) => f(r)) : null
      ;(q.where as (a: unknown, b?: unknown, c?: unknown) => unknown)(a, b, c)
      const mine = filters.splice(0)
      filters.push((r) => (combined ? combined(r) : false) || mine.every((f) => f(r)))
      return q
    }
    q.whereIn = (col: string, vals: unknown[]) =>
      chain(() => filters.push((r) => vals.map(String).includes(String(r[stripAlias(col)]))))
    q.whereNotIn = (col: string, vals: unknown[]) =>
      chain(() => filters.push((r) => !vals.map(String).includes(String(r[stripAlias(col)]))))
    q.whereNull = (col: string) => chain(() => filters.push((r) => r[stripAlias(col)] == null))
    q.whereNotNull = (col: string) => chain(() => filters.push((r) => r[stripAlias(col)] != null))
    q.whereRaw = () => q
    q.whereExists = () => q
    q.whereNotExists = () => q
    q.orderBy = (col: unknown, dir?: string) =>
      chain(() => {
        if (Array.isArray(col))
          for (const o of col)
            order.push(
              typeof o === 'string'
                ? { col: stripAlias(o), dir: 'asc' }
                : {
                    col: stripAlias(String((o as Row).column)),
                    dir: ((o as Row).order as 'asc' | 'desc') ?? 'asc'
                  }
            )
        else order.push({ col: stripAlias(String(col)), dir: (dir as 'asc' | 'desc') ?? 'asc' })
      })
    q.orderByRaw = () => q
    q.groupBy = () => q
    q.limit = (n: number) => chain(() => (lim = n))
    q.offset = (n: number) => chain(() => (off = n))
    for (const j of ['join', 'leftJoin', 'innerJoin', 'rightJoin', 'crossJoin', 'joinRaw'])
      q[j] = () => q
    q.first = async (...cols: unknown[]) => {
      if (cols.length) (q.select as (...c: unknown[]) => unknown)(...cols)
      state.log.push({ table, op: 'select' })
      const r = matching()[0]
      return r ? project(r) : undefined
    }
    q.pluck = async (col: string) => {
      state.log.push({ table, op: 'select' })
      return matching().map((r) => r[stripAlias(col)])
    }
    q.count = async (expr?: unknown) => {
      state.log.push({ table, op: 'select' })
      const alias =
        typeof expr === 'string' && /\sas\s/i.test(expr)
          ? expr.split(/\sas\s/i)[1].trim()
          : typeof expr === 'object' && expr
            ? Object.keys(expr as Row)[0]
            : 'count'
      return [{ [alias]: matching().length }]
    }
    q.insert = (rows: Row | Row[]) => {
      const list = (Array.isArray(rows) ? rows : [rows]).map((r) => {
        const row = { ...r }
        if (row.id === undefined) row.id = nextId++
        rowsOf(table).push(row)
        return row
      })
      state.log.push({ table, op: 'insert', detail: list })
      const result = Promise.resolve([list.length]) as Promise<unknown> & {
        returning: (c: string) => Promise<Row[]>
      }
      result.returning = async (c: string) => list.map((r) => ({ [c]: r[c] }))
      return result
    }
    q.update = async (patch: Row | string, value?: unknown) => {
      const p = typeof patch === 'string' ? { [patch]: value } : patch
      const rows = matching()
      for (const r of rows) Object.assign(r, p)
      state.log.push({ table, op: 'update', detail: { patch: p, rows: rows.length } })
      return rows.length
    }
    q.increment = async (col: string, by = 1) => {
      const rows = matching()
      for (const r of rows) r[col] = Number(r[col] ?? 0) + by
      return rows.length
    }
    q.del = async () => {
      const gone = matching()
      state.tables[table] = rowsOf(table).filter((r) => !gone.includes(r))
      state.log.push({ table, op: 'delete', detail: { rows: gone.length } })
      return gone.length
    }
    q.delete = q.del
    q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
      state.log.push({ table, op: 'select' })
      return Promise.resolve(matching().map(project)).then(res, rej)
    }
    q.catch = (rej: (e: unknown) => unknown) => Promise.resolve(matching().map(project)).catch(rej)
    q.modify = (fn: (b: unknown) => void) => chain(() => fn(q))
    q.clone = () => q
    q.toString = () => `select * from ${table}`
    q.toSQL = () => ({ sql: `select * from ${table}`, bindings: [] })
    Object.defineProperty(q, '_filters', { get: () => filters })
    return q
  }

  const db = ((tableExpr: string) => builder(tableExpr)) as unknown as Knex & { state: TestDbState }
  const anyDb = db as unknown as Record<string, unknown>
  anyDb.state = state
  anyDb.raw = async (sql: string, bindings?: unknown) => {
    state.log.push({ table: '', op: 'raw', detail: { sql, bindings } })
    return opts.raw ? opts.raw(sql, bindings) : []
  }
  anyDb.schema = {
    hasColumn: async (t: string, c: string) => rowsOf(t).some((r) => c in r),
    hasTable: async (t: string) => t in state.tables
  }
  anyDb.transaction = async (fn: (trx: unknown) => Promise<unknown>) => fn(db)
  anyDb.fn = { now: () => new Date() }
  anyDb.batchInsert = (t: string, rows: Row[]) =>
    (builder(t).insert as (r: Row[]) => Promise<unknown>)(rows)
  anyDb.client = { config: { client: 'test', connection: { server: 'test', database: 'test' } } }
  anyDb.destroy = async () => {}
  return db
}

// ─── The context ────────────────────────────────────────────────────────────

export interface TestRoute {
  method: string
  url: string
  handler: (req: unknown, reply: unknown) => unknown
  opts: Record<string, unknown>
}

export interface TestContextOptions {
  /** A knex, or seed rows for the in-memory fake (`createTestDb`). */
  db?: Knex
  tables?: Record<string, Row[]>
  /** The acting user hooks see; defaults to an active admin-less person. */
  user?: Partial<ExtensionUser>
  /** Values `ctx.settings.get` answers. */
  settings?: Record<string, ExtensionSettingValue>
  /** What `callExternalApi` answers; default `{status: 200, body: {}}`. */
  externalApi?: (
    nameOrId: string | number,
    options?: CallOptions
  ) => CallResult | Promise<CallResult>
  /** What `mail.renderTemplate` returns; default the template name. */
  renderTemplate?: (name: string, data: Record<string, unknown>) => string
}

export interface TestContext extends ExtensionContext {
  database: Knex & { state?: TestDbState }
  user: ExtensionUser
  /** Every side effect the extension asked for, in order. */
  calls: {
    notifications: Array<{ userId: string; opts: NotifyUserOptions }>
    externalApi: Array<{ nameOrId: string | number; options?: CallOptions; result: CallResult }>
    activity: Array<Parameters<ExtensionContext['logActivity']>[0]>
    flowsEmitted: Array<{ type: string; payload: Record<string, unknown> }>
    eventsPublished: Array<{ eventType: string; payload: unknown }>
    obligationsOpened: Array<{
      ctx: ObligationTriggerContext
      trigger: ObligationTrigger
      trigger_ref: string | null
      id: number
    }>
    obligationsResolved: Array<{ id: number | null; patch: ObligationResolvePatch }>
    longSql: Array<{ sql: string; opts?: { timeoutMs?: number } }>
    log: Array<{ level: 'info' | 'warn' | 'error' | 'debug'; args: unknown[] }>
  }
  /** Everything the extension registered, by kind. */
  registered: {
    hooks: Array<{
      collection: string
      action: string
      timing: HookTiming
      fn: ExtensionHookHandler
    }>
    crons: Map<
      string,
      {
        expression: string
        fn: () => void | Promise<void>
        opts?: ExtensionCronOpts
        meta?: ExtensionCronMeta
      }
    >
    routes: TestRoute[]
    eventHandlers: Array<{ eventType: string; fn: ExtensionEventHandler }>
    bulkActions: BulkActionDef[]
    itemActions: ItemActionDef[]
    notificationChannels: NotificationChannelDef[]
    notificationSources: NotificationSourceProvider[]
    noteSources: RelatedNoteProvider[]
    machineMarkers: MachineMarkerSet[]
    dashboardWidgets: DashboardWidgetDef[]
    storage: Map<string, StorageAdapter>
    activeStorage: string | null
    fieldTypes: FieldTypeDef[]
    collectionViews: CollectionViewDef[]
    importParsers: ImportParserDef[]
    importProcessors: ImportProcessorDef[]
    validators: ValidatorDef[]
    briefLines: Array<{ collection: string; fn: BriefLineProvider }>
    digestSections: DigestSectionProvider[]
    readinessChecks: ReadinessCheck[]
    tasks: OpsTaskDef[]
    obligationKinds: ObligationKindDef[]
    signals: IntegrationSignal[]
    signalActions: SignalActionHandler[]
    eventSources: EventSourceDef[]
    integrityChecks: IntegrityCheck[]
    links: LinkRegistration[]
    mailTypes: MailTypeDef[]
    flowOps: FlowOpRegistration[]
    flowTriggers: FlowTriggerRegistration[]
    botTools: BotToolDef[]
  }
  /** Run the registered hooks for a write, as the items service would. */
  runHooks(
    collection: string,
    action: HookAction,
    timing: HookTiming,
    ctx: Partial<Omit<ExtensionHookContext, 'collection' | 'action' | 'database'>>
  ): Promise<ExtensionHookContext>
  /** Run one registered cron job by its (unscoped) id. */
  runCron(id: string): Promise<void>
  /** Run a registered operational task; its log lines come back with the outcome. */
  runTask(key: string, opts?: { execute?: boolean }): Promise<OpsTaskOutcome & { log: string[] }>
  /** Deliver an event to the registered handlers. */
  deliverEvent(eventType: string, payload: unknown): Promise<void>
  /** Call a registered route with a fake request; answers `{status, body}`. */
  invoke(
    method: string,
    url: string,
    req?: {
      params?: Row
      query?: Row
      body?: unknown
      headers?: Record<string, string>
      user?: ExtensionUser | null
    }
  ): Promise<{ status: number; body: unknown }>
}

const defaultUser: ExtensionUser = {
  id: '00000000-0000-4000-8000-000000000001',
  first_name: 'Test',
  last_name: 'Person',
  email: 'test.person@example.com',
  role: null,
  status: 'active',
  account_kind: null,
  manager_id: null,
  delegate_id: null,
  delegate_expires_at: null,
  is_out_of_office: false,
  preferences: null,
  current_workspace: null
}

function matchRoute(pattern: string, url: string): Row | null {
  const p = pattern.split('/').filter(Boolean)
  const u = url.split('?')[0].split('/').filter(Boolean)
  if (p.length !== u.length) return null
  const params: Row = {}
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) params[p[i].slice(1)] = decodeURIComponent(u[i])
    else if (p[i] !== u[i]) return null
  }
  return params
}

/** Build a context whose every effect is recorded. */
export function createTestContext(opts: TestContextOptions = {}): TestContext {
  const database = (opts.db ?? createTestDb({ tables: opts.tables })) as Knex & {
    state?: TestDbState
  }
  const user: ExtensionUser = { ...defaultUser, ...opts.user }
  const calls: TestContext['calls'] = {
    notifications: [],
    externalApi: [],
    activity: [],
    flowsEmitted: [],
    eventsPublished: [],
    obligationsOpened: [],
    obligationsResolved: [],
    longSql: [],
    log: []
  }
  const registered: TestContext['registered'] = {
    hooks: [],
    crons: new Map(),
    routes: [],
    eventHandlers: [],
    bulkActions: [],
    itemActions: [],
    notificationChannels: [],
    notificationSources: [],
    noteSources: [],
    machineMarkers: [],
    dashboardWidgets: [],
    storage: new Map(),
    activeStorage: null,
    fieldTypes: [],
    collectionViews: [],
    importParsers: [],
    importProcessors: [],
    validators: [],
    briefLines: [],
    digestSections: [],
    readinessChecks: [],
    tasks: [],
    obligationKinds: [],
    signals: [],
    signalActions: [],
    eventSources: [],
    integrityChecks: [],
    links: [],
    mailTypes: [],
    flowOps: [],
    flowTriggers: [],
    botTools: []
  }
  let nextObligation = 1
  const logAt =
    (level: 'info' | 'warn' | 'error' | 'debug') =>
    (...args: unknown[]) => {
      calls.log.push({ level, args })
    }
  const logger = {
    info: logAt('info'),
    warn: logAt('warn'),
    error: logAt('error'),
    debug: logAt('debug'),
    trace: logAt('debug'),
    fatal: logAt('error'),
    child: () => logger
  }

  // A route-recording stand-in for the Fastify instance.
  const routeMethod = (method: string) => (url: string, a: unknown, b?: unknown) => {
    const handler = (typeof a === 'function' ? a : b) as TestRoute['handler']
    const routeOpts = (typeof a === 'function' ? {} : a) as Record<string, unknown>
    registered.routes.push({ method, url: `${prefix}${url}`, handler, opts: routeOpts })
    return app
  }
  let prefix = ''
  const app: Record<string, unknown> = {
    log: logger,
    get: routeMethod('GET'),
    post: routeMethod('POST'),
    put: routeMethod('PUT'),
    patch: routeMethod('PATCH'),
    delete: routeMethod('DELETE'),
    route: (r: { method: string; url: string; handler: TestRoute['handler'] }) => {
      registered.routes.push({
        method: r.method,
        url: `${prefix}${r.url}`,
        handler: r.handler,
        opts: r as Record<string, unknown>
      })
      return app
    },
    addHook: () => app,
    decorate: (k: string, v: unknown) => {
      app[k] = v
      return app
    },
    register: async (plugin: (a: unknown, o: unknown) => unknown, o: { prefix?: string } = {}) => {
      const outer = prefix
      prefix = `${outer}${o.prefix ?? ''}`
      try {
        await plugin(app, o)
      } finally {
        prefix = outer
      }
      return app
    },
    inject: async () => {
      throw new Error(
        'app.inject is not available in the test context — call ctx.invoke() for a route the extension registered, or stub it'
      )
    },
    cron: {
      list: () =>
        [...registered.crons.entries()].map(([id, c]) => ({
          id,
          expression: c.expression,
          defaultExpression: c.expression,
          overridden: false,
          nextRun: null,
          ...c.meta
        })),
      pause: () => {},
      resume: () => {}
    },
    io: { to: () => ({ emit: () => {} }), emit: () => {} }
  }

  const ctx: TestContext = {
    app: app as unknown as ExtensionApp,
    database,
    inngest: {} as ExtensionContext['inngest'],
    logger: logger as unknown as ExtensionContext['logger'],
    user,
    calls,
    registered,
    settings: {
      get: async (key) => opts.settings?.[key] ?? null,
      getAll: async () => ({ ...(opts.settings ?? {}) })
    },
    events: {
      publish: async (eventType, payload) => {
        calls.eventsPublished.push({ eventType, payload })
        return calls.eventsPublished.length
      },
      on: (eventType, fn) => {
        registered.eventHandlers.push({ eventType, fn })
      }
    },
    callExternalApi: async (nameOrId, options) => {
      const result = opts.externalApi
        ? await opts.externalApi(nameOrId, options)
        : { status: 200, headers: {}, body: {} }
      calls.externalApi.push({ nameOrId, options, result })
      return result
    },
    sql: {
      runLong: async (sql, o) => {
        calls.longSql.push({ sql, opts: o })
        return []
      }
    },
    logActivity: async (entry) => {
      calls.activity.push(entry)
      return calls.activity.length
    },
    notifyUser: async (userId, o) => {
      calls.notifications.push({ userId, opts: o })
    },
    hooks: {
      before: (collection, action, fn) =>
        registered.hooks.push({ collection, action, timing: 'before', fn }),
      after: (collection, action, fn) =>
        registered.hooks.push({ collection, action, timing: 'after', fn })
    },
    cron: {
      schedule: (id, expression, fn, o) => registered.crons.set(id, { expression, fn, opts: o }),
      unschedule: (id) => registered.crons.delete(id),
      annotate: (id, meta) => {
        const c = registered.crons.get(id)
        if (c) c.meta = { ...c.meta, ...meta }
      }
    },
    bulkActions: { register: (d) => registered.bulkActions.push(d) },
    itemActions: { register: (d) => registered.itemActions.push(d) },
    notificationChannels: { register: (d) => registered.notificationChannels.push(d) },
    notificationSources: { register: (p) => registered.notificationSources.push(p) },
    notes: {
      registerSource: (p) => registered.noteSources.push(p),
      registerMachineMarkers: (s) => registered.machineMarkers.push(s)
    },
    dashboardWidgets: { register: (d) => registered.dashboardWidgets.push(d) },
    storage: {
      register: (name, adapter) => registered.storage.set(name, adapter),
      setActive: (name) => {
        registered.activeStorage = name
      }
    },
    fieldTypes: { register: (d) => registered.fieldTypes.push(d) },
    collectionViews: { register: (d) => registered.collectionViews.push(d) },
    importParsers: { register: (d) => registered.importParsers.push(d) },
    importProcessors: { register: (d) => registered.importProcessors.push(d) },
    validators: { register: (d) => registered.validators.push(d) },
    approvalBrief: {
      registerLine: (collection, fn) => registered.briefLines.push({ collection, fn })
    },
    digest: { registerSection: (fn) => registered.digestSections.push(fn) },
    readiness: { registerCheck: (c) => registered.readinessChecks.push(c) },
    tasks: { register: (d) => registered.tasks.push(d) },
    chain: {
      begin: async (_root, fn) => fn(),
      current: () => null,
      fields: async () => ({})
    },
    integrations: {
      registerObligationKind: (d) => registered.obligationKinds.push(d),
      openObligation: async (octx, o) => {
        const id = nextObligation++
        calls.obligationsOpened.push({
          ctx: octx,
          trigger: o.trigger,
          trigger_ref: o.trigger_ref ?? null,
          id
        })
        return id
      },
      resolveObligation: async (id, patch) => {
        calls.obligationsResolved.push({ id, patch })
      },
      registerSignal: (d) => registered.signals.push(d),
      registerSignalAction: (d) => registered.signalActions.push(d),
      registerEventSource: (d) => registered.eventSources.push(d)
    },
    integrity: { registerCheck: (c) => registered.integrityChecks.push(c) },
    links: { register: (r) => registered.links.push(r) },
    mail: {
      registerType: (d) => registered.mailTypes.push(d),
      renderViaFlow: async () => null,
      renderTemplate: async (name, data) =>
        opts.renderTemplate ? opts.renderTemplate(name, data) : name
    },
    flows: {
      registerOperation: (op) => registered.flowOps.push(op),
      registerTrigger: (t) => registered.flowTriggers.push(t),
      emit: (type, payload) => {
        calls.flowsEmitted.push({ type, payload })
      }
    },
    chatBot: { registerTool: (d) => registered.botTools.push(d) },
    auth: {
      authenticate: async () => {},
      requireAuth: async () => {},
      requireAdmin: async () => {}
    },
    async runHooks(collection, action, timing, partial) {
      const hctx: ExtensionHookContext = { collection, action, user, database, ...partial }
      for (const h of registered.hooks) {
        if (h.timing !== timing) continue
        if (h.collection !== '*' && h.collection !== collection) continue
        if (h.action !== '*' && h.action !== action) continue
        await h.fn(hctx)
      }
      return hctx
    },
    async runCron(id) {
      const c = registered.crons.get(id)
      if (!c)
        throw new Error(
          `no cron '${id}' registered (have: ${[...registered.crons.keys()].join(', ') || 'none'})`
        )
      await c.fn()
    },
    async runTask(key, o = {}) {
      const def = registered.tasks.find((t) => t.key === key)
      if (!def)
        throw new Error(
          `no task '${key}' registered (have: ${registered.tasks.map((t) => t.key).join(', ') || 'none'})`
        )
      const log: string[] = []
      const rctx = {
        log: (line: string) => {
          log.push(line)
        },
        progress: () => {},
        cancelled: () => false,
        userId: user.id,
        dryRun: !o.execute
      }
      if (!o.execute && !def.dryRun)
        throw new Error(`task '${key}' has no dry run — pass {execute: true}`)
      const out = o.execute ? await def.execute(rctx) : await def.dryRun!(rctx)
      return { ...out, log }
    },
    async deliverEvent(eventType, payload) {
      let id = 0
      for (const h of registered.eventHandlers) {
        if (h.eventType !== '*' && h.eventType !== eventType) continue
        await h.fn({ id: ++id, extension: 'test', event_type: eventType, payload })
      }
    },
    async invoke(method, url, req = {}) {
      const m = method.toUpperCase()
      for (const r of registered.routes) {
        if (r.method !== m) continue
        const params = matchRoute(r.url, url)
        if (!params) continue
        const query: Row = { ...(req.query ?? {}) }
        const qs = url.split('?')[1]
        if (qs) for (const [k, v] of new URLSearchParams(qs)) query[k] = v
        let status = 200
        let sent: unknown
        const reply = {
          code: (n: number) => {
            status = n
            return reply
          },
          status: (n: number) => {
            status = n
            return reply
          },
          send: (b: unknown) => {
            sent = b
            return reply
          },
          header: () => reply,
          type: () => reply
        }
        const fakeReq = {
          params: { ...params, ...(req.params ?? {}) },
          query,
          body: req.body,
          headers: req.headers ?? {},
          user: req.user === undefined ? user : req.user,
          isAdmin: false,
          log: logger,
          server: app
        }
        const pre = ([] as unknown[]).concat(
          (r.opts.preHandler as unknown[]) ?? [],
          (r.opts.onRequest as unknown[]) ?? []
        )
        for (const fn of pre)
          await (fn as (q: unknown, p: unknown) => Promise<void>)(fakeReq, reply)
        const out = await r.handler(fakeReq, reply)
        return { status, body: sent !== undefined ? sent : out }
      }
      throw new Error(
        `no route ${m} ${url} registered (have: ${registered.routes.map((r) => `${r.method} ${r.url}`).join(', ') || 'none'})`
      )
    }
  }
  return ctx
}
