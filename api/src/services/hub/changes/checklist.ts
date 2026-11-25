import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'

/**
 * Pre-deploy checklists (Hub enhancement 28). An app has checklist items (text, required, who may
 * tick, which actions; environment_id null = every PRODUCTION environment of the app — THE
 * production rule, owner-access envPolicy). A production promote, move or shared-deployment
 * upgrade cannot start until every required item that applies is ticked FOR THAT RUN:
 *
 *   - a checklist run (nivaro_hub_checklist_runs) is one checklist for one intended start — the
 *     environment (or the shared deployment), the action and the version — with its ticks (who,
 *     when, note) keyed `<item id>@<environment id>`;
 *   - the start sends its id (`checklist_run_id`); checklistGate checks it fits, that every
 *     required item is ticked, then CLAIMS it (status used, compare-and-set) so one checklist
 *     starts one run; the claim is linked to the run it started (deploy, move, shared deploy) or
 *     given back when the start fails, so the person can try again without ticking again;
 *   - an unattended start (a scheduled promotion, a release-train step) names its source instead:
 *     the gate opens a checklist for it once, tells the people who may tick it, and the runner
 *     waits until it is ticked (a schedule is still missed 6 hours after it was due).
 * Rollbacks and Apply now never need one: going back must never wait on a list.
 * Items stored at claim time are what the run was attested against.
 */

export const ITEMS = 'nivaro_hub_checklist_items'
export const RUNS = 'nivaro_hub_checklist_runs'

/**
 * config_promote / extension_promote: the seam for hub-enh/config and hub-enh/verify — their
 * starts call checklistGate (or startWithChecklist) with these actions; items opt in to them.
 */
export type ChecklistAction =
  | 'promote'
  | 'move'
  | 'upgrade'
  | 'config_promote'
  | 'extension_promote'
export const ACTIONS: readonly ChecklistAction[] = [
  'promote',
  'move',
  'upgrade',
  'config_promote',
  'extension_promote'
]
/** The actions a new item covers when none are named (the later ones opt in). */
export const DEFAULT_ACTIONS: readonly ChecklistAction[] = ['promote', 'move', 'upgrade']
export type TickBy = 'admin' | 'owner' | 'people'

export interface ChecklistItem {
  id: number
  app_id: number
  environment_id: number | null
  text: string
  help: string | null
  required: boolean
  tick_by: TickBy
  tick_people: string[]
  actions: ChecklistAction[]
  position: number
  archived: boolean
}

export type ChecklistTarget =
  | { kind: 'environment'; envId: number }
  | { kind: 'shared'; sharedId: number }

/** One item as it applies to one production environment of the target. */
export interface ChecklistEntry {
  key: string
  item_id: number
  app_id: number
  app_key: string
  environment_id: number
  env_key: string
  text: string
  help: string | null
  required: boolean
  tick_by: TickBy
  tick_people: string[]
}

export interface ChecklistTick {
  by: string
  by_name: string | null
  at: string
  note: string | null
}

export type RunStatus = 'open' | 'used' | 'void'
export type RunSource = 'person' | 'schedule' | 'train'

export interface ChecklistRun {
  id: number
  target_kind: 'environment' | 'shared'
  target_id: number
  action: ChecklistAction
  version: string | null
  status: RunStatus
  items: ChecklistEntry[]
  ticks: Record<string, ChecklistTick>
  source: RunSource
  source_id: number | null
  source_step: number | null
  run_kind: string | null
  run_id: number | null
  rev: number
  created_by: string | null
  created_at: string | null
  used_at: string | null
}

const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'
const iso = (v: unknown): string | null => {
  if (v == null || v === '') return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}
function json<T>(v: unknown, fallback: T): T {
  if (v == null || v === '') return fallback
  try {
    return (typeof v === 'string' ? JSON.parse(v) : v) as T
  } catch {
    return fallback
  }
}

