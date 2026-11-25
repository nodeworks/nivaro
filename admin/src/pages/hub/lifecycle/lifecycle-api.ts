import { type ErrorDescription, errorToastOptions, isRawErrorText } from '@nivaro/shared'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { hubError } from '../hub-api'

/**
 * Hub app lifecycle (enhancements 46 + 47): copying an app's structure into the template library
 * (/api/hub/environments/:envId/clone → Create app installs it) and the retirement wizard
 * (/api/hub/apps/:id/retire…, /api/hub/retirements…).
 */

export interface CloneRow {
  id: number
  template_id: number
  source_app_id: number
  source_environment_id: number
  source_version: string | null
  counts: Record<string, number> | null
  scrubbed: string[]
  scrubbed_count: number
  captured_by: string | null
  captured_at: string | null
  template: { id: number; name: string; version: string; archived: boolean } | null
  source: { app_key: string; app_name: string; env_key: string } | null
}

export type RetireStepKey = 'freeze' | 'export' | 'notice' | 'remove' | 'archive'
export type RetireStepState = 'pending' | 'running' | 'done' | 'failed' | 'interrupted'
export type RetireStatus = 'open' | 'running' | 'interrupted' | 'done' | 'cancelled'

export interface RetireEnvPlan {
  id: number
  key: string
  status: string
  production: boolean
  kind: 'docker' | 'shared' | 'manual'
  freeze: 'link' | 'status' | 'manual' | 'none'
  has_link: boolean
  stack: string | null
  database: boolean
  files_target: boolean
}

export interface RetirePlan {
  app: { id: number; key: string; name: string }
  environments: RetireEnvPlan[]
  production: boolean
}

export interface PlanLine {
  code: string
  text: string
}

export interface RetirePlanView extends RetirePlan {
  plan_hash: string
  blockers: PlanLine[]
  warnings: PlanLine[]
  lines: Record<RetireStepKey, string[]>
}

export interface StepLogLine {
  at: string
  by: string | null
  what: string
  note: string | null
}

export interface RetireStep {
  key: RetireStepKey
  label: string
  state: RetireStepState
  signed_off_by: string | null
  signed_off_at: string | null
  sign_note: string | null
  started_at: string | null
  finished_at: string | null
  note: string | null
  detail: Record<string, unknown>
  log: StepLogLine[]
}

export interface Retirement {
  id: number
  app_id: number
  status: RetireStatus
  step: string | null
  steps: RetireStep[]
  plan: RetirePlan | null
  notice: string | null
  checklists: Record<string, number>
  error: string | null
  heartbeat_at: string | null
  started_by: string | null
  created_at: string | null
  finished_at: string | null
  /** What each step does, in plain sentences (from the plan). */
  lines: Record<RetireStepKey, string[]> | null
  next_step: RetireStepKey | null
  undo_step: RetireStepKey | null
  cancellable: boolean
}

export interface SignOff {
  note?: string
  confirm?: string
  manual?: number[]
  skip?: Array<{ environment_id: number; what: 'db' | 'files' }>
  reason?: string
  notice?: string
  checklist_runs?: Record<string, number>
}

export const lifecycleKeys = {
  all: ['hub', 'lifecycle'] as const,
  clones: () => ['hub', 'lifecycle', 'clones'] as const,
  retirements: () => ['hub', 'lifecycle', 'retirements'] as const,
  retirement: (id: number) => ['hub', 'lifecycle', 'retirement', id] as const,
  plan: (appId: number) => ['hub', 'lifecycle', 'plan', appId] as const
}

export const fetchClones = () =>
  api.get<{ data: CloneRow[] }>('/hub/lifecycle/clones').then((r) => r.data.data ?? [])

export const captureClone = (envId: number) =>
  api
    .post<{ data: { clone: CloneRow; template: { id: number; name: string; version: string } } }>(
      `/hub/environments/${envId}/clone`,
      {}
    )
    .then((r) => r.data.data)

export const fetchRetirements = () =>
  api.get<{ data: Retirement[] }>('/hub/retirements').then((r) => r.data.data ?? [])

export const fetchRetirement = (id: number) =>
  api.get<{ data: Retirement }>(`/hub/retirements/${id}`).then((r) => r.data.data)

