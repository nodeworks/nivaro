import { describeError, type ErrorDescription, errorToastOptions } from '@nivaro/shared'
import { type DataTag, useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { BLOCKER_COPY, fetchDrivers, type HubDriver, hubError, hubKeys } from '../hub-api'
import { fetchSharedList, type SharedListRow, sharedKeys } from '../shared/shared-api'

/**
 * Nivaro Hub (phase 6) — every call the move panel, the place-on-shared form and the app key
 * field make, in one module. The move routes (Tasks 15/16) are built beside this screen; their
 * shapes here are the plan's, so wiring them at merge is a change to this file only.
 *
 * Never kept or shown here: an app key (only its mask and fingerprint), a deployment token, a
 * transfer ticket or a database connection.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type MoveKind = 'to_shared' | 'to_dedicated' | 'between_shared'
export type MoveRouting = 'automatic' | 'manual'

/** Where a move goes: a shared deployment, or a dedicated placement of this environment. */
export type MoveTarget =
  | { kind: 'shared'; shared_id: number; pool_max?: number }
  | { kind: 'dedicated'; placement_id: number }

export interface MoveRouteAction {
  side: 'source' | 'target'
  op: 'drop_host' | 'add_host' | 'remove_stack' | 'apply_stack'
  host?: string
}

export interface MoveIssue {
  code: string
  text: string
}

export interface MoveChecklistItem {
  id: string
  text: string
  required: boolean
}

/** The plan `POST /hub/environments/:envId/move/plan` answers (Task 15 `MovePlan`). */
export interface MovePlan {
  kind: MoveKind
  routing: MoveRouting
  steps: string[]
  route: MoveRouteAction[]
  manual_request: string | null
  version: string
  hostnames: string[]
  /** count = files a move copies (local ones); bytes = every file's size. */
  files: { count: number; bytes: number; first_pull?: 'full' }
  blockers: MoveIssue[]
  warnings: MoveIssue[]
  checklist: MoveChecklistItem[]
  plan_hash: string
}

export type MoveStatus =
  | 'planned'
  | 'running'
  | 'waiting'
  | 'interrupted'
  | 'success'
  | 'failed'
  | 'rolled_back'
  | 'cancelled'

/** File copy progress (the target's pull status, Task 10). */
export interface MoveFiles {
  state?: 'running' | 'done' | 'failed'
  total?: number
  copied?: number
  skipped?: number
  failed?: number
  bytes?: number
  error?: string | null
}

/** One move (`nivaro_hub_moves`, migration 553) as `GET /hub/moves/:id` answers it. */
export interface HubMove {
  id: number
  app_id: number
  environment_id: number
  from_placement_id: number
  to_placement_id: number
  kind: MoveKind
  routing: MoveRouting
  status: MoveStatus | string
  /** The step the runner is on (or stopped on). */
  step: string | null
  /** `{list: [{key, state}], phase}` (Task 16), or a plain list of keys / `{key, status}` rows. */
  steps: unknown
  plan: MovePlan | string | null
  plan_hash?: string | null
  /** Per-copy summaries `{warm?, delta?, full?}` (Task 16), or one pull status. */
  files: MoveFiles | Record<string, unknown> | string | null
  /** Checklist state: `{id: done}` or `[{id, text, required, done}]` (stored as JSON text). */
  checklist: unknown
  error: string | null
  placed_at?: string | null
  job_run_id?: number | null
  started_by?: string | null
  started_by_name?: string | null
  started_at: string | null
  finished_at: string | null
  heartbeat_at?: string | null
}

/** Shared deployment list row (`GET /hub/shared`): Task 17's type, one owner for the shape. */
export type SharedDeploymentRow = SharedListRow

/** A placement (`GET /hub/placements/:id`): dedicated on a driver, or on a shared deployment. */
export type HubPlacement =
  | {
      id: number
      kind: 'dedicated'
      driver_id: number
      target: { branch?: string; stack?: string; forgotten_at?: string }
    }
  | {
      id: number
      kind: 'shared'
      shared_deployment_id: number
      driver_id: null
      target: { pool_max?: number }
    }

/** `GET /hub/environments/:envId/app-key` (Task 3): never the key, only its mask and fingerprint. */
export interface AppKeyInfo {
  known: boolean
  /** '••••••' when known, else null. */
  key: string | null
  fp: string | null
  source: 'entry' | 'stack' | null
  /** The stored entry no longer opens (the Hub's ENCRYPTION_KEY changed, or it is damaged). */
  entry_unreadable?: boolean
  code?: string
  message?: string
}

export interface AppKeySaved {
  fp: string
  changed: boolean
  /** Where the key was checked against what the app runs with; null = it could not be. */
  verified?: string | null
  unverified_code?: string
}

export interface PlaceSharedInput {
  shared_id: number
  database_id: number
  pool_max?: number
  first_admin: { email: string; first_name?: string; last_name?: string }
}

export interface JobRunState {
  id: number
  status: string
  error: string | null
}

// ─── Query keys (every root starts 'hub'; one key = one shape) ────────────────

type Tagged<K extends readonly unknown[], T> = DataTag<K, T>
const tag = <T, K extends readonly unknown[]>(k: K) => k as unknown as Tagged<K, T>

export const moveKeys: {
  placement: (id: number) => Tagged<readonly ['hub', 'placement', number], HubPlacement>
  moves: (envId: number) => Tagged<readonly ['hub', 'moves', number], HubMove[]>
  move: (id: number) => Tagged<readonly ['hub', 'move', number], HubMove>
  plan: (
    envId: number,
    target: string
  ) => Tagged<readonly ['hub', 'move-plan', number, string], MovePlan>
  appKey: (envId: number) => Tagged<readonly ['hub', 'app-key', number], AppKeyInfo>
  jobRun: (id: number) => Tagged<readonly ['hub', 'job-run', number], JobRunState>
} = {
  placement: (id) =>
    tag<HubPlacement, readonly ['hub', 'placement', number]>(['hub', 'placement', id] as const),
  moves: (envId) =>
    tag<HubMove[], readonly ['hub', 'moves', number]>(['hub', 'moves', envId] as const),
  move: (id) => tag<HubMove, readonly ['hub', 'move', number]>(['hub', 'move', id] as const),
  plan: (envId, target) =>
    tag<MovePlan, readonly ['hub', 'move-plan', number, string]>([
      'hub',
      'move-plan',
      envId,
      target
    ] as const),
  appKey: (envId) =>
    tag<AppKeyInfo, readonly ['hub', 'app-key', number]>(['hub', 'app-key', envId] as const),
  jobRun: (id) =>
    tag<JobRunState, readonly ['hub', 'job-run', number]>(['hub', 'job-run', id] as const)
}

/** A target as one string (query key, Combobox value): `shared:3` / `dedicated:12`. */
export const targetValue = (t: MoveTarget): string =>
  t.kind === 'shared' ? `shared:${t.shared_id}` : `dedicated:${t.placement_id}`

export function targetFromValue(v: string): MoveTarget | null {
  const m = /^(shared|dedicated):(\d+)$/.exec(v)
  if (!m) return null
  const id = Number(m[2])
  return m[1] === 'shared'
    ? { kind: 'shared', shared_id: id }
    : { kind: 'dedicated', placement_id: id }
}

// ─── Calls ────────────────────────────────────────────────────────────────────

const data = <T>(r: { data: { data: T } }) => r.data.data

export const fetchPlacement = (id: number) =>
  api.get<{ data: HubPlacement }>(`/hub/placements/${id}`).then(data)

/** A stack name the Hub accepts (2–41 lower-case letters, digits, dashes; a letter first). */
export const STACK_NAME_RE = /^[a-z][a-z0-9-]{1,40}$/

/** A stack name to start from: `<app>-<env>`, cut to fit. */
export const defaultStackName = (appKey: string, envKey: string) =>
  `${appKey}-${envKey}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .slice(0, 41)
    .replace(/-+$/, '')

/**
 * A fresh stack name per attempt (`<app>-<env>-<4 random>`), so a placement left by a closed
 * tab never makes the next attempt answer STACK_NAME_TAKEN (ruling P6-18 N-1).
 */
export function uniqueStackName(appKey: string, envKey: string): string {
  const base = defaultStackName(appKey, envKey).slice(0, 36).replace(/-+$/, '') || 'app'
  const bytes = new Uint8Array(4)
  globalThis.crypto.getRandomValues(bytes)
  const tail = [...bytes].map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('')
  return `${base}-${tail}`
}

/**
 * Ruling P6-17 gap (a): a new dedicated Docker placement for an environment that has only ever
 * run on a shared deployment (as HubAdoptForm makes one). The panel deletes it again when no
 * move is started on it.
 */
export const createDedicatedPlacement = (driverId: number, stack: string) =>
  api
    .post<{ data: { id: number } }>('/hub/placements', {
      kind: 'dedicated',
      driver_id: driverId,
      target: { stack }
    })
    .then((r) => r.data.data)

export const deletePlacement = (id: number) => api.delete(`/hub/placements/${id}`)

export const fetchMovePlan = (envId: number, to: MoveTarget) =>
  api.post<{ data: MovePlan }>(`/hub/environments/${envId}/move/plan`, { to }).then(data)

/**
 * The body of an answer: routes/hub-move.ts (Task 16) wraps every answer in `{data}`; a bare
 * answer is taken as well, so a route that drops the wrapper never breaks the panel.
 */
export function answerOf<T>(body: unknown): T | undefined {
  if (body && typeof body === 'object' && 'data' in body) return (body as { data: T }).data
  return body as T | undefined
}

/** 202 `{data: {move_id}}` (Task 16 routes/hub-move.ts). */
export const startMove = (
  envId: number,
  body: {
    to: MoveTarget
    plan_hash: string
    confirm: string
    checklist: Record<string, boolean>
    /** Refusals the operator overrides for this move (P6-20: only LINK_URL_NOT_PULLABLE). */
    overrides?: string[]
  }
) =>
  api.post(`/hub/environments/${envId}/move`, body).then((r) => {
    const id = Number(answerOf<{ move_id?: unknown }>(r.data)?.move_id)
    if (!Number.isInteger(id) || id < 1) throw new Error('The Hub did not say which move started')
    return { move_id: id }
  })

export const fetchMove = (id: number) => api.get<{ data: HubMove }>(`/hub/moves/${id}`).then(data)

export const fetchMoves = (envId: number) =>
  api.get<{ data: HubMove[] }>(`/hub/environments/${envId}/moves`).then((r) => r.data.data ?? [])

/**
 * Cancel a move: before `release` the Hub rolls it back (the app stays on its old home). After
 * it the Hub refuses (409 TOO_LATE), so the panel offers no cancel then. Names the move by id.
 */
export const cancelMove = (id: number) => api.post(`/hub/moves/${id}/cancel`, {})

/**
 * Roll back an interrupted move (before `release`): the plan has no route of its own for it —
 * a cancel before release is the rollback (Task 16 `cancelMove`). Carries the move id.
 */
export const rollbackMove = (id: number) => cancelMove(id)

export const resumeMove = (id: number) => api.post(`/hub/moves/${id}/resume`, {})

/** Manual routing: ask the Hub to check the public name now. */
/** `{data: {serving}}` (Task 16). */
export const confirmMoveRoute = (id: number) =>
  api
    .post(`/hub/moves/${id}/confirm-route`, {})
    .then((r) => ({ serving: answerOf<{ serving?: unknown }>(r.data)?.serving === true }))

export const setMoveChecklist = (id: number, item: string, done: boolean) =>
  api.post(`/hub/moves/${id}/checklist`, { item, done })

export const placeShared = (envId: number, body: PlaceSharedInput) =>
  api
    .post<{ data: { job_run_id: number } }>(`/hub/environments/${envId}/place-shared`, body)
    .then(data)

export const fetchAppKey = (envId: number) =>
  api.get<{ data: AppKeyInfo }>(`/hub/environments/${envId}/app-key`).then(data)

export const putAppKey = (envId: number, key: string) =>
  api.put<{ data: AppKeySaved }>(`/hub/environments/${envId}/app-key`, { key }).then(data)

export const fetchJobRun = (id: number) =>
  api
    .get<{ data: { run: JobRunState } }>(`/job-runs/${id}/log`, { params: { after: 0 } })
    .then((r) => r.data.data.run)

// ─── Hooks ────────────────────────────────────────────────────────────────────

/** Shared deployments (Hub admins only). */
export function useSharedList(enabled = true) {
  return useQuery({
    // Task 17's key and fetcher: the Shared deployments tab and the move panel share one cache.
    queryKey: sharedKeys.list(),
    queryFn: fetchSharedList,
    enabled,
    staleTime: 30_000
  })
}

export function usePlacement(id: number | null, enabled = true) {
  return useQuery({
    queryKey: moveKeys.placement(id ?? 0),
    queryFn: () => fetchPlacement(id as number),
    enabled: enabled && id != null,
    staleTime: 60_000
  })
}

export function useDrivers(enabled = true) {
  return useQuery({
    queryKey: hubKeys.drivers(),
    queryFn: fetchDrivers,
    enabled,
    staleTime: 60_000
  })
}

/**
 * The placement chip of an environment: `Shared · <key>` or `Dedicated · <driver>`. Null while
 * any part is unknown (no placement, still reading, or the reader may not see placements).
 */
export function placementLabel(
  p: HubPlacement | undefined,
  shared: SharedDeploymentRow[] | undefined,
  drivers: HubDriver[] | undefined
): string | null {
  if (!p) return null
  if (p.kind === 'shared') {
    const s = shared?.find((x) => x.id === p.shared_deployment_id)
    return s ? `Shared · ${s.key}` : 'Shared'
  }
  const d = drivers?.find((x) => x.id === p.driver_id)
  return d ? `Dedicated · ${d.name}` : 'Dedicated'
}

// ─── Which move the panel shows ───────────────────────────────────────────────

/**
 * Ruling P6-17 I-1: the panel shows the newest move of an environment (its result, error and open
 * checklist items) until the person dismisses it. What was dismissed is a per-viewer convenience
 * (this browser only); the move itself is never changed by it.
 */
const dismissKey = (envId: number) => `nvr:hub-move-dismissed:${envId}`

export function readDismissedMove(envId: number): number | null {
  try {
    const v = Number(window.localStorage.getItem(dismissKey(envId)))
    return Number.isInteger(v) && v > 0 ? v : null
  } catch {
    return null
  }
}

export function writeDismissedMove(envId: number, moveId: number) {
  try {
    window.localStorage.setItem(dismissKey(envId), String(moveId))
  } catch {
    // No storage (private window): the move shows again on the next visit.
  }
}

/** The newest move (highest id); the list is newest first, but never trust the order. */
export const newestMove = (moves: HubMove[] | undefined): HubMove | undefined =>
  (moves ?? []).reduce<HubMove | undefined>((a, b) => (!a || b.id > a.id ? b : a), undefined)

// ─── Status and steps ─────────────────────────────────────────────────────────

const LIVE = new Set(['planned', 'running', 'waiting'])
const OPEN = new Set(['planned', 'running', 'waiting', 'interrupted'])

/** Still going (or about to): polled. A status this screen does not know counts as live. */
export const isLiveMove = (s: string) => LIVE.has(s) || !KNOWN_MOVE_STATUS.has(s)
/** A move that still holds the environment (interrupted waits for Resume or Roll back). */
export const isOpenMove = (s: string) => OPEN.has(s) || !KNOWN_MOVE_STATUS.has(s)

export const MOVE_STATUS_WORDS: Record<MoveStatus, string> = {
  planned: 'Starting',
  running: 'Running',
  waiting: 'Waiting for the address',
  interrupted: 'Interrupted',
  success: 'Moved',
  failed: 'Failed',
  rolled_back: 'Rolled back',
  cancelled: 'Cancelled'
}
const KNOWN_MOVE_STATUS = new Set<string>(Object.keys(MOVE_STATUS_WORDS))

export const moveStatusWords = (s: string) =>
  KNOWN_MOVE_STATUS.has(s) ? MOVE_STATUS_WORDS[s as MoveStatus] : s || 'Unknown'

export const MOVE_STATUS_TONE: Record<MoveStatus, string> = {
  planned: 'text-sky-700 dark:text-sky-300',
  running: 'text-sky-700 dark:text-sky-300',
  waiting: 'text-amber-800 dark:text-amber-300',
  interrupted: 'text-amber-800 dark:text-amber-300',
  success: 'text-emerald-700 dark:text-emerald-300',
  failed: 'text-red-700 dark:text-red-300',
  rolled_back: 'text-slate-600 dark:text-slate-300',
  cancelled: 'text-slate-600 dark:text-slate-300'
}
export const moveStatusTone = (s: string) =>
  KNOWN_MOVE_STATUS.has(s)
    ? MOVE_STATUS_TONE[s as MoveStatus]
    : 'text-slate-600 dark:text-slate-300'

export const MOVE_KIND_WORDS: Record<MoveKind, string> = {
  to_shared: 'To a shared deployment',
  to_dedicated: 'To a dedicated stack',
  between_shared: 'Between shared deployments'
}

/** What each step does, in plain words (a key this screen does not know shows as sent). */
export const MOVE_STEP_WORDS: Record<string, string> = {
  check: 'Check everything again',
  files_warm: 'Copy the files while the app still serves',
  maintenance_on: 'Put the app in maintenance',
  wait_idle: 'Wait for running imports, exports and renders to finish',
  files_delta: 'Copy the files that changed since',
  deploy_target: 'Deploy the new stack',
  place_on_target: 'Place the app on the target',
  target_ready: 'Wait until the target serves the app',
  files_full: 'Copy every file',
  route: 'Point the address at the target',
  verify: 'Check the address answers from the target',
  release: 'Take the app out of maintenance',
  retire_source: 'Retire the old home',
  done: 'Done'
}
export const stepWords = (key: string) => MOVE_STEP_WORDS[key] ?? key

/** `stopped` = the step a run was on when it stopped (interrupted): no spinner, nothing failed. */
export type MoveStepState =
  | 'done'
  | 'running'
  | 'waiting'
  | 'stopped'
  | 'failed'
  | 'undone'
  | 'pending'

export interface MoveStepRow {
  key: string
  label: string
  state: MoveStepState
}

const parse = <T>(v: unknown): T | null => {
  if (v == null) return null
  if (typeof v !== 'string') return v as T
  try {
    return JSON.parse(v) as T
  } catch {
    return null
  }
}

export const movePlanOf = (m: Pick<HubMove, 'plan'>): MovePlan | null => parse<MovePlan>(m.plan)
/**
 * The file copy to show. Task 16 stores one summary per copy (`{warm, delta, full}`, each with
 * `at`); the newest is shown. A single pull status is taken as it is.
 */
export function moveFilesOf(m: Pick<HubMove, 'files'>): MoveFiles | null {
  const raw = parse<Record<string, unknown>>(m.files)
  if (!raw || typeof raw !== 'object') return null
  const parts = (['warm', 'delta', 'full'] as const)
    .map((k) => raw[k] as (MoveFiles & { at?: string }) | undefined)
    .filter((x): x is MoveFiles & { at?: string } => !!x && typeof x === 'object')
  if (parts.length === 0) return 'total' in raw ? (raw as MoveFiles) : null
  return parts.reduce((a, b) => ((b.at ?? '') >= (a.at ?? '') ? b : a))
}

/** Task 16 `steps` column: `{list: [{key, state}], phase, …}`; older shapes are a plain list. */
interface StoredSteps {
  list?: unknown[]
  phase?: 'forward' | 'rollback'
}

/** The run is undoing what it did (a failure or a cancel before release). */
export const isRollingBack = (m: Pick<HubMove, 'steps'>) =>
  parse<StoredSteps>(m.steps)?.phase === 'rollback'

const STEP_STATE_ALIAS: Record<string, MoveStepState> = {
  done: 'done',
  success: 'done',
  ok: 'done',
  running: 'running',
  waiting: 'waiting',
  failed: 'failed',
  undone: 'undone',
  rolled_back: 'undone',
  undo_failed: 'failed',
  pending: 'pending'
}

/**
 * The run's steps with a state each. The row stores either the keys in order (the state follows
 * from `step` and the status) or `{key, status}` rows (taken as they are).
 */
export function moveStepRows(
  m: Pick<HubMove, 'steps' | 'step' | 'status' | 'plan'>
): MoveStepRow[] {
  const stored = parse<unknown[] | StoredSteps>(m.steps)
  const raw = Array.isArray(stored)
    ? stored
    : Array.isArray(stored?.list)
      ? stored.list
      : (movePlanOf(m)?.steps ?? [])
  const list = Array.isArray(raw) ? raw : []
  const objects = list.every((s) => s && typeof s === 'object')
  if (list.length > 0 && objects) {
    return list.map((s) => {
      const o = s as { key?: unknown; status?: unknown; state?: unknown }
      const key = String(o.key ?? '')
      const st = String(o.state ?? o.status ?? 'pending')
      const state = STEP_STATE_ALIAS[st] ?? 'pending'
      // A run that is not live (interrupted, ended) never shows a step as still going.
      const settled =
        !isLiveMove(m.status) && (state === 'running' || state === 'waiting') ? 'stopped' : state
      return { key, label: stepWords(key), state: settled }
    })
  }
  const keys = list.map(String)
  if (m.status === 'success')
    return keys.map((key) => ({ key, label: stepWords(key), state: 'done' }))
  const at = m.step ? keys.indexOf(m.step) : -1
  const cur = at < 0 && isLiveMove(m.status) ? 0 : at
  const atState: MoveStepState =
    m.status === 'waiting'
      ? 'waiting'
      : isLiveMove(m.status)
        ? 'running'
        : m.status === 'rolled_back' || m.status === 'cancelled'
          ? 'undone'
          : m.status === 'interrupted'
            ? 'stopped'
            : 'failed'
  return keys.map((key, i) => ({
    key,
    label: stepWords(key),
    state:
      i < cur ? (m.status === 'rolled_back' ? 'undone' : 'done') : i === cur ? atState : 'pending'
  }))
}

/**
 * Design B4: what the environment row says about its newest move, or null when nothing needs
 * attention there. `tone` picks the chip colours.
 */
export type MoveBadge = { text: string; tone: 'live' | 'attention' | 'halted' }

export function moveBadge(m: HubMove | undefined): MoveBadge | null {
  if (!m) return null
  if (m.status === 'waiting') return { text: 'Waiting for you', tone: 'attention' }
  if (isHaltedTargetLive(m)) return { text: 'Halted: stop the new home', tone: 'halted' }
  if (isKeyNotChecked(m)) return { text: 'Waiting for the app key', tone: 'attention' }
  if (m.status === 'interrupted') return { text: 'Move interrupted', tone: 'attention' }
  if (isLiveMove(m.status)) {
    const rows = moveStepRows(m)
    const at = rows.findIndex((r) => r.state === 'running' || r.state === 'waiting')
    const n = at >= 0 ? at + 1 : rows.filter((r) => r.state === 'done').length + 1
    return {
      text: rows.length ? `Moving · step ${Math.min(n, rows.length)} of ${rows.length}` : 'Moving',
      tone: 'live'
    }
  }
  // Ended: only while something is still to do (the panel cannot be dismissed then).
  const open = moveChecklistOf(m).some(
    (c) => !c.done && (m.status === 'success' || c.id === REPOINT_ITEM)
  )
  if (open) return { text: 'To do after move', tone: 'attention' }
  return null
}

/** Whether the run has passed `release` (after it, nothing is rolled back). */
export function pastRelease(m: Pick<HubMove, 'steps' | 'step' | 'status' | 'plan'>): boolean {
  const rows = moveStepRows(m)
  const rel = rows.findIndex((r) => r.key === 'release')
  if (rel < 0) return false
  if (rows[rel].state === 'done') return true
  const keys = rows.map((r) => r.key)
  return !!m.step && keys.indexOf(m.step) > rel
}

/** The move's checklist with what is done: `{id: done}` or `[{id, text, required, done}]`. */
export function moveChecklistOf(
  m: Pick<HubMove, 'checklist' | 'plan'>
): (MoveChecklistItem & { done: boolean })[] {
  const raw = parse<unknown>(m.checklist)
  const planned = movePlanOf(m)?.checklist ?? []
  if (Array.isArray(raw))
    return raw.map((r) => {
      const o = r as Partial<MoveChecklistItem> & { done?: unknown }
      const p = planned.find((x) => x.id === o.id)
      return {
        id: String(o.id ?? ''),
        text: String(o.text ?? p?.text ?? CHECKLIST_WORDS[String(o.id)] ?? o.id ?? ''),
        required: !!(o.required ?? p?.required),
        done: o.done === true
      }
    })
  const done = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const items = planned.map((p) => ({ ...p, done: done[p.id] === true }))
  for (const [id, v] of Object.entries(done))
    if (!items.some((i) => i.id === id))
      items.push({ id, text: CHECKLIST_WORDS[id] ?? id, required: false, done: v === true })
  return items
}

/** Checklist items the Hub adds after a move (Task 16: a failed retire leaves its item open). */
const CHECKLIST_WORDS: Record<string, string> = {
  gitlab_boot_window: 'The new app starts in maintenance, or nothing writes during the move.',
  issuer_same: 'The old and the new home sign in through the same Entra tenant.',
  extension_builds_same:
    'The app runs the same build of each extension as the deployment installs.',
  volumes_one_node: 'The target keeps files on shared storage, or its swarm has one node.',
  redis_separate: 'The old and the new home do not share one Redis database and channel prefix.',
  storage_local: 'Every file is on local storage on both sides.',
  db_identity_checked: 'No other app on the target uses this app’s database.',
  retire_source: 'Retire the old home by hand: it could not be retired automatically.',
  old_stack_stopped: 'Stop the old stack.',
  callbacks_registered: 'Register the sign-in callback addresses.',
  route_ticket: 'Ask for the address change.'
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

// ─── Plain words for blockers, warnings and refusals ──────────────────────────

type Copy = { title: string; hint?: string }

/** Why a move cannot start (plan blockers, Task 15 + rulings R1/R2, T9 carries). */
export const MOVE_BLOCKER_COPY: Record<string, Copy> = {
  SAME_PLACEMENT: {
    title: 'The environment already runs there',
    hint: 'Pick another shared deployment or dedicated stack.'
  },
  NOT_HUB_LINKED: {
    title: 'The Hub has no hub link to this app',
    hint: "Set the app's HUB_TOKEN and enter the same token on the environment, then plan again."
  },
  LINK_UNREACHABLE: {
    title: "The app's hub link does not answer",
    hint: 'The Hub cannot ask the app what a move would change. Check that the app runs, then plan again.'
  },
  VERSION_DIFFERS: {
    title: 'The target runs another version',
    hint: 'A move never changes the version. Promote the environment, or upgrade the shared deployment, so both run the same one.'
  },
  EXTENSION_NOT_ALLOWED: {
    title: 'The shared deployment does not load an extension this app uses',
    hint: "Add it to the deployment's extensions (only extensions marked safe for shared deployments load there)."
  },
  EXTENSION_VERSION_DIFFERS: {
    title: 'An extension is pinned to another version on the target',
    hint: 'Pin the same extension image on both, then plan again.'
  },
  NO_DATABASE_RECORD: {
    title: "The Hub has no record of this app's database",
    hint: "On the Databases tab, adopt the app's database if it is not listed, open it and use Attach to environment."
  },
  SQLITE_NOT_SHARED: {
    title: 'The app runs on SQLite',
    hint: 'A shared deployment needs a database server. Move the data to SQL Server, Postgres or MySQL first.'
  },
  APP_KEY_UNKNOWN: {
    title: "The Hub does not know this app's encryption key",
    hint: "Enter it below (the app's ENCRYPTION_KEY, 64 hex characters), then plan again. Apps created through GitLab always need this."
  },
  APP_KEY_MISMATCH: {
    title: 'The key the Hub holds is not the one the app runs with',
    hint: "Enter the app's real ENCRYPTION_KEY below, then plan again. The target would not open what the app sealed."
  },
  SIGNIN_VIA_HUB: {
    title: 'The app signs in through the Hub',
    hint: 'Sign-in through the Hub does not work on a shared deployment yet. Switch the app to direct sign-in first.'
  },
  ISSUER_DIFFERS: {
    title: "The deployment's sign-in is in another Microsoft tenant",
    hint: "Accounts would not match after the move. Use a deployment that signs in with the app's tenant."
  },
  POOL_BUDGET: {
    title: 'The deployment has no room for this app’s connections',
    hint: "Lower the app's connections, raise the deployment's connection budget, or pick another deployment."
  },
  POOL_TOO_SMALL: {
    title: 'The app needs at least 2 database connections',
    hint: 'Give it between 2 and 20.'
  },
  BUSY: {
    title: 'Something else is running on this environment',
    hint: 'Wait for the promotion, stack change or other move to finish, then plan again.'
  },
  SHARED_BUSY: {
    title: 'The shared deployment is busy',
    hint: 'It is being upgraded, or another app is being placed or moved there. Try again when it finishes.'
  },
  SHARED_NOT_ACTIVE: {
    title: 'That shared deployment takes no apps right now',
    hint: 'It is new (deploy it first) or retired. Pick another one.'
  },
  SHARED_RETIRED: {
    title: 'That shared deployment is retired',
    hint: 'A retired deployment takes no apps. Pick another one.'
  },
  TARGET_UNREACHABLE: {
    title: 'The target does not answer',
    hint: "Check the deployment's link address, or the Docker host's agent, then plan again."
  },
  DB_UNREACHABLE_FROM_TARGET: {
    title: "The target cannot reach the app's database",
    hint: 'Open the network path from the target to the database server, then plan again.'
  },
  DATABASE_DIFFERS: {
    title: 'The target would open another database than the one the app serves',
    hint: "Check the database record attached to the environment: its server and name must be the app's own."
  },
  TARGET_IN_USE: {
    title: 'Another environment already uses that placement',
    hint: 'A move needs a placement of its own. Pick another one.'
  },
  DB_IDENTITY_SHARED: {
    title: 'Another app on the target reports the same database',
    hint: 'The Hub cannot prove the target would open this app’s own database. Check both database records.'
  },
  HOSTNAME_TAKEN: {
    title: 'An address of this app already belongs to another app on the target',
    hint: 'Give the environment its own addresses.'
  },
  DRIVER_UNSUPPORTED: {
    title: 'The Hub cannot move an app to or from this kind of placement',
    hint: 'Move it by hand, or pick a Docker stack or a shared deployment.'
  },
  SOURCE_UNREACHABLE: {
    title: 'The Hub could not reach the old home once its name moves',
    hint: 'Move to a target on the same Docker driver (the Hub then routes it itself), or give the old stack a published port, then plan again.'
  },
  SOURCE_NOT_PULLABLE: {
    title: 'The target cannot fetch files from the old home’s address',
    hint: 'Give the source an address the target may reach (a private IP, or list its name in the target’s SSRF_ALLOW_HOSTS), then plan again.'
  },
  LINK_URL_NOT_PULLABLE: {
    title: 'The target cannot fetch files from the source deployment’s link address',
    hint: 'Its name resolves to a private address. Use a private IP for the link address, or list the name in the target’s SSRF_ALLOW_HOSTS. If the target already allows it there, tick that box below and start again.'
  },
  GATHER_FAILED: {
    title: 'The Hub could not read everything this plan needs',
    hint: 'A plan built on a missing answer cannot be trusted. Wait a moment, then plan again; the detail below names what did not answer.'
  },
  REDIS_SHARED: {
    title: 'The old and the new home share one Redis database',
    hint: 'Retiring the old home would also stop the new one. Give the target its own Redis database (or channel prefix), then plan again.'
  },
  // The app's own readiness report (Task 9): what a shared deployment cannot run yet.
  STAGED_IMPORTS: {
    title: 'The app has staged imports set up',
    hint: 'A shared deployment does not run staged imports yet. Finish or remove them first.'
  },
  ROW_SCHEDULES: {
    title: 'The app has schedules stored in its data',
    hint: 'A shared deployment does not run per-app schedules yet, so they would silently stop. Turn them off first.'
  },
  ISSUE_TRACKERS: {
    title: 'GitLab issue sync is on in this app',
    hint: 'A shared deployment does not sync issues yet. Turn issue sync off first.'
  },
  EXEC_SCRIPT_FLOWS: {
    title: 'Some of the app’s flows run scripts',
    hint: 'A shared deployment cannot run flow scripts. Change or turn off those flows first.'
  },
  SQLITE: {
    title: 'The app runs on SQLite',
    hint: 'A shared deployment needs a database server. Move the data to SQL Server, Postgres or MySQL first.'
  },
  ENV_OBJECT_STORAGE: {
    title: 'Files are stored in S3 or Azure set by environment variables',
    hint: 'A move copies only files stored on disk, so these would be lost. Move the storage settings into the app (Settings → Files) first.'
  },
  STORAGE_COUNT_UNKNOWN: {
    title: 'The app did not say which storage its files are on',
    hint: 'This move changes the folder files are kept in, so the Hub must know which storage they use before it copies them. Check that the app answers, then plan again.'
  },
  STORAGE_LAYOUT_DIFFERS: {
    title: 'Some files are on storage the move cannot copy',
    hint: 'This move changes the folder files are kept in, and the move copies only local, S3 and Azure files. Move those files to one of them first.'
  }
}

/** What a move will change that is not a reason to stop (amber). */
export const MOVE_WARNING_COPY: Record<string, Copy> = {
  SIGN_IN_AGAIN: {
    title: 'Everyone signs in again after the move',
    hint: 'Sessions do not move. Phone app and connected AI apps (MCP) sign in again too.'
  },
  SIGNED_LINKS_RESET: {
    title: 'Links the old home signed stop working, and unsaved drafts are dropped',
    hint: 'For example submission status links and shared media links. People ask for a new link. Unsaved form drafts are dropped too: ask people to save their open forms first.'
  },
  SAME_APP_ON_DEPLOYMENT: {
    title: 'Another environment of this app already runs on this deployment',
    hint: 'Fine for development and staging next to each other; each keeps its own data and files.'
  },
  MULTI_NODE_VOLUMES: {
    title: 'The Docker host has more than one node',
    hint: 'Files on a local volume stay on one node. Use shared storage (NFS) for the files volume.'
  },
  MANUAL_ROUTE: {
    title: 'Someone outside the Hub changes the address',
    hint: 'The old home keeps serving until the new address answers. The request to send is below.'
  },
  ISSUER_UNVERIFIED: {
    title: 'The Hub could not read which sign-in the app uses',
    hint: 'Accounts link only when both sides sign in through the same Entra tenant. Check that they do, then tick that item in the checklist.'
  },
  GITLAB_BOOT_WINDOW: {
    title: 'The Hub cannot prove the new app starts in maintenance',
    hint: 'It may start without maintenance, so the old one goes into maintenance while it deploys, until the Hub has switched the new one’s maintenance on. Make sure its deploy job passes the Hub’s boot maintenance, or move at a quiet time, then tick that item in the checklist.'
  },
  STORAGE_PREFIX_CHANGES: {
    title: 'Files in S3 or Azure are copied to a new folder',
    hint: 'A shared deployment keeps each app’s files in its own folder of the bucket, so they are copied, not shared: the bucket holds both copies until the old ones are removed.'
  },
  STACK_REAPPLY_ALL: {
    title: 'Every app on the shared deployment restarts once',
    hint: 'New names re-apply the whole shared stack: its replicas restart one by one, with every app on them. Move at a quiet time, or tell the other apps’ owners first.'
  },
  EXTENSION_PIN_UNVERIFIED: {
    title: 'The Hub cannot compare the build of an extension on both sides',
    hint: 'One side names no image pin for it. Check that the app runs the same build the deployment installs, then tick that item in the checklist.'
  },
  MULTI_NODE_UNVERIFIED: {
    title: 'The Hub cannot tell how many nodes the target’s Docker host has',
    hint: 'Its agent did not answer. Check that the files volume is shared storage (or the swarm has one node), then tick that item in the checklist.'
  },
  REDIS_UNVERIFIED: {
    title: 'The Hub cannot see which Redis one side uses',
    hint: 'Make sure the old and the new home do not share one Redis database and channel prefix, then tick that item in the checklist.'
  },
  STORAGE_UNVERIFIED: {
    title: 'The Hub cannot see where one side keeps its files',
    hint: 'Make sure no side keeps files in S3 or Azure set by environment variables (those are not copied), then tick that item in the checklist.'
  },
  DB_IDENTITY_UNCHECKED: {
    title: 'Some apps on the target could not be compared with this app’s database',
    hint: 'Check that none of them uses this app’s database server and name, then tick that item in the checklist.'
  },
  REPLAYS_NOT_MOVED: {
    title: 'Session replays are not moved',
    hint: 'Replays recorded on the old home stay there.'
  },
  OLD_STACK_STOP: {
    title: 'The old stack keeps running until someone stops it',
    hint: 'The Hub retires it (it answers only "moved"); stop it in its own pipeline afterwards.'
  },
  DIRECTORY_SYNC: {
    title: 'Directory sync does not run on a shared deployment',
    hint: 'People still sign in; new people are not added ahead of their first sign-in.'
  },
  PHONE_PUSH: {
    title: 'Phone alerts do not run on a shared deployment',
    hint: 'In-app and email notifications still work.'
  },
  TEAMS_BOT: {
    title: 'The Teams bot does not run on a shared deployment',
    hint: 'Tell the people who use it that alerts arrive in the app and by email instead.'
  },
  MAIL_RETRY: {
    title: 'Failed emails are not retried on a shared deployment',
    hint: 'They stay in the mail log and can be resent by hand.'
  },
  HUDDLE_TURN: {
    title: 'Huddles use the deployment’s media servers, not the app’s own',
    hint: 'If your network allows only the app’s own media servers, ask for the deployment’s to be allowed too.'
  },
  ENV_SMTP: {
    title: 'Mail settings come from environment variables on the old home',
    hint: 'Enter them in the app (Settings → Email) so mail keeps going after the move.'
  },
  SESSION_REPLAYS: {
    title: 'Session replays are not moved',
    hint: 'Watch any replay you still need before the move; the old ones stay on the old home until it is removed.'
  },
  HELP_VIDEO_RENDERS: {
    title: 'Help-video renders in the queue start again',
    hint: 'A video waiting for its render is rendered again on its next publish.'
  },
  SLA_FLIPS: {
    title: 'SLA status changes are not checked on a shared deployment',
    hint: 'Deadlines still show on records; tell people who rely on SLA alerts to watch the deadline lists instead.'
  },
  WEEKLY_DIGESTS: {
    title: 'Weekly digests are not sent on a shared deployment',
    hint: 'Tell the people who get them; daily notifications and the in-app inbox still work.'
  },
  RETENTION_PASS: {
    title: 'Log retention does not run per app on a shared deployment',
    hint: 'Old log rows are kept longer. Run the retention policies by hand from Security → Retention if you need them trimmed.'
  }
}

/** Refusals of the move, place and app-key routes (non-planner codes), in plain words. */
export const MOVE_CODE_COPY: Record<string, Copy> = {
  PLAN_CHANGED: {
    title: 'The plan changed since you read it',
    hint: 'Check the plan as it stands now, then start again.'
  },
  CONFIRM_MISMATCH: {
    title: 'The confirmation does not match',
    hint: 'Type the app and environment exactly as shown, then start again.'
  },
  CHECKLIST_OPEN: {
    title: 'A required checklist item is not ticked',
    hint: 'Tick every required item once it is done, then start again.'
  },
  TOO_LATE: {
    title: 'The move is past the point it can be rolled back',
    hint: 'The app already serves from its new home. Let the move finish; if it stops, use Resume.'
  },
  MOVE_ENDED: {
    title: 'That move has already ended',
    hint: 'Its result is shown here. Dismiss it to plan a new move.'
  },
  ROLLING_BACK: {
    title: 'The move is already rolling back',
    hint: 'Wait for it to finish undoing its steps; the app stays on its old home.'
  },
  BAD_OVERRIDE: {
    title: 'That override is not one a move allows',
    hint: 'Reload the panel and start again; only the listed override can be ticked.'
  },
  PLAN_BLOCKED: {
    title: 'Something now stops this move',
    hint: 'The plan was checked again at start and found a blocker. Read the plan below, fix what it names, then start again.'
  },
  BAD_PLAN_HASH: {
    title: 'Check the plan before you start',
    hint: 'A start must carry the plan you read. Plan again, then start.'
  },
  BAD_ITEM: {
    title: 'That checklist answer was not understood',
    hint: 'Reload the move and tick the item again.'
  },
  UNKNOWN_ITEM: {
    title: 'That checklist item is not on this move',
    hint: 'Reload the move to see its checklist as it stands.'
  },
  // Task 16 (ruling P6-24): a rollback that could neither freeze nor stop the new home.
  HALTED_TARGET_LIVE: {
    title: 'The new home could not be stopped, so the old home stays in maintenance',
    hint: 'Stop the new home by hand, tick the box that says so, then Roll back.'
  },
  // A run whose lock was lost or whose process stopped (place.ts, a healed run).
  INTERRUPTED: {
    title: 'The run stopped before it finished',
    hint: 'The Hub lost track of it (it restarted, or its lock was lost). Start it again; it picks up safely.'
  },
  // Step failures stored on a move as `CODE: sentence` (Task 16 run.ts / ops.ts).
  ROUTE_UNSUPPORTED: {
    title: 'The Hub cannot change this address itself',
    hint: 'This placement is routed by hand: make the change the request names and use Check now, or roll the move back.'
  },
  TOKEN_MISSING: {
    title: "The Hub cannot open the shared deployment's token",
    hint: 'Rotate the token on the Shared deployments tab, give the new one to the deployment, then resume the move.'
  },
  MOVE_RUNNING: {
    title: 'A move of this environment is running',
    hint: 'Wait for it to end, or open Move… on the environment to follow it or roll it back.'
  },
  APP_KEY_BUSY: {
    title: "This environment's encryption key is being saved",
    hint: 'Try again in a moment.'
  },
  DATABASE_BUSY: {
    title: "This environment's database record is being attached or detached",
    hint: 'Try again in a moment.'
  },
  SHARED_UPGRADE_RUNNING: {
    title: 'The shared deployment is being upgraded',
    hint: 'Wait for the upgrade to end (Shared deployments tab), then try again.'
  },
  CHECKLIST_INCOMPLETE: {
    title: 'A required checklist item is not ticked',
    hint: 'The Hub checked the list again at start. Tick every item under Confirm before moving once it is true, then start again.'
  },
  NOT_INTERRUPTED: {
    title: 'That move is not interrupted any more',
    hint: 'Reload to see how it stands.'
  },
  NOT_WAITING: {
    title: 'That move is not waiting for its address',
    hint: 'Reload to see how it stands.'
  },
  NO_PLACEMENT: {
    title: 'This environment does not run anywhere the Hub knows yet',
    hint: 'A new environment is placed, not moved: use Place on shared deployment….'
  },
  NOT_A_MOVE: {
    title: 'The Hub moves only onto or off a shared deployment',
    hint: 'To change one dedicated stack for another, edit the environment’s placement instead.'
  },
  BAD_TARGET: {
    title: 'Pick where to move it',
    hint: 'A shared deployment, or a dedicated stack this environment ran on before.'
  },
  USE_MOVE: {
    title: 'This environment has already served',
    hint: 'An environment that served moves instead: use Move….'
  },
  ALREADY_PLACED: {
    title: 'This environment already runs on a shared deployment',
    hint: 'Use Move… to take it to another one.'
  },
  STACK_RUNNING: {
    title: 'A Docker stack still runs for this environment',
    hint: 'Remove the stack in its stack panel first, or use Move… to take its data along.'
  },
  DATABASE_NOT_READY: {
    title: 'That database is not ready',
    hint: 'Pick a database whose status is Ready.'
  },
  DATABASE_IN_USE: {
    title: 'Another environment already uses that database',
    hint: 'Each environment has its own database.'
  },
  CREATION_RUNNING: {
    title: 'A creation step is running on this environment',
    hint: 'Wait for it to finish, then try again.'
  },
  BAD_FIRST_ADMIN: {
    title: 'The first administrator needs a valid email address',
    hint: 'They sign in with it and get full rights in the app.'
  },
  BAD_POOL: { title: 'Connections must be a number from 2 to 20' },
  BAD_SHARED: { title: 'Pick a shared deployment' },
  BAD_DATABASE: { title: 'Pick a database' },
  NOT_FOUND: {
    title: 'That no longer exists',
    hint: 'It was removed meanwhile. Reload and pick again.'
  },
  BAD_KEY: {
    title: 'That is not an app encryption key',
    hint: "The key is the app's ENCRYPTION_KEY: 64 characters, 0–9 and a–f."
  },
  APP_KEY_UNVERIFIED: {
    title: 'The Hub could not confirm the new key',
    hint: 'It already holds a different key and could not check the new one against the running app, so nothing changed. Check that the app answers over its hub link, then save again.'
  },
  APP_KEY_IMMUTABLE: {
    title: 'The key of an app on a shared deployment cannot be changed',
    hint: 'Every value the app sealed would become unreadable. Nothing was changed.'
  },
  APP_KEY_MISSING: {
    title: 'The shared deployment has no encryption key for this app',
    hint: "Enter the app's key on the environment."
  },
  PLACEMENT_CHANGED: {
    title: "The environment's placement changed while the key was saved",
    hint: 'Nothing was changed. Save again.'
  },
  ENVIRONMENT_BUSY: {
    title: 'Another action holds this environment',
    hint: 'Try again in a moment.'
  },
  LOCK_UNAVAILABLE: {
    title: 'The Hub cannot make sure only one action runs right now',
    hint: 'It cannot reach Redis. Nothing was started. Try again in a moment.'
  }
}

/**
 * Why the Hub could not check a saved app key against what the app runs with (the PUT answer's
 * `unverified_code`, or `reason` on APP_KEY_UNVERIFIED).
 */
export const KEY_CHECK_REASON_WORDS: Record<string, string> = {
  NO_LINK: 'the environment has no hub link',
  UNKNOWN_APP: 'the shared deployment does not list the app yet',
  HUB_SECRET_UNREADABLE: "the Hub cannot read the environment's hub token",
  NO_KEY_FP: 'the app does not report its key fingerprint (an older version)',
  LINK_UNREACHABLE: 'the app did not answer',
  LINK_REFUSED: 'the app refused the hub link',
  LINK_BAD_ANSWER: 'the app gave an answer the Hub could not read',
  UNREACHABLE: 'the app did not answer'
}

/**
 * A stored run error (`move.error`, a job run's error) is `CODE: sentence`. The code maps to
 * plain words when this screen has copy for it; the sentence is shown under them. Text without a
 * code prefix comes back as the sentence alone.
 */
export function splitRunError(text: string): { code: string | null; sentence: string } {
  // Any upper-case code, with or without underscores (place.ts writes `INTERRUPTED: …`).
  const m = /^([A-Z][A-Z0-9_]{2,}):\s*([\s\S]*)$/.exec(text.trim())
  return m ? { code: m[1], sentence: m[2].trim() } : { code: null, sentence: text.trim() }
}

/**
 * Ruling P6-24: a rollback halted because the new home (lifted at release) could be neither
 * frozen nor stopped. The move is interrupted with `HALTED_TARGET_LIVE`; its required checklist
 * item `target_stopped` names the target and how to stop it ("Stop <target>: <how>. …").
 */
export const TARGET_STOPPED_ITEM = 'target_stopped'

/** Task 16: a rolled-back manual move a person had re-pointed; they point the name back. */
export const REPOINT_ITEM = 'repoint_name'

export const isHaltedTargetLive = (m: Pick<HubMove, 'status' | 'error'>) =>
  m.status === 'interrupted' && splitRunError(m.error ?? '').code === 'HALTED_TARGET_LIVE'

/**
 * Untested path 2: a released move whose new home's key did not check at retire_source. It
 * stays interrupted (MOVE_OPEN) with the old home kept until the key is entered and Resume
 * checks it again.
 */
export const isKeyNotChecked = (m: Pick<HubMove, 'status' | 'error'>) =>
  m.status === 'interrupted' && /^APP_KEY_(MISMATCH|UNKNOWN): /.test(m.error ?? '')

/** The target the `target_stopped` item names ("Stop <target>: …"), else a plain stand-in. */
export function haltedTargetName(itemText: string | undefined): string {
  const m = itemText ? /^Stop (.+?):\s/.exec(itemText) : null
  return m ? m[1] : 'the new home'
}

/** Plain words for a run error's code, from the move tables then the Hub's own. */
export function runErrorCopy(code: string | null): { title: string; hint?: string } | null {
  if (!code) return null
  return (
    MOVE_CODE_COPY[code] ??
    MOVE_BLOCKER_COPY[code] ??
    MOVE_WARNING_COPY[code] ??
    (BLOCKER_COPY as Record<string, { title: string; hint?: string }>)[code] ??
    null
  )
}

/** One plan blocker or warning: plain words, and the planner's own sentence as the detail. */
export function moveIssueCopy(
  issue: MoveIssue,
  level: 'blocker' | 'warning'
): Copy & { detail: string | null } {
  const table = level === 'blocker' ? MOVE_BLOCKER_COPY : MOVE_WARNING_COPY
  const copy =
    table[issue.code] ??
    (level === 'blocker' ? MOVE_WARNING_COPY : MOVE_BLOCKER_COPY)[issue.code] ??
    null
  const text = issue.text?.trim() || null
  if (!copy)
    return {
      title: text ?? (level === 'blocker' ? 'This cannot start yet' : 'Check this before you move'),
      hint:
        level === 'blocker'
          ? 'Fix what it names, then use Plan again.'
          : 'Read it, then decide whether to move now.',
      detail: null
    }
  return { ...copy, detail: text && text !== copy.title ? text : null }
}

/** describeError with the move, place and app-key refusals in plain words (then the Hub's). */
export function moveError(err: unknown, fallback: string): ErrorDescription {
  const d = describeError(err, fallback)
  const copy = d.code
    ? (MOVE_CODE_COPY[d.code] ?? MOVE_BLOCKER_COPY[d.code] ?? MOVE_WARNING_COPY[d.code])
    : undefined
  if (!copy) return hubError(err, fallback)
  const out: ErrorDescription = { ...d, title: copy.title }
  if (copy.hint) out.hint = copy.hint
  else delete out.hint
  return out
}

export function moveToast(err: unknown, fallback: string) {
  const d = moveError(err, fallback)
  toast.error(d.title, errorToastOptions(d))
}

/** The one refusal a move start may override (Task 16 MOVE_OVERRIDES, ruling P6-20 #2). */
export const LINK_OVERRIDE = 'LINK_URL_NOT_PULLABLE'
export const LINK_OVERRIDE_TEXT =
  'The target deployment allows this host (it is in its SSRF_ALLOW_HOSTS).'

/** The plan a refused start (409 PLAN_CHANGED) carried, if any. */
export function changedMovePlanOf(err: unknown): MovePlan | null {
  // Task 16 puts the fresh plan at the top of the refusal body (`plan`); `data.plan` is taken too.
  const body = (
    err as { response?: { data?: { code?: unknown; plan?: unknown; data?: { plan?: unknown } } } }
  )?.response?.data
  if (body?.code !== 'PLAN_CHANGED') return null
  const plan = (body.plan ?? body.data?.plan) as MovePlan | undefined
  return plan && Array.isArray(plan.blockers) && typeof plan.plan_hash === 'string' ? plan : null
}

/**
 * Ruling (T3 open question): there is no operator override to re-key a shared app whose stored
 * key is lost. A different key would leave every value the app sealed unreadable on the shared
 * deployment; what the field tells the person to do instead.
 */
export const LOST_KEY_TEXT =
  "There is no override for a lost key, and nothing here changes it: re-keying an app that runs on a shared deployment leaves every value it sealed (partner API secrets, mail and other stored passwords) unreadable, so it is a support action. First look for the app's ENCRYPTION_KEY in your secret store, in the stack settings of its old dedicated stack, or in a backup of the Hub's database from before it was lost, and enter it here; the Hub checks it against the running app. If no copy exists, contact support."

/** Re-exported for the panel: the Hub's driver list. */
export type { HubDriver }