export function itemFromRow(r: Record<string, unknown>): ChecklistItem {
  const tickBy = r.tick_by === 'admin' || r.tick_by === 'people' ? r.tick_by : 'owner'
  const people = json<unknown[]>(r.tick_people, [])
  const actions = String(r.actions ?? 'promote,move,upgrade')
    .split(',')
    .map((a) => a.trim())
    .filter((a): a is ChecklistAction => (ACTIONS as readonly string[]).includes(a))
  return {
    id: Number(r.id),
    app_id: Number(r.app_id),
    environment_id: r.environment_id == null ? null : Number(r.environment_id),
    text: String(r.text ?? ''),
    help: r.help == null || r.help === '' ? null : String(r.help),
    required: r.required == null ? true : truthy(r.required),
    tick_by: tickBy,
    tick_people: Array.isArray(people) ? people.map(String).filter(Boolean) : [],
    actions,
    position: Number(r.position ?? 0),
    archived: r.archived_at != null
  }
}

export function runFromRow(r: Record<string, unknown>): ChecklistRun {
  const ticks = json<Record<string, ChecklistTick>>(r.ticks, {})
  return {
    id: Number(r.id),
    target_kind: r.target_kind === 'shared' ? 'shared' : 'environment',
    target_id: Number(r.target_id),
    action: (ACTIONS as readonly string[]).includes(String(r.action))
      ? (r.action as ChecklistAction)
      : 'promote',
    version: r.version == null || r.version === '' ? null : String(r.version),
    status: r.status === 'used' || r.status === 'void' ? r.status : 'open',
    items: json<ChecklistEntry[]>(r.items, []),
    ticks: ticks && typeof ticks === 'object' && !Array.isArray(ticks) ? ticks : {},
    source: r.source === 'schedule' || r.source === 'train' ? r.source : 'person',
    source_id: r.source_id == null ? null : Number(r.source_id),
    source_step: r.source_step == null ? null : Number(r.source_step),
    run_kind: r.run_kind == null ? null : String(r.run_kind),
    run_id: r.run_id == null ? null : Number(r.run_id),
    rev: Number(r.rev ?? 0),
    created_by: r.created_by == null ? null : String(r.created_by),
    created_at: iso(r.created_at),
    used_at: iso(r.used_at)
  }
}

const UUIDISH = /^[0-9a-f-]{8,64}$/i

export interface ItemInput {
  app_id: number
  environment_id: number | null
  text: string
  help: string | null
  required: boolean
  tick_by: TickBy
  tick_people: string | null
  actions: string
  position: number
}

/** Validates an item body (the app and environment are checked by the route). */
export function validateItem(b: Record<string, unknown>): ItemInput | { error: string } {
  const appId = Number(b.app_id)
  if (!Number.isSafeInteger(appId) || appId <= 0) return { error: 'app_id names the app' }
  let envId: number | null = null
  if (b.environment_id != null && b.environment_id !== '') {
    const n = Number(b.environment_id)
    if (!Number.isSafeInteger(n) || n <= 0)
      return { error: 'environment_id is an environment id or null (every production one)' }
    envId = n
  }
  const text = typeof b.text === 'string' ? b.text.trim() : ''
  if (!text || text.length > 500) return { error: 'text is required (at most 500 characters)' }
  const help = typeof b.help === 'string' && b.help.trim() ? b.help.trim() : null
  if (help && help.length > 1000) return { error: 'help is at most 1000 characters' }
  const tickBy =
    b.tick_by == null || b.tick_by === 'owner'
      ? 'owner'
      : b.tick_by === 'admin' || b.tick_by === 'people'
        ? b.tick_by
        : null
  if (!tickBy) return { error: 'tick_by is admin, owner or people' }
  let people: string[] = []
  if (tickBy === 'people') {
    people = Array.isArray(b.tick_people) ? b.tick_people.map(String) : []
    people = [...new Set(people.map((p) => p.trim()).filter(Boolean))]
    if (!people.length) return { error: 'name at least one person who may tick it' }
    if (people.length > 20) return { error: 'at most 20 people' }
    if (people.some((p) => !UUIDISH.test(p))) return { error: 'tick_people are user ids' }
  }
  const actions = Array.isArray(b.actions) ? b.actions.map(String) : [...DEFAULT_ACTIONS]
  const clean = ACTIONS.filter((a) => actions.includes(a))
  if (!clean.length)
    return {
      error: 'actions has at least one of promote, move, upgrade, config_promote, extension_promote'
    }
  const position = b.position == null ? 0 : Number(b.position)
  if (!Number.isInteger(position) || position < 0 || position > 10_000)
    return { error: 'position is 0 to 10000' }
  return {
    app_id: appId,
    environment_id: envId,
    text,
    help,
    required: b.required == null ? true : truthy(b.required),
    tick_by: tickBy,
    tick_people: tickBy === 'people' ? JSON.stringify(people) : null,
    actions: clean.join(','),
    position
  }
}