export const fetchRetirePlan = (appId: number) =>
  api.post<{ data: RetirePlanView }>(`/hub/apps/${appId}/retire/plan`, {}).then((r) => r.data.data)

export const openRetirement = (appId: number, planHash: string, notice: string) =>
  api
    .post<{ data: Retirement }>(`/hub/apps/${appId}/retire`, {
      plan_hash: planHash,
      ...(notice.trim() ? { notice: notice.trim() } : {})
    })
    .then((r) => r.data.data)

export const startRetireStep = (id: number, step: RetireStepKey, body: SignOff) =>
  api
    .post<{ data: Retirement }>(`/hub/retirements/${id}/steps/${step}`, body)
    .then((r) => r.data.data)

export const retirementAction = (id: number, action: 'undo' | 'cancel' | 'resume') =>
  api.post<{ data: Retirement }>(`/hub/retirements/${id}/${action}`, {}).then((r) => r.data.data)

/** Plain words for every code the lifecycle routes answer (admin hubError falls back to these). */
export const LIFECYCLE_COPY: Record<string, { title: string; hint?: string }> = {
  PLAN_STALE: {
    title: 'The app changed since the plan was read',
    hint: 'Read the plan again (or, for an open retirement, cancel it and open a new one).'
  },
  PLAN_BLOCKED: { title: 'Something stops this retirement now', hint: 'See the plan’s blockers.' },
  PLAN_MISSING: { title: 'This retirement has no plan', hint: 'Cancel it and open a new one.' },
  RETIRE_OPEN: { title: 'This app already has an open retirement', hint: 'Continue or cancel it.' },
  APP_ARCHIVED: { title: 'This app is retired already' },
  RETIRE_RUNNING: { title: 'A step is running', hint: 'Wait for it to finish.' },
  RETIRE_INTERRUPTED: {
    title: 'A step stopped half-way',
    hint: 'The Hub process running it went away. Resume continues it.'
  },
  RETIRE_CLOSED: { title: 'This retirement is closed' },
  RETIRE_CHANGED: { title: 'The retirement changed a moment ago', hint: 'Look at it again.' },
  STEP_OUT_OF_ORDER: { title: 'Steps go in order', hint: 'Sign off the next step first.' },
  BAD_STEP: { title: 'No such step' },
  CONFIRM_REQUIRED: { title: 'Type the app key to confirm' },
  MANUAL_NEEDED: {
    title: 'Some environments need your word',
    hint: 'The Hub cannot reach them: do it by hand, tick them and say how in the note.'
  },
  NOTE_REQUIRED: { title: 'Say in the note how you did it by hand' },
  BAD_NOTE: { title: 'The note is too long', hint: 'At most 1000 characters.' },
  BAD_NOTICE: { title: 'The notice is too long', hint: 'At most 2000 characters.' },
  EXPORT_INCOMPLETE: {
    title: 'Some parts cannot be backed up',
    hint: 'Set them up on Backups & data, or skip them with a reason.'
  },
  REASON_REQUIRED: {
    title: 'Say why the skipped parts need no backup',
    hint: 'At least 10 characters.'
  },
  EXPORT_FAILED: { title: 'A backup did not finish', hint: 'Check Backups & data, then Retry.' },
  EXPORT_TIMEOUT: {
    title: 'The backups did not finish within 24 hours',
    hint: 'Resume keeps waiting.'
  },
  LINK_MISSING: {
    title: 'The Hub cannot reach the app’s hub link',
    hint: 'Check its address and hub token on the app page.'
  },
  LOCKED: {
    title: 'A promotion or stack action holds an environment',
    hint: 'Retry when it ends.'
  },
  STACK_NOT_OURS: {
    title: 'The stack on the agent is not this app’s',
    hint: 'Nothing was removed. Check the environment’s placement.'
  },
  NOT_UNDOABLE: {
    title: 'Nothing to undo',
    hint: 'No step is done, or the removal has started (it cannot be undone).'
  },
  NOT_CANCELLABLE: {
    title: 'The removal has started',
    hint: 'It cannot be undone: finish the retirement.'
  },
  NOT_RESUMABLE: { title: 'Nothing to resume' },
  FROZEN: {
    title: 'A freeze stops this step',
    hint: 'An incident or a freeze window holds the app; the retirement waits for it to end.'
  },
  OUTSIDE_WINDOW: { title: 'Outside the app’s deploy window', hint: 'Try again when it opens.' },
  WINDOW_INVALID: { title: 'A deploy window cannot be read', hint: 'Fix it on the Changes tab.' },
  FREEZE_UNKNOWN: { title: 'The Hub could not read its freezes', hint: 'Try again shortly.' },
  CHECKLIST_REQUIRED: { title: 'Tick the retire checklist first' },
  CHECKLIST_INCOMPLETE: { title: 'Tick the required checklist items first' },
  CHECKLIST_MISMATCH: { title: 'That checklist was ticked for another start' },
  CHECKLIST_USED: { title: 'That checklist already started a run', hint: 'Tick a new one.' },
  CHECKLIST_UNKNOWN: { title: 'The Hub could not read the checklist', hint: 'Try again shortly.' },
  CREATION_OPEN: { title: 'An environment is still being created' },
  SOURCE_TOO_OLD: {
    title: 'The app runs a version without the structure export',
    hint: 'Copying needs Nivaro 0.3.215 or later on it.'
  },
  SOURCE_UNREACHABLE: { title: 'The app did not answer' },
  SOURCE_REFUSED: {
    title: 'The app refused the Hub on its link',
    hint: 'Check its HUB_TOKEN on the app page.'
  },
  SOURCE_TOO_LARGE: { title: 'The app answered with more than 10 MB' },
  SOURCE_BAD_ANSWER: { title: 'The app answered with something that is not a blueprint' },
  SOURCE_SAID_NO: { title: 'The app did not export its structure' },
  LINK_NOT_SET: { title: 'The shared deployment’s link is not set up in the Hub' },
  BAD_BASE_URL: { title: 'The app’s address is not one the Hub sends its token to' },
  HUB_TOKEN_MISSING: { title: 'The Hub holds no hub token for this environment' },
  ENV_ARCHIVED: { title: 'An archived environment has nothing to copy' },
  NOTHING_TO_CLONE: { title: 'The app has no collections of its own' },
  TOO_LARGE: { title: 'The structure is larger than the 8 MB a template holds' },
  TOO_MANY_PARTS: { title: 'The structure is larger than a template may hold' },
  BAD_SHAPE: { title: 'The structure could not be read as a blueprint' },
  NO_ENVIRONMENTS: {
    title: 'The app has no live environment',
    hint: 'Only its Hub record is archived.'
  },
  NO_LINK: {
    title: 'An environment has no hub link',
    hint: 'The Hub cannot freeze it or post the notice there: do it by hand and tick it at sign-off.'
  },
  TEMPLATE_EXISTS: { title: 'A copy with that name and version is in the library already' }
}