export interface Ticker {
  id: string
  isAdmin: boolean
  /** The apps the person owns. */
  owns: Set<number>
}

/** Whether `who` may tick (or untick) `entry` (pure). */
export function mayTick(
  entry: Pick<ChecklistEntry, 'tick_by' | 'tick_people' | 'app_id'>,
  who: Ticker
): boolean {
  if (entry.tick_by === 'admin') return who.isAdmin
  if (entry.tick_by === 'owner') return who.isAdmin || who.owns.has(entry.app_id)
  const me = who.id.toLowerCase()
  return entry.tick_people.some((p) => p.toLowerCase() === me)
}

/** The required entries not ticked (pure). */
export function missingRequired(
  entries: ChecklistEntry[],
  ticks: Record<string, ChecklistTick>
): ChecklistEntry[] {
  return entries.filter((e) => e.required && !ticks[e.key])
}

export interface ProdEnv {
  env_id: number
  env_key: string
  app_id: number
  app_key: string
}

/** Production per THE rule; an unreadable answer counts as production (fails closed). */
async function isProduction(envId: number): Promise<boolean> {
  try {
    const { envPolicy } = await import('../owner-access.js')
    return (await envPolicy(envId))?.production ?? true
  } catch {
    return true
  }
}

/** The production environments a start reaches. */
export async function productionEnvsOf(target: ChecklistTarget): Promise<ProdEnv[]> {
  const q = db('nivaro_hub_environments as e')
    .join('nivaro_hub_apps as a', 'a.id', 'e.app_id')
    .select('e.id as env_id', 'e.key as env_key', 'a.id as app_id', 'a.key as app_key')
  if (target.kind === 'environment') q.where('e.id', target.envId)
  else
    q.join('nivaro_hub_placements as p', 'p.id', 'e.placement_id').where(
      'p.shared_deployment_id',
      target.sharedId
    )
  const rows = (await q) as Array<Record<string, unknown>>
  const out: ProdEnv[] = []
  for (const r of rows) {
    if (!(await isProduction(Number(r.env_id)))) continue
    out.push({
      env_id: Number(r.env_id),
      env_key: String(r.env_key),
      app_id: Number(r.app_id),
      app_key: String(r.app_key)
    })
  }
  return out.sort((a, b) => a.app_key.localeCompare(b.app_key) || a.env_id - b.env_id)
}

export async function listItems(o: { appIds?: number[]; archived?: boolean } = {}) {
  const q = db(ITEMS).orderBy([
    { column: 'app_id', order: 'asc' },
    { column: 'position', order: 'asc' },
    { column: 'id', order: 'asc' }
  ])
  if (!o.archived) q.whereNull('archived_at')
  if (o.appIds) q.whereIn('app_id', o.appIds.length ? o.appIds : [-1])
  return ((await q.select('*')) as Array<Record<string, unknown>>).map(itemFromRow)
}

/** The entries that apply to a start now (pure over the inputs). */
export function entriesFor(
  items: ChecklistItem[],
  envs: ProdEnv[],
  action: ChecklistAction
): ChecklistEntry[] {
  const out: ChecklistEntry[] = []
  for (const env of envs)
    for (const it of items) {
      if (it.archived || it.app_id !== env.app_id || !it.actions.includes(action)) continue
      if (it.environment_id != null && it.environment_id !== env.env_id) continue
      out.push({
        key: `${it.id}@${env.env_id}`,
        item_id: it.id,
        app_id: env.app_id,
        app_key: env.app_key,
        environment_id: env.env_id,
        env_key: env.env_key,
        text: it.text,
        help: it.help,
        required: it.required,
        tick_by: it.tick_by,
        tick_people: it.tick_people
      })
    }
  return out
}