/** Step state → the run track's state. */
export const TRACK_STATE = {
  pending: 'pending',
  running: 'running',
  done: 'done',
  failed: 'failed',
  interrupted: 'stopped'
} as const

export const STATUS_WORDS: Record<RetireStatus, string> = {
  open: 'Waiting for a sign-off',
  running: 'Running',
  interrupted: 'Stopped — resume it',
  done: 'Retired',
  cancelled: 'Cancelled'
}

/**
 * describeError for the lifecycle routes: the Hub's words for the code as the title, and the
 * server's own sentence (it names the environment, the freeze, the step) as the hint when it is a
 * plain sentence.
 */
export function lifecycleError(err: unknown, fallback: string): ErrorDescription {
  const d = hubError(err, fallback)
  const copy = d.code ? LIFECYCLE_COPY[d.code] : undefined
  if (!copy) return d
  const said = (err as { response?: { data?: { error?: unknown } } })?.response?.data?.error
  const sentence =
    typeof said === 'string' && said.trim() && !isRawErrorText(said) ? said.trim() : null
  const out: ErrorDescription = { ...d, title: copy.title }
  const hint = sentence && sentence !== copy.title ? sentence : copy.hint
  if (hint) out.hint = hint
  else delete out.hint
  return out
}

export function lifecycleToast(err: unknown, fallback: string) {
  const d = lifecycleError(err, fallback)
  toast.error(d.title, errorToastOptions(d))
}