async function tablesMissing(): Promise<boolean> {
  try {
    return !(await db.schema.hasTable(ITEMS)) || !(await db.schema.hasTable(RUNS))
  } catch {
    return false
  }
}

/** The checklist a start of `action` on `target` needs now (empty = none). */
export async function checklistFor(
  target: ChecklistTarget,
  action: ChecklistAction
): Promise<{ entries: ChecklistEntry[]; production: ProdEnv[] }> {
  const production = await productionEnvsOf(target)
  if (!production.length) return { entries: [], production }
  const items = await listItems({ appIds: [...new Set(production.map((p) => p.app_id))] })
  return { entries: entriesFor(items, production, action), production }
}

export async function readRun(id: number): Promise<ChecklistRun | null> {
  const r = (await db(RUNS).where({ id }).first()) as Record<string, unknown> | undefined
  return r ? runFromRow(r) : null
}

const targetCols = (t: ChecklistTarget) =>
  t.kind === 'environment'
    ? { target_kind: 'environment', target_id: t.envId }
    : { target_kind: 'shared', target_id: t.sharedId }

/** The open checklist for this start (the newest), if any. */
export async function findOpenRun(
  target: ChecklistTarget,
  action: ChecklistAction,
  version: string | null,
  source?: { kind: 'schedule' | 'train'; id: number; step?: number | null }
): Promise<ChecklistRun | null> {
  const q = db(RUNS)
    .where({ ...targetCols(target), action, status: 'open' })
    .orderBy('id', 'desc')
  if (version == null) q.whereNull('version')
  else q.where({ version })
  if (source) {
    q.where({ source: source.kind, source_id: source.id })
    if (source.step != null) q.where({ source_step: source.step })
  } else q.where({ source: 'person' })
  const r = (await q.first()) as Record<string, unknown> | undefined
  return r ? runFromRow(r) : null
}

/** Opens a checklist for a start (its items as they are now). */
export async function createRun(o: {
  target: ChecklistTarget
  action: ChecklistAction
  version: string | null
  source?: { kind: 'schedule' | 'train'; id: number; step?: number | null }
  userId: string | null
  entries?: ChecklistEntry[]
}): Promise<ChecklistRun> {
  const entries = o.entries ?? (await checklistFor(o.target, o.action)).entries
  const id = Number(
    await insertReturningId(db, RUNS, {
      ...targetCols(o.target),
      action: o.action,
      version: o.version,
      status: 'open',
      items: JSON.stringify(entries),
      ticks: JSON.stringify({}),
      source: o.source?.kind ?? 'person',
      source_id: o.source?.id ?? null,
      source_step: o.source?.step ?? null,
      rev: 0,
      created_by: o.userId,
      created_at: new Date(),
      updated_at: new Date()
    })
  )
  return (await readRun(id)) as ChecklistRun
}

export class ChecklistError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 409,
    public extra: Record<string, unknown> = {}
  ) {
    super(message)
  }
}

/**
 * Ticks or unticks one entry of an open checklist. Only someone the item allows; compare-and-set
 * on `rev` (retried a few times) so two people ticking at once never lose one.
 */
export async function tickRun(
  runId: number,
  o: { key: string; ticked: boolean; note: string | null; who: Ticker; whoName: string | null },
  now = Date.now()
): Promise<ChecklistRun> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const run = await readRun(runId)
    if (!run) throw new ChecklistError('NOT_FOUND', 'No such checklist.', 404)
    if (run.status !== 'open')
      throw new ChecklistError(
        'CHECKLIST_CLOSED',
        run.status === 'used'
          ? 'This checklist was already used for a run; open a new one for the next start.'
          : 'This checklist was set aside.'
      )
    // The entry must apply now (the checklist shows today's items while it is open).
    const target: ChecklistTarget =
      run.target_kind === 'shared'
        ? { kind: 'shared', sharedId: run.target_id }
        : { kind: 'environment', envId: run.target_id }
    const { entries } = await checklistFor(target, run.action)
    const entry = entries.find((e) => e.key === o.key)
    if (!entry) throw new ChecklistError('NOT_FOUND', 'That item is not on this checklist.', 404)
    if (!mayTick(entry, o.who))
      throw new ChecklistError(
        'NOT_YOURS_TO_TICK',
        entry.tick_by === 'admin'
          ? 'Only a Hub administrator may tick this item.'
          : entry.tick_by === 'owner'
            ? 'Only a Hub administrator or an owner of this app may tick this item.'
            : 'Only the people named on this item may tick it.',
        403
      )
    const ticks = { ...run.ticks }
    if (o.ticked)
      ticks[o.key] = {
        by: o.who.id,
        by_name: o.whoName,
        at: new Date(now).toISOString(),
        note: o.note ? o.note.slice(0, 500) : null
      }
    else delete ticks[o.key]
    const n = await db(RUNS)
      .where({ id: runId, rev: run.rev, status: 'open' })
      .update({
        ticks: JSON.stringify(ticks),
        items: JSON.stringify(entries),
        rev: run.rev + 1,
        updated_at: new Date(now)
      })
    if (n) return (await readRun(runId)) as ChecklistRun
  }
  throw new ChecklistError('BUSY', 'Several people are ticking this list — try again.', 409)
}

/** A person sets an open checklist aside (a different version, a change of plan). */
export async function voidRun(runId: number): Promise<boolean> {
  return (
    (await db(RUNS)
      .where({ id: runId, status: 'open' })
      .update({ status: 'void', updated_at: new Date() })) > 0
  )
}

export interface ChecklistClaim {
  runId: number
  /** The run the checklist started (`deploy`, `move`, `shared_deploy`, `extension` = nivaro_hub_extension_promotions, `config` = nivaro_hub_config_promotions). */
  link(
    kind: 'deploy' | 'move' | 'shared_deploy' | 'extension' | 'config',
    id: number
  ): Promise<void>
  /** The start failed: the checklist is open again (ticks kept). */
  release(): Promise<void>
}

export interface GateInput {
  target: ChecklistTarget
  action: ChecklistAction
  version: string | null
  /** The checklist a person ticked (`checklist_run_id`). */
  runId?: unknown
  /** An unattended start names itself; its checklist is opened once and waited for. */
  source?: { kind: 'schedule' | 'train'; id: number; step?: number | null }
  /** Told once when a checklist is opened for an unattended start. */
  onOpened?: (run: ChecklistRun, entries: ChecklistEntry[]) => Promise<unknown>
  now?: number
}

const sentence = (entries: ChecklistEntry[]) =>
  entries
    .slice(0, 5)
    .map((e) => `“${e.text}”${e.env_key ? ` (${e.app_key} · ${e.env_key})` : ''}`)
    .join(', ') + (entries.length > 5 ? ` and ${entries.length - 5} more` : '')

/**
 * The gate a production start passes: null claim = no checklist applies; otherwise the claimed
 * checklist (link it to the run, or release it when the start fails). Throws ChecklistError:
 * CHECKLIST_REQUIRED (no checklist sent / opened), CHECKLIST_MISMATCH (for another start),
 * CHECKLIST_INCOMPLETE (required items not ticked), CHECKLIST_USED (already started a run),
 * CHECKLIST_UNKNOWN (503: could not be read — fails closed; runners wait).
 */
export async function checklistGate(o: GateInput): Promise<ChecklistClaim | null> {
  let entries: ChecklistEntry[]
  try {
    entries = (await checklistFor(o.target, o.action)).entries
  } catch {
    if (await tablesMissing()) return null
    throw new ChecklistError(
      'CHECKLIST_UNKNOWN',
      'The Hub could not read the pre-deploy checklist — try again shortly.',
      503
    )
  }
  const required = entries.filter((e) => e.required)
  if (!required.length) return null
  const verb = o.action === 'move' ? 'move' : o.action === 'upgrade' ? 'upgrade' : 'promotion'

  let run: ChecklistRun | null = null
  const asked = o.runId == null || o.runId === '' ? null : Number(o.runId)
  if (asked != null && Number.isSafeInteger(asked) && asked > 0) run = await readRun(asked)
  else if (o.source) {
    run = await findOpenRun(o.target, o.action, o.version, o.source)
    if (!run) {
      run = await createRun({
        target: o.target,
        action: o.action,
        version: o.version,
        source: o.source,
        userId: null,
        entries
      })
      if (o.onOpened) await Promise.resolve(o.onOpened(run, entries)).catch(() => undefined)
    }
  }
  if (!run)
    throw new ChecklistError(
      'CHECKLIST_REQUIRED',
      `This production ${verb} needs its pre-deploy checklist ticked first: ${sentence(required)}.`,
      409,
      { checklist: required.map((e) => ({ key: e.key, text: e.text })) }
    )
  const fits =
    run.target_kind === targetCols(o.target).target_kind &&
    run.target_id === targetCols(o.target).target_id &&
    run.action === o.action &&
    (run.version ?? null) === (o.version ?? null)
  if (!fits)
    throw new ChecklistError(
      'CHECKLIST_MISMATCH',
      `That checklist was ticked for another start${run.version ? ` (${run.version})` : ''}: tick the one for this ${verb}.`
    )
  if (run.status === 'used')
    throw new ChecklistError(
      'CHECKLIST_USED',
      'That checklist already started a run; tick a new one for this start.'
    )
  if (run.status === 'void')
    throw new ChecklistError('CHECKLIST_REQUIRED', 'That checklist was set aside; tick a new one.')
  const missing = missingRequired(entries, run.ticks)
  if (missing.length)
    throw new ChecklistError(
      'CHECKLIST_INCOMPLETE',
      `Tick the required checklist items first: ${sentence(missing)}.`,
      409,
      { checklist_run_id: run.id, missing: missing.map((e) => ({ key: e.key, text: e.text })) }
    )
  const now = new Date(o.now ?? Date.now())
  const claimed = await db(RUNS)
    .where({ id: run.id, status: 'open', rev: run.rev })
    .update({
      status: 'used',
      claimed_at: now,
      items: JSON.stringify(entries),
      rev: run.rev + 1,
      updated_at: now
    })
  if (!claimed)
    throw new ChecklistError(
      'CHECKLIST_USED',
      'That checklist changed or started another run a moment ago — check it again.'
    )
  const id = run.id
  return {
    runId: id,
    link: async (kind, runId) => {
      await db(RUNS)
        .where({ id })
        .update({ run_kind: kind, run_id: runId, used_at: new Date(), updated_at: new Date() })
    },
    release: async () => {
      await db(RUNS)
        .where({ id, status: 'used' })
        .whereNull('run_id')
        .update({ status: 'open', claimed_at: null, updated_at: new Date() })
    }
  }
}

/** Whether a refusal code is a checklist wait (runners hold, never fail). */
export function isChecklistWait(code: string): boolean {
  return (
    code === 'CHECKLIST_REQUIRED' ||
    code === 'CHECKLIST_INCOMPLETE' ||
    code === 'CHECKLIST_USED' ||
    code === 'CHECKLIST_UNKNOWN'
  )
}

/** The checklist a run was started with (its history row's "Checklist"). */
export async function checklistOfRun(
  kind: 'deploy' | 'move' | 'shared_deploy' | 'extension' | 'config',
  id: number
): Promise<ChecklistRun | null> {
  const r = (await db(RUNS).where({ run_kind: kind, run_id: id }).first()) as
    | Record<string, unknown>
    | undefined
  return r ? runFromRow(r) : null
}

/**
 * A route's start under the gate: the checklist is claimed first, linked to the run the start
 * answers, and given back when the start throws. A checklist refusal is thrown as a
 * PromotionError (the Hub routes answer it as 409 / 503 with its code).
 */
export async function startWithChecklist<T>(
  gate: GateInput,
  kind: 'deploy' | 'move' | 'shared_deploy' | 'extension' | 'config',
  start: () => Promise<T>,
  idOf: (out: T) => number
): Promise<T> {
  let claim: ChecklistClaim | null
  try {
    claim = await checklistGate(gate)
  } catch (err) {
    if (err instanceof ChecklistError) {
      const { PromotionError } = await import('../promote-lock.js')
      throw new PromotionError(err.code, err.message, err.status)
    }
    throw err
  }
  try {
    const out = await start()
    if (claim) await claim.link(kind, idOf(out)).catch(() => undefined)
    return out
  } catch (err) {
    await claim?.release().catch(() => undefined)
    throw err
  }
}
