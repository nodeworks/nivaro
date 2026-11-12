import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  GitBranch,
  Loader2,
  Minus,
  Search,
  Send,
  Undo2,
  UserPlus,
  Users,
  X,
  Zap
} from 'lucide-react'
import {
  type CSSProperties,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { toast } from 'sonner'
import { useItemEditAuth, useNivaroClient } from '../../context'
import { del, get, post } from '../../lib/commands'
import { errorToastOptions, toastError } from '../../lib/error-toast'
import { OPEN_MOVE_STATE_EVENT, type OpenMoveStateRequest } from '../../lib/move-state'
import {
  signalSentence,
  useRecordSignalPeers,
  useRecordSignalWhile
} from '../../lib/presence-signals'
import { RUN_TRANSITION_EVENT, type RunTransitionRequest } from '../../lib/run-transition'
import { userErrorMessage } from '../../lib/safe-error'
import { serverNow } from '../../lib/server-clock'
import { userCardQuery } from '../../lib/user-cards'
import {
  cn,
  formatDateTime,
  formatRelative,
  humanHours,
  titleCase,
  toLocalDateString
} from '../../lib/utils'
import { PushReadinessChip } from '../integrations/RecordIntegrationPreview'
import { useHeaderFold } from '../item-edit/HeaderTools'
import { invalidateRecordData, invalidateRecordInsights } from '../item-edit/RecordInsights'
import { UserChip } from '../item-edit/UserChip'
import { OwnerAvatars } from '../queue/OwnerAvatars'
import { UserAvatar } from '../UserAvatar'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Skeleton } from '../ui/skeleton'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip'
import { deniedToastAction, isAccessRefusal, WhyOwnersButton } from './AccessInsights'
import { BranchLanes, type BranchLanesData } from './BranchLanes'
import { joinLabels, landingSkipGroups, landingState } from './landing-state'
import {
  distinctAdvisories,
  type MoveAdvisory,
  MoveAdvisoryNotice,
  REFUSAL_FIX_ACTIONS,
  useRecordFixAction
} from './MoveAdvisory'
import { MoveToStatePanel } from './MoveToStatePanel'
import { SlaClockLine } from './SlaClock'
import type { TransitionRequirementsPayload } from './TransitionRequirementsDialog'

// Opens only when a transition needs answers first; loads then.
const TransitionRequirementsDialog = lazy(() =>
  import('./TransitionRequirementsDialog').then((m) => ({
    default: m.TransitionRequirementsDialog
  }))
)

// ─── Types ────────────────────────────────────────────────────────────────────

interface PipelineState {
  id: string
  key: string
  label: string
  color: string | null
  sort: number
  is_initial: boolean
  is_terminal: boolean
  stage_visibility?: string | null
  description?: string | null
}
interface PipelineTransition {
  id: string
  label: string
  color: string | null
  to_state: string
  from_state: string | null
  group_label: string | null
  condition_rules?: unknown[]
  /** How many partner pushes the transition carries (#616) — the header
   *  pre-flights only these. */
  pushes?: number
  /** Partners this move places an ORDER with (blocking pushes) — styled apart
   *  from approvals and always confirmed, naming the partner (army 11 a2 F2). */
  order_partners?: string[]
  /** What a registered check would answer if this move were pressed now — shown
   *  beside the move before it is (MoveAdvisory.tsx). */
  advisory?: MoveAdvisory | null
}
interface PipelineHistoryEntry {
  id: number
  from_state: string | null
  to_state: string
  from_state_label: string
  to_state_label: string
  from_state_color: string | null
  to_state_color: string | null
  user_email: string | null
  first_name: string | null
  last_name: string | null
  comment: string | null
  timestamp: string
  /** The transition row id — null on rows the engine wrote itself. */
  transition?: string | null
  /** The transition that made the move (label + its people-facing sentence). */
  transition_label?: string | null
  transition_text?: string | null
  /** person | machine | import | integration — who kind of actor moved it. */
  origin?: string | null
  /** #645 — a delegate's move: the out-of-office owner they stood in for. */
  on_behalf_of?: string | null
  on_behalf_of_name?: string | null
}

/** "Kim Lee, for Beth Ross" when a delegate moved it for an out-of-office owner. */
function withBehalf(name: string | null | undefined, h: PipelineHistoryEntry): string {
  const base = name || 'System'
  return h.on_behalf_of_name ? `${base}, for ${h.on_behalf_of_name}` : base
}

/** The split/join engine writes JSON into `comment` (routes/workflows.ts) —
 *  say what happened instead of quoting it. Only rows the engine wrote (no
 *  transition): a person's typed comment always rides a transition row and
 *  is quoted as written. Null for anything else. */
function lifecycleNote(h: Pick<PipelineHistoryEntry, 'comment' | 'transition'>): string | null {
  if (h.transition) return null
  const s = (h.comment ?? '').trim()
  if (!s.startsWith('{')) return null
  try {
    const c = JSON.parse(s) as { action?: string; children?: unknown[] }
    if (c.action === 'split')
      return `Split into ${Array.isArray(c.children) ? c.children.length : 'parallel'} branches`
    if (c.action === 'join') return 'Every branch finished — joined'
    if (c.action === 'branch') return 'Started as a parallel branch'
  } catch {
    // not engine JSON
  }
  return null
}

/** A move nobody made by hand: the engine, an import, or an integration. */
function isMachineEntry(h: PipelineHistoryEntry): boolean {
  if (h.first_name || h.last_name || h.user_email) return false
  return true
}

/** "Moved automatically", "Imported", "Synced from another system" — what stood in for a person. */
function machineHeadline(h: PipelineHistoryEntry): string {
  const stamp = (h.comment ?? '').trim().toLowerCase()
  if (h.origin === 'import' || stamp.startsWith('import:')) return 'Imported'
  if (h.origin === 'integration') return 'By an integration'
  if (/-state-sync$/.test(stamp) || stamp.startsWith('legacy-')) return 'Synced from another system'
  if (stamp === 'state-merge' || stamp === 'instance-migration') return 'Moved by an admin script'
  return 'Moved automatically'
}

/** The rule behind an automatic move: the transition's own sentence, else its label. */
function machineDetail(h: PipelineHistoryEntry): string | null {
  if (h.transition_text) return h.transition_text
  if (h.transition_label) return `Rule: ${h.transition_label}`
  const stamp = (h.comment ?? '').trim()
  const auto = /^auto: (.+)$/i.exec(stamp)
  if (auto) return `Rule: ${auto[1]}`
  if (/-state-sync$/i.test(stamp))
    return 'The state was copied in from the system that owned this record'
  if (/^instance-migration/i.test(stamp)) return 'Moved when the pipeline was reshaped'
  if (/^state-merge/i.test(stamp)) return 'Moved when two states were merged'
  return null
}
interface PipelineInstance {
  id: string
  current_state: string
  current_state_obj: PipelineState | null
  completed_at: string | null
}
interface PipelineInstanceOwner {
  id: number
  user: string
  first_name: string | null
  last_name: string | null
  email: string
  state: string | null
}
interface PipelinePanelData {
  instance: PipelineInstance | null
  states: PipelineState[]
  available_transitions: PipelineTransition[]
  all_transitions: PipelineTransition[]
  history: PipelineHistoryEntry[]
  binding: { id: number; template: string; collection: string; state_field: string | null } | null
  /** Parallel branches of the most recent split, drawn as lanes (#1240). */
  branches?: BranchLanesData | null
  /** Automatic transitions the engine stopped re-firing (#1217): their push
   *  was refused and nothing they would send has changed since. */
  auto_held?: HeldAutoTransition[]
  /** Highlight rules this record matches ("On hold", "Sent back"). */
  flags?: RecordFlag[]
}
interface RecordFlag {
  name: string
  color: string
}
interface HeldAutoTransition {
  transition_id: string
  transition_label: string | null
  error_class: string | null
  error: string | null
  attempts: number
  first_failed_at: string
  last_failed_at: string
  retry_at: string | null
}

const ERROR_CLASS_TEXT: Record<string, string> = {
  validation: 'the partner refused what we sent',
  not_found: 'the partner could not find what we referred to',
  auth: 'the partner refused our credentials',
  transient: 'the partner could not be reached',
  rate_limited: 'the partner asked us to slow down',
  unknown: 'the partner refused it'
}

/** "in 25 min" / "in 2h" / "on the next check" for a ladder retry time. */
function retryWhen(iso: string): string {
  const mins = Math.ceil((new Date(iso).getTime() - serverNow()) / 60_000)
  if (!Number.isFinite(mins) || mins <= 0) return 'on the next check'
  if (mins < 60) return `in ${mins} min`
  return `in ${Math.round(mins / 60)}h`
}

/** The "needs a person" strip for held automatic transitions (#1217). */
function AutoHeldNotice({ held }: { held: HeldAutoTransition[] }) {
  if (held.length === 0) return null
  return (
    <div
      className='space-y-2 border-b border-amber-100 bg-amber-50 px-5 py-3 dark:border-amber-500/20 dark:bg-amber-500/10'
      data-pipeline-auto-held
    >
      {held.map((h) => {
        const label = h.transition_label ?? 'An automatic move'
        const why = ERROR_CLASS_TEXT[h.error_class ?? 'unknown'] ?? ERROR_CLASS_TEXT.unknown
        return (
          <div key={h.transition_id} className='text-[12px] text-amber-800 dark:text-amber-300'>
            <p className='font-medium'>
              Needs a person: {label} stopped retrying — {why}.
            </p>
            {h.error && (
              <p
                className='mt-0.5 line-clamp-2 break-words text-[11px] text-amber-700/90 dark:text-amber-300/80'
                data-tip={h.error}
              >
                {h.error}
              </p>
            )}
            <p className='mt-1 text-[11px] text-amber-700 dark:text-amber-400'>
              {h.retry_at
                ? `It tries the same push again ${retryWhen(h.retry_at)}. `
                : 'It will not send the same push again on its own. '}
              Fix the record so what it sends changes, retry the push, or move the record by hand.
              {h.attempts > 1 ? ` ${h.attempts} attempts so far.` : ''}
            </p>
          </div>
        )
      })}
    </div>
  )
}
interface RequirementsDialogState {
  payload: TransitionRequirementsPayload
  transitionId: string
  comment?: string
  /** Bumped on every 422 payload (initial and retry) — keys the dialog so a
   *  retry's fresh payload remounts it with reseeded state; >1 means retry. */
  revision: number
}

// Shared by both executeTransition mutations below: pulls the 422 requirements
// payload out of a failed transition request, or null when the failure is
// something else (409 conflict, permission error, etc).
/** 409 TRANSITION_DUPLICATE — the server refused a second copy of a decision
 *  it is already applying. Either client error shape (SDK / axios). */
export function isDuplicateTransition(err: unknown): boolean {
  const resp = (err as { response?: { code?: unknown; data?: { code?: unknown } } } | null)
    ?.response
  return (resp?.code ?? resp?.data?.code) === 'TRANSITION_DUPLICATE'
}

export function transitionRequirementsFromError(
  err: unknown
): TransitionRequirementsPayload | null {
  const e = err as {
    status?: number
    response?: { error?: string; requirements?: TransitionRequirementsPayload }
  }
  if (e?.status === 422 && e.response?.error === 'TRANSITION_REQUIREMENTS') {
    return e.response.requirements ?? []
  }
  return null
}

/** The refusal code of a failed request, either client error shape (SDK / axios). */
export function refusalCode(err: unknown): string | null {
  const resp = (err as { response?: { code?: unknown; data?: { code?: unknown } } } | null)
    ?.response
  const code = resp?.code ?? resp?.data?.code
  return typeof code === 'string' ? code : null
}

/**
 * A move refused because someone else is editing the record right now
 * (409 RECORD_LOCKED with `move_anyway`, api record-transition.ts): the plain
 * reason to show and that it may be done anyway. Null for anything else.
 */
export function lockedMoveOffer(err: unknown): { message: string; holder: string | null } | null {
  if (refusalCode(err) !== 'RECORD_LOCKED') return null
  const resp = (err as { response?: Record<string, unknown> & { data?: Record<string, unknown> } })
    ?.response
  const body = (resp?.data && typeof resp.data === 'object' ? resp.data : resp) as
    | Record<string, unknown>
    | undefined
  if (body?.move_anyway !== true) return null
  const holder = typeof body.locked_by_name === 'string' ? body.locked_by_name : null
  const message =
    typeof body.error === 'string' && body.error.trim()
      ? body.error
      : `${holder ?? 'Someone else'} is editing this record right now.`
  return { message, holder }
}

// The refusal code → fix action map lives with the advisory notice (MoveAdvisory.tsx).
export { REFUSAL_FIX_ACTIONS }

export interface RefusalFixOffer {
  code: string
  actionKey: string
  transitionId: string
  comment?: string
}

/** The fix offer for a failed transition, or null. */
export function refusalFixFor(
  err: unknown,
  vars: { transition_id: string; comment?: string }
): RefusalFixOffer | null {
  const code = refusalCode(err)
  const resp = (
    err as { response?: { fix?: { action?: unknown }; data?: { fix?: { action?: unknown } } } }
  )?.response
  // The check may name the action that clears its refusal; the code map is the fallback.
  const named = resp?.fix?.action ?? resp?.data?.fix?.action
  const actionKey =
    (typeof named === 'string' && named.trim()) || (code ? REFUSAL_FIX_ACTIONS[code] : undefined)
  if (!code || !actionKey) return null
  return { code, actionKey, transitionId: vars.transition_id, comment: vars.comment }
}

/** How long the buttons stay off after the record's pipeline read came back. */
const SETTLE_BEAT_MS = 600

/**
 * After a move lands, the transition buttons stay off until the record's
 * pipeline read has come back, plus a beat. An admin owns every step, so the
 * NEXT step's Approve appeared in the same spot at once and a double click
 * approved two steps (army4 a15-8).
 */
function useTransitionSettle(queryKey: readonly unknown[]) {
  const queryClient = useQueryClient()
  const [settling, setSettling] = useState(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const keyRef = useRef(queryKey)
  keyRef.current = queryKey
  const settle = useCallback(async () => {
    setSettling(true)
    try {
      await queryClient.refetchQueries({ queryKey: [...keyRef.current], type: 'active' })
    } catch {
      /* the beat below still applies */
    }
    await new Promise((r) => setTimeout(r, SETTLE_BEAT_MS))
    if (alive.current) setSettling(false)
  }, [queryClient])
  return { settling, settle }
}

/** How long a button that newly appeared in the transition slot stays inert. */
export const FRESH_BUTTON_MS = 1500
/** The hover rule's end: past this a press always goes through, pointer or not.
 *  A pointer that never moves (the person waited on the spot, a keyboard press,
 *  an assistive click) left the next step's button dead until a reload (army 11
 *  a1 F-12: "Fusion Submitted did nothing" four times over a minute). */
export const FRESH_HOVER_MAX_MS = 4000

/**
 * Buttons that appear in the transition slot after the panel first showed its
 * moves (the next step's "Submit to Warehouse" landing where "Approve" was, about
 * a second after the approve) are inert for FRESH_BUTTON_MS, and — when the
 * pointer was on them in that window — until it has left and come back. A double
 * click on Approve can no longer press the step after it (army6 M19, army4 a15-8).
 * Keyed by transition id; the first answer for a record is the baseline.
 */
export class FreshButtonGuard {
  private seen: Set<string> | null = null
  private fresh = new Map<string, { at: number; hovered: boolean; left: boolean }>()

  /** Feed the ids on offer now. */
  observe(ids: readonly string[], now: number): void {
    const next = new Set(ids.map((id) => String(id).toUpperCase()))
    if (this.seen)
      for (const id of next)
        if (!this.seen.has(id)) this.fresh.set(id, { at: now, hovered: false, left: false })
    for (const id of [...this.fresh.keys()]) if (!next.has(id)) this.fresh.delete(id)
    this.seen = next
  }

  /** The pointer is on the button. */
  enter(id: string, now: number): void {
    const f = this.fresh.get(String(id).toUpperCase())
    if (f && !f.left && now - f.at < FRESH_BUTTON_MS) f.hovered = true
  }

  /** The pointer left the button. */
  leave(id: string): void {
    const f = this.fresh.get(String(id).toUpperCase())
    if (f?.hovered) f.left = true
  }

  /** Still inert (no state change)? */
  inert(id: string, now: number): boolean {
    const f = this.fresh.get(String(id).toUpperCase())
    if (!f) return false
    if (now - f.at >= FRESH_HOVER_MAX_MS) return false
    return now - f.at < FRESH_BUTTON_MS || (f.hovered && !f.left)
  }

  /** A press: true = let it through. A press inside the window counts as the pointer being there. */
  press(id: string, now: number): boolean {
    const key = String(id).toUpperCase()
    const f = this.fresh.get(key)
    if (!f) return true
    if (now - f.at < FRESH_BUTTON_MS) {
      f.hovered = true
      f.left = false
      return false
    }
    if (f.hovered && !f.left && now - f.at < FRESH_HOVER_MAX_MS) return false
    this.fresh.delete(key)
    return true
  }

  /** Inside its time window (drawn dimmed)? */
  timed(id: string, now: number): boolean {
    const f = this.fresh.get(String(id).toUpperCase())
    return !!f && now - f.at < FRESH_BUTTON_MS
  }

  /** Any button still inside its time window? */
  hasTimed(now: number): boolean {
    for (const f of this.fresh.values()) if (now - f.at < FRESH_BUTTON_MS) return true
    return false
  }

  reset(): void {
    this.seen = null
    this.fresh.clear()
  }
}

/** Binds a FreshButtonGuard to a record's transition list (see FreshButtonGuard). */
function useFreshTransitions(
  ids: readonly string[] | null,
  recordKey: string
): {
  /** Drawn dimmed: inside the time window (the hover rule has no look of its own). */
  dimmed: (id: string) => boolean
  press: (id: string) => boolean
  bind: (id: string) => {
    onPointerEnter: () => void
    onPointerMove: () => void
    onPointerLeave: () => void
  }
} {
  const guardRef = useRef<FreshButtonGuard | null>(null)
  if (!guardRef.current) guardRef.current = new FreshButtonGuard()
  const guard = guardRef.current
  const recordRef = useRef(recordKey)
  if (recordRef.current !== recordKey) {
    recordRef.current = recordKey
    guard.reset()
  }
  const [, setTick] = useState(0)
  const sig = ids ? ids.join(',') : null
  // biome-ignore lint/correctness/useExhaustiveDependencies: sig is the ids' content
  useMemo(() => {
    if (ids) guard.observe(ids, Date.now())
  }, [guard, sig])
  // Re-render once the window ends so the dimmed look goes away.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sig is the ids' content
  useEffect(() => {
    if (!guard.hasTimed(Date.now())) return
    const t = setTimeout(() => setTick((n) => n + 1), FRESH_BUTTON_MS + 20)
    return () => clearTimeout(t)
  }, [guard, sig])
  return {
    dimmed: (id) => guard.timed(id, Date.now()),
    press: (id) => guard.press(id, Date.now()),
    bind: (id) => ({
      onPointerEnter: () => guard.enter(id, Date.now()),
      onPointerMove: () => guard.enter(id, Date.now()),
      onPointerLeave: () => guard.leave(id)
    })
  }
}

type BriefLineView = { label: string; text: string; tone?: 'ok' | 'warn' | 'danger' | 'neutral' }
type ApprovalBriefData = {
  entered_at: string
  days_in_state: number
  revisions: number
  /** `auto`: a value the record derives itself (a built title), not typed by the editor. */
  field_changes: Array<{
    field: string
    label?: string
    old?: unknown
    new: unknown
    auto?: boolean
  }>
  changed_total: number
  changed_by_people?: number
  comments: number
  addendums: { count: number; cost_impact: number }
  edited_by: string[]
  lines?: BriefLineView[]
} | null

function approvalBriefKey(collection: string, item: string | number) {
  return ['approval-brief', collection, String(item)] as const
}

function fetchApprovalBrief(
  client: ReturnType<typeof useNivaroClient>,
  collection: string,
  item: string | number
): Promise<ApprovalBriefData> {
  return client
    .request<{ data: ApprovalBriefData }>(
      get(`/pipelines/instance/${collection}/${item}/approval-brief`)
    )
    .then((r) => r.data)
}

/** Brief lines that make a forward move ask first (army6 D6): tone warn or danger. */
export function briefWarnings(lines: BriefLineView[] | null | undefined): BriefLineView[] {
  return (lines ?? []).filter((l) => l.tone === 'warn' || l.tone === 'danger')
}

/** One brief line's identity — the strip and the amber warning say a line once. */
export function briefLineKey(l: Pick<BriefLineView, 'label' | 'text'>): string {
  return `${(l.label ?? '').trim().toLowerCase()}|${(l.text ?? '').trim().toLowerCase()}`
}

/** "today" / "1 day ago" / "12 days ago" — never "0d ago". */
export function briefAgeText(days: number | null | undefined): string {
  const d = Math.max(0, Math.floor(Number(days) || 0))
  if (d === 0) return 'today'
  return d === 1 ? '1 day ago' : `${d} days ago`
}

/**
 * Old / new values of one change, cut to `max` characters around where they
 * first differ: "…f4 lock test A S1 B…" vs "…f4 lock test A S1 B4" instead of
 * two identical "BT26CM 202014 ARMY11 Sudharsan f4 lo…". An empty old value
 * (the field was blank) reads "(empty)"; `old: null` = there was no old value.
 */
export function briefDiffPair(
  oldV: unknown,
  newV: unknown,
  max = 40
): { old: string | null; new: string } {
  const text = (v: unknown) => (v === null || v === undefined || v === '' ? '' : String(v))
  const a = text(oldV)
  const b = text(newV)
  const shown = (s: string) => (s === '' ? '(empty)' : s)
  if (oldV === undefined) return { old: null, new: cut(shown(b), 0, max) }
  if (a.length <= max && b.length <= max) return { old: shown(a), new: shown(b) }
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  const start = p > max / 2 ? p - Math.floor(max / 3) : 0
  return { old: cut(shown(a), start, max), new: cut(shown(b), start, max) }
}

function cut(s: string, start: number, max: number): string {
  const from = Math.min(start, Math.max(0, s.length - max))
  const body = s.slice(from, from + max)
  return `${from > 0 ? '…' : ''}${body}${from + max < s.length ? '…' : ''}`
}

/** How long a forward move waits for the brief before it goes on without it. */
const BRIEF_CHECK_MS = 4000

/**
 * Before a forward move with no note, read the record's approval brief: a line
 * that warns (forecast over or short of the requisition) opens the confirm panel
 * with "<move> anyway" — a warning, never a block. A brief that fails or is slow
 * lets the move go on in one click, as before.
 */
function useForwardMoveCheck(collection: string, item: string) {
  const client = useNivaroClient()
  const queryClient = useQueryClient()
  return useCallback(async (): Promise<BriefLineView[]> => {
    try {
      const data = await Promise.race([
        queryClient.fetchQuery({
          queryKey: approvalBriefKey(collection, item),
          queryFn: () => fetchApprovalBrief(client, collection, item),
          staleTime: 0,
          retry: false
        }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), BRIEF_CHECK_MS))
      ])
      return briefWarnings(data?.lines)
    } catch {
      return []
    }
  }, [client, queryClient, collection, item])
}

/** The amber "check before you go on" block of a confirm panel opened by a brief warning. */
function ForwardMoveWarning({ lines }: { lines: BriefLineView[] }) {
  if (lines.length === 0) return null
  return (
    <div
      data-forward-warning
      className='rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
    >
      {lines.map((l) => (
        <p key={`${l.label}:${l.text}`}>
          <span className='font-semibold'>{l.label ? `${l.label}: ` : ''}</span>
          {l.text}
        </p>
      ))}
      <p className='mt-1 text-[11.5px] text-amber-700/90 dark:text-amber-200/80'>
        Check this before you go on. You can still continue.
      </p>
    </div>
  )
}

/** A transition that goes to a step sorting BEFORE the current one (a send back). */
function isSendBack(
  tx: Pick<PipelineTransition, 'to_state'>,
  states: Array<Pick<PipelineState, 'id' | 'sort'>>,
  currentStateId: string | null | undefined
): boolean {
  if (!currentStateId) return false
  const cur = states.find(
    (st) => String(st.id).toUpperCase() === String(currentStateId).toUpperCase()
  )
  const to = states.find((st) => String(st.id).toUpperCase() === String(tx.to_state).toUpperCase())
  return !!cur && !!to && to.sort < cur.sort
}

/**
 * Moves that always stop and ask, whatever their note setting: a move into a
 * finished state (PO Received → Completed closed a $60,000 request in one
 * click, army 11 a1 F-11) and a move that places a partner order (a2 F2).
 * Send backs and cancels keep their own rules.
 */
export function asksFirst(
  tx: Pick<PipelineTransition, 'to_state' | 'order_partners'> | undefined,
  states: Array<Pick<PipelineState, 'id' | 'sort' | 'is_terminal' | 'key'>>,
  currentStateId: string | null | undefined
): boolean {
  if (!tx) return false
  if ((tx.order_partners?.length ?? 0) > 0) return true
  if (isSendBack(tx, states, currentStateId)) return false
  const to = states.find((st) => String(st.id).toUpperCase() === String(tx.to_state).toUpperCase())
  return !!to?.is_terminal && !/(^|_)cancel/i.test(String(to.key ?? ''))
}

const FLAG_TONE: Record<string, string> = {
  red: 'border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300',
  amber:
    'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300',
  yellow:
    'border-yellow-200 bg-yellow-50 text-yellow-800 dark:border-yellow-500/30 dark:bg-yellow-500/10 dark:text-yellow-300',
  green:
    'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300',
  blue: 'border-sky-200 bg-sky-50 text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-300',
  purple:
    'border-violet-200 bg-violet-50 text-violet-800 dark:border-violet-500/30 dark:bg-violet-500/10 dark:text-violet-300'
}

/** The record's highlight flags as chips beside its state in the Pipeline panel
 *  ("On hold"). Shown there only, not again in the header's action row. */
export function RecordFlagChips({ flags }: { flags?: RecordFlag[] | null }) {
  if (!flags || flags.length === 0) return null
  return (
    <>
      {flags.map((f) => (
        <span
          key={f.name}
          data-record-flag={f.name}
          className={cn(
            'inline-flex shrink-0 items-center gap-1 self-center rounded-full border px-2 py-0.5 text-[11px] font-semibold',
            FLAG_TONE[f.color] ?? FLAG_TONE.amber
          )}
        >
          <span className='h-1.5 w-1.5 rounded-full bg-current' aria-hidden />
          {f.name}
        </span>
      ))}
    </>
  )
}

/** A partner name as people say it ("Fusion IIP" → "Fusion"). */
function partnerName(api: string): string {
  return api.replace(/\s+IIP$/i, '')
}

/**
 * In the confirm of a move that places an order: which partner gets it for
 * THIS record (the pre-flight the button's chip already read) and that it
 * cannot be called back from here.
 */
function OrderSendNote({
  collection,
  item,
  tx
}: {
  collection: string
  item: string
  tx: Pick<PipelineTransition, 'id' | 'order_partners'> | null | undefined
}) {
  const client = useNivaroClient()
  const partners = tx?.order_partners ?? []
  const { data } = useQuery({
    queryKey: ['push-preflight', collection, item, 't', tx?.id ?? ''],
    queryFn: () =>
      client
        .request<{ data: { pushes?: Array<{ api_name: string; status: string }> } }>(
          get(`/integration-preview/${collection}/${encodeURIComponent(item)}/preflight`, {
            transition_id: tx?.id ?? ''
          })
        )
        .then((r) => r.data),
    enabled: partners.length > 0 && !!tx?.id,
    staleTime: 20_000
  })
  if (partners.length === 0) return null
  const sending = data?.pushes
    ? data.pushes
        .filter((p) => p.status === 'would_push' && partners.includes(p.api_name))
        .map((p) => partnerName(p.api_name))
    : null
  const names = [...new Set(sending ?? partners.map(partnerName))]
  return (
    <p
      data-order-send-note
      className='flex items-start gap-1.5 rounded-md border border-sky-200 bg-sky-50 px-2.5 py-1.5 text-[12px] text-sky-900 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200'
    >
      <Send className='mt-0.5 h-3.5 w-3.5 shrink-0' aria-hidden />
      {sending && sending.length === 0
        ? 'Nothing is sent to a partner for this record — it only moves the record on.'
        : `This places an order with ${names.join(' or ')}. It cannot be called back from here.`}
    </p>
  )
}

/** Is a send back on offer in these answers (decides whether the chain is read)? */
function hasSendBackOffer(
  data:
    | {
        states?: Array<Pick<PipelineState, 'id' | 'sort'>>
        instance?: { current_state?: string | null } | null
        available_transitions?: Array<Pick<PipelineTransition, 'to_state'>>
      }
    | null
    | undefined
): boolean {
  if (!data?.instance) return false
  return (data.available_transitions ?? []).some((t) =>
    isSendBack(t, data.states ?? [], data.instance?.current_state)
  )
}

/**
 * Send-back buttons whose target is a chain step this record SKIPPED (no owner, or its skip
 * rule matched) are hidden: pressing one parks the record on a step nobody works (b06-N6).
 * Forward moves and sends back to steps that were on the path stay. A return-to-previous
 * move (Uncancel) is never hidden: its target is only a fallback. Twin of the server's
 * api/src/services/send-back-skips.ts, which drops the same moves from the instance read
 * and refuses them (TARGET_SKIPPED) — change both.
 */
export function withoutSkippedSendBacks<
  T extends Pick<PipelineTransition, 'to_state'> & { to_previous?: unknown }
>(
  txs: T[],
  states: Array<Pick<PipelineState, 'id' | 'sort'>>,
  currentStateId: string | null | undefined,
  skipped: Map<string, string[]> | null | undefined
): T[] {
  if (!skipped || skipped.size === 0) return txs
  const skippedUp = new Set([...skipped.keys()].map((k) => String(k).toUpperCase()))
  return txs.filter(
    (t) =>
      !(
        !t.to_previous &&
        skippedUp.has(String(t.to_state).toUpperCase()) &&
        isSendBack(t, states, currentStateId)
      )
  )
}

/**
 * What a finished move says: "Submit — now Waiting on manager approval", not "Transition
 * executed" (b09-N9). When the answer's state is the one the record was already in, "Nothing
 * moved" (the move was a no-op: no owner, skipped, or a twin of an earlier press).
 */
export function transitionToastText(
  data:
    | {
        instance?: { current_state?: string | null } | null
        states?: Array<Pick<PipelineState, 'id' | 'label'>>
        available_transitions?: Array<Pick<PipelineTransition, 'id' | 'label' | 'to_state'>>
        all_transitions?: Array<Pick<PipelineTransition, 'id' | 'label' | 'to_state'>>
      }
    | null
    | undefined,
  transitionId: string,
  answer: unknown
): string {
  const tx = [...(data?.available_transitions ?? []), ...(data?.all_transitions ?? [])].find(
    (t) => t.id === transitionId
  )
  const body = (
    answer as {
      data?: {
        instance?: { current_state?: string | null }
        new_state?: { id?: string; label?: string } | null
      }
    } | null
  )?.data
  const newId = body?.new_state?.id ?? body?.instance?.current_state ?? null
  const toLabel =
    body?.new_state?.label ??
    (tx ? data?.states?.find((st) => st.id === tx.to_state)?.label : undefined) ??
    null
  const before = data?.instance?.current_state ?? null
  if (before && newId && String(before) === String(newId)) return 'Nothing moved'
  if (tx?.label && toLabel) return `${tx.label} — now ${toLabel}`
  if (toLabel) return `Moved to ${toLabel}`
  return tx?.label ? `${tx.label} done` : 'Transition executed'
}

/** A move that takes longer than this says it is working (army9 b06 N-AC: a
 *  Submit took ~5 s with nothing on screen, and the success toast was gone
 *  before the page settled). */
export const SLOW_MOVE_MS = 1200

/** "Submitting…" for a slow move: shown only past SLOW_MOVE_MS, then REPLACED
 *  by the result toast (same id) so the answer lands where the person is
 *  already looking, and stays a little longer. */
export function slowMoveToast(label: string | null | undefined) {
  const id = `nvr-move-${Math.random().toString(36).slice(2)}`
  let shown = false
  const timer = setTimeout(() => {
    shown = true
    toast.loading(`${label?.trim() || 'Moving'}…`, { id })
  }, SLOW_MOVE_MS)
  return {
    /** Options for the result toast: replaces the loading one when shown. */
    done: (): { id?: string; duration?: number } => {
      clearTimeout(timer)
      return shown ? { id, duration: 7000 } : {}
    },
    /** An error toast of its own follows — drop the loading one. */
    fail: () => {
      clearTimeout(timer)
      if (shown) toast.dismiss(id)
    }
  }
}

/** Header Owners tile + owner panels read these — a move changes who owns the record. */
function invalidateOwnerReads(
  queryClient: ReturnType<typeof useQueryClient>,
  collection: string,
  item: string
) {
  for (const head of [
    'pipeline-owners-resolved',
    'pipeline-instance-owners',
    'pipeline-all-owners'
  ])
    void queryClient.invalidateQueries({ queryKey: [head, collection, item] })
}

/**
 * The newest send back that put the record where it is now — shown while the
 * record still sits in the state it was sent back to, so the person who must
 * fix it reads why without opening the history (army4 a15-4). Only a person's
 * move with a note counts.
 */
export function latestSendBack(
  history: PipelineHistoryEntry[],
  currentStateId: string | null | undefined,
  states: Array<Pick<PipelineState, 'id' | 'sort'>>
): PipelineHistoryEntry | null {
  if (!currentStateId) return null
  const sortOf = new Map(states.map((st) => [String(st.id).toUpperCase(), st.sort]))
  const newest = [...history].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  )[0]
  if (!newest?.from_state) return null
  if (String(newest.to_state).toUpperCase() !== String(currentStateId).toUpperCase()) return null
  if (!newest.comment?.trim()) return null
  if (newest.origin && newest.origin !== 'person') return null
  const from = sortOf.get(String(newest.from_state).toUpperCase())
  const to = sortOf.get(String(newest.to_state).toUpperCase())
  // A send back lands on a step that sorts BEFORE the one it left.
  if (from == null || to == null || to >= from) return null
  return newest
}

/** The glyph on a move a registered check would refuse right now. */
function BlockedMark({ className }: { className?: string }) {
  return (
    <AlertTriangle
      aria-hidden
      data-move-blocked-mark
      className={cn('h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400', className)}
    />
  )
}

/** A blocked move says why before it is pressed: the check's words as its tip and description. */
function blockedMoveProps(tx: Pick<PipelineTransition, 'advisory'>) {
  return tx.advisory
    ? {
        'data-move-blocked': tx.advisory.code,
        'data-tip': tx.advisory.message,
        'aria-description': tx.advisory.message
      }
    : {}
}

function SendBackNotice({ entry }: { entry: PipelineHistoryEntry }) {
  const who =
    [entry.first_name, entry.last_name].filter(Boolean).join(' ') || entry.user_email || 'Someone'
  // A row of the Progress card, flush like its other rows: the note is what the person must act
  // on, so it leads; who sent it back and when follows, quieter.
  return (
    <div
      className='flex items-start gap-2.5 border-t border-amber-200/80 bg-amber-50/70 px-4 py-2.5 dark:border-amber-500/20 dark:bg-amber-500/[0.06]'
      data-send-back-notice
    >
      <Undo2
        aria-hidden
        className='mt-[3px] h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400'
      />
      <div className='min-w-0 flex-1'>
        <p className='whitespace-pre-line break-words text-[13px] leading-snug text-slate-800 dark:text-slate-100'>
          {entry.comment}
        </p>
        <p className='mt-0.5 text-[11.5px] text-amber-800/80 dark:text-amber-300/80'>
          Sent back by {withBehalf(who, entry)} · {formatRelative(entry.timestamp)}
        </p>
      </div>
    </div>
  )
}

/**
 * Inline fix for a refusal the caller can fix (REFUSAL_FIX_ACTIONS): runs the
 * registry action on this record (reason when it asks for one), then retries
 * the move. Renders nothing when the action is not offered to the caller.
 */
function RefusalFixPanel({
  collection,
  item,
  offer,
  onFixed,
  onDismiss,
  className,
  style
}: {
  collection: string
  item: string
  offer: RefusalFixOffer
  onFixed: () => void
  onDismiss: () => void
  /** Placement (the header variant floats it under the buttons). */
  className?: string
  style?: CSSProperties
}) {
  const [reason, setReason] = useState('')
  const { action, isLoading, run: runFix } = useRecordFixAction(collection, item, offer.actionKey)
  const run = useMutation({
    mutationFn: () => runFix(reason),
    onSuccess: () => {
      toast.success(`${action?.label ?? 'Done'} — trying again`)
      onFixed()
    },
    onError: (err) => toastError(err, `${action?.label ?? 'The fix'} failed`)
  })
  if (isLoading || !action) return null
  const canRun = !run.isPending && (!action.require_reason || reason.trim().length > 0)
  return (
    <div
      className={cn(
        'space-y-2 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-500/30 dark:bg-amber-950',
        className
      )}
      style={style}
      data-refusal-fix={offer.code}
    >
      <p className='text-[12px] text-amber-950 dark:text-amber-100'>
        You can fix this here: {action.label}, then the move is tried again.
      </p>
      {action.require_reason && (
        <input
          type='text'
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder='Reason (required)'
          aria-label='Reason'
          className='w-full rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[13px] placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-nvr-cyan/30 dark:border-border dark:bg-card'
        />
      )}
      <div className='flex items-center justify-end gap-2'>
        <Button
          type='button'
          size='sm'
          variant='ghost'
          className='h-7 text-[12px]'
          onClick={onDismiss}
        >
          Not now
        </Button>
        <Button
          type='button'
          size='sm'
          className='h-7 gap-1.5 text-[12px]'
          disabled={!canRun}
          onClick={() => run.mutate()}
        >
          {run.isPending && <Loader2 className='h-3 w-3 animate-spin' />}
          {action.label}, then try again
        </Button>
      </div>
    </div>
  )
}

// ─── State badge ──────────────────────────────────────────────────────────────

function StateBadge({
  label,
  color,
  small
}: {
  label: string
  color: string | null
  small?: boolean
}) {
  const size = small ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-[12px]'
  return (
    <span
      key={label}
      className={`nvr-state-pulse inline-flex items-center gap-1.5 rounded-full font-medium transition-colors duration-300 ${size}`}
      style={{
        backgroundColor: color ? `${color}22` : '#f1f5f9',
        color: color ?? '#475569',
        border: `1px solid ${color ? `${color}44` : '#e2e8f0'}`
      }}
    >
      {label}
    </span>
  )
}

// ─── State track ─────────────────────────────────────────────────────────────

/**
 * Time-in-step bar — where the record's calendar time actually went. Each
 * segment is one stay in a state (a send-back produces a second, separate
 * segment for the same state — deliberately honest), width proportional to
 * duration, ending at now for the current stay. Built purely from the history
 * the panel already fetched; no extra requests. Hidden until there are at
 * least two segments — a single open stay carries no comparison.
 */
function fmtDur(ms: number): string {
  const m = Math.floor(ms / 60000)
  if (m < 60) return `${Math.max(1, m)}m`
  return humanHours(ms / 3_600_000)
}

function StateDurationTimeline({
  history,
  completedAt
}: {
  history: PipelineHistoryEntry[]
  completedAt: string | null
}) {
  const ordered = [...history].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  )
  if (ordered.length === 0) return null
  const end = completedAt ? new Date(completedAt).getTime() : Date.now()
  const segments = ordered
    .map((h, i) => {
      const start = new Date(h.timestamp).getTime()
      const stop = i + 1 < ordered.length ? new Date(ordered[i + 1].timestamp).getTime() : end
      return {
        key: h.id,
        label: h.to_state_label,
        color: h.to_state_color,
        ms: Math.max(0, stop - start),
        current: i === ordered.length - 1 && !completedAt
      }
    })
    .filter((seg) => seg.ms > 0 || seg.current)
  if (segments.length < 2) return null
  const total = segments.reduce((sum, seg) => sum + seg.ms, 0)
  if (total <= 0) return null

  return (
    <div data-state-timeline>
      <div className='mb-1 flex items-center justify-between'>
        <p className='text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500'>
          Time in step
        </p>
        <p className='text-[10px] tabular-nums text-slate-400 dark:text-slate-500'>
          {fmtDur(total)} total{completedAt ? '' : ' · so far'}
        </p>
      </div>
      <div className='flex h-4 w-full overflow-hidden rounded'>
        {segments.map((seg) => {
          const pct = (seg.ms / total) * 100
          return (
            <div
              key={seg.key}
              data-tip={`${seg.label} — ${fmtDur(seg.ms)}${seg.current ? ' (current)' : ''}`}
              className='relative flex min-w-[8px] items-center overflow-hidden border-r border-white/60 last:border-r-0 dark:border-black/30'
              style={{
                width: `${pct}%`,
                backgroundColor: seg.color ? `${seg.color}55` : 'rgba(100,116,139,.25)'
              }}
            >
              {pct >= 14 && (
                <span className='truncate px-1.5 text-[9.5px] font-medium leading-none text-slate-700 dark:text-slate-200'>
                  {seg.label} · {fmtDur(seg.ms)}
                </span>
              )}
              {seg.current && (
                <span
                  className='absolute inset-y-0 right-0 w-[2px]'
                  style={{ backgroundColor: seg.color ?? '#64748b' }}
                />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function StateTrack({
  states,
  allTransitions,
  availableTransitions,
  currentStateId,
  history,
  onPathIds,
  skippedStates
}: {
  states: PipelineState[]
  allTransitions: PipelineTransition[]
  availableTransitions: PipelineTransition[]
  currentStateId: string | null
  history: PipelineHistoryEntry[]
  /** Server-computed relevant-state ids (condition-aware branch pruning from
   *  /owners/all). null while loading — the client BFS below is the fallback. */
  onPathIds?: Set<string> | null
  /** State id → why the engine will skip it. null while loading. */
  skippedStates?: Map<string, string[]> | null
}) {
  // A narrow host (a phone-width sheet) scrolls the track sideways instead of
  // crushing each step to one letter per line; the current step is brought
  // into view so the track still opens on where the record is.
  const scrollRef = useRef<HTMLDivElement>(null)
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-centres when the record moves to another step
  useEffect(() => {
    const el = scrollRef.current
    if (!el || el.scrollWidth <= el.clientWidth) return
    const cur = el.querySelector<HTMLElement>('[data-track-current]')
    if (!cur) return
    const box = el.getBoundingClientRect()
    const node = cur.getBoundingClientRect()
    el.scrollLeft += node.left + node.width / 2 - (box.left + box.width / 2)
  }, [currentStateId])
  const visitedIds = new Set(history.map((h) => h.to_state))
  // The initial state is never any transition's destination, so history alone
  // never marks it — leaving "Started" hollow on a record that plainly
  // started. Every record passed through it; the only time it is not done is
  // when the record is sitting in it right now.
  const initialState = states.find((s) => s.is_initial)
  if (initialState && initialState.id !== currentStateId) visitedIds.add(initialState.id)
  const firstFrom = history[0]?.from_state
  if (firstFrom && firstFrom !== currentStateId) visitedIds.add(firstFrom)
  const relevant = (() => {
    // Server relevance (owners/all on_path) is authoritative when loaded — it
    // is condition-aware and understands skip-jump history edges; the client
    // BFS below dead-ends on both (kept only as a fallback while loading).
    if (onPathIds) {
      return states
        .filter((s) => onPathIds.has(s.id) || visitedIds.has(s.id) || s.id === currentStateId)
        .filter((s) => {
          const v = s.stage_visibility ?? 'always'
          if (v === 'hide') return false
          if (v === 'hide_unless_active') return visitedIds.has(s.id) || s.id === currentStateId
          return true
        })
        .sort((a, b) => a.sort - b.sort)
    }
    if (allTransitions.length === 0) {
      const show = new Set([...visitedIds])
      if (currentStateId) show.add(currentStateId)
      return states.filter((s) => show.has(s.id)).sort((a, b) => a.sort - b.sort)
    }
    const takenEdges = new Set(
      history.filter((h) => h.from_state).map((h) => `${h.from_state}:${h.to_state}`)
    )
    const visitedFromIds = new Set(history.map((h) => h.from_state).filter(Boolean) as string[])
    const explicit = allTransitions.filter((t) => t.from_state !== null)
    const fwd = new Map<string, string[]>()
    for (const t of explicit) {
      const fromId = t.from_state!
      if (visitedFromIds.has(fromId) && !takenEdges.has(`${fromId}:${t.to_state}`)) continue
      const arr = fwd.get(fromId) ?? []
      arr.push(t.to_state)
      fwd.set(fromId, arr)
    }
    if (currentStateId) {
      // Available transitions alone can dead-end the track: auto transitions
      // and condition-gated ones (e.g. Submit hidden until an order number is
      // entered) never appear in `available`, so union in the template's own
      // explicit edges from the current state — a hidden button is a pending
      // path, not a missing one.
      const explicitFromCurrent = explicit
        .filter((t) => t.from_state === currentStateId)
        .map((t) => t.to_state)
      fwd.set(currentStateId, [
        ...new Set([...availableTransitions.map((t) => t.to_state), ...explicitFromCurrent])
      ])
    }
    const pathIds = new Set<string>()
    const queue = states.filter((s) => s.is_initial).map((s) => s.id)
    while (queue.length) {
      const id = queue.shift()!
      if (pathIds.has(id)) continue
      pathIds.add(id)
      for (const next of fwd.get(id) ?? []) if (!pathIds.has(next)) queue.push(next)
    }
    const show = new Set([...pathIds, ...visitedIds])
    if (currentStateId) show.add(currentStateId)
    return states
      .filter((s) => show.has(s.id))
      .filter((s) => {
        const v = s.stage_visibility ?? 'always'
        if (v === 'hide') return false
        if (v === 'hide_unless_active') return visitedIds.has(s.id) || s.id === currentStateId
        return true
      })
      .sort((a, b) => a.sort - b.sort)
  })()
  if (relevant.length < 2) return null
  const currentIndex = relevant.findIndex((st) => st.id === currentStateId)

  // Who moved the record across this gap. Position-based, not exact-pair:
  // a transition that SKIPS steps (manager approval jumping straight to VP)
  // has no adjacent-pair edge, so exact matching silently dropped the
  // approver's initials from the track (user report). A
  // forward hop annotates the segment leaving its ORIGIN; a send-back the
  // segment beside its destination — one attribution per hop, never one per
  // crossed segment (that would read as three approvals).
  const trackIndex = new Map(relevant.map((st, i) => [st.id, i]))
  const labelOf = new Map(states.map((st) => [st.id, st.label]))
  function edgeEntries(fromId: string, _toId: string) {
    const i = trackIndex.get(fromId)
    if (i == null) return []
    return [...history]
      .filter((h) => {
        if (!h.from_state) return false
        const f = trackIndex.get(h.from_state)
        const t = trackIndex.get(h.to_state)
        if (f == null || t == null) return false
        // A forward hop sits on the segment leaving its origin; a send back
        // on the segment leading INTO the step that sent it back (army 11
        // a1 F-8: it sat beside the destination, far from who sent it).
        return (f === i && t > i) || (t < f && f - 1 === i)
      })
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
  }
  function entryInitials(h: PipelineHistoryEntry) {
    if (isMachineEntry(h)) {
      return <Zap className='inline h-2.5 w-2.5' aria-label={machineHeadline(h)} />
    }
    return (
      ((h.first_name?.[0] ?? '') + (h.last_name?.[0] ?? '')).toUpperCase() ||
      h.user_email?.[0]?.toUpperCase() ||
      '?'
    )
  }
  function entryName(h: PipelineHistoryEntry) {
    return withBehalf([h.first_name, h.last_name].filter(Boolean).join(' ') || h.user_email, h)
  }

  // States a recorded forward hop jumped OVER. The engine skipped them at the
  // moment of the move; today's live prediction may disagree (the record's
  // dimensions changed since, owner groups were edited), so history wins —
  // a state the record provably never entered on its way past is skipped.
  const crossedBy = new Map<string, PipelineHistoryEntry>()
  for (const h of [...history].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  )) {
    if (!h.from_state) continue
    const f = trackIndex.get(h.from_state)
    const t = trackIndex.get(h.to_state)
    if (f == null || t == null || t <= f + 1) continue
    for (let k = f + 1; k < t; k++) {
      const id = relevant[k].id
      if (!visitedIds.has(id) && !crossedBy.has(id)) crossedBy.set(id, h)
    }
  }
  function crossedReason(h: PipelineHistoryEntry) {
    const from = labelOf.get(h.from_state ?? '') ?? 'the previous step'
    const to = labelOf.get(h.to_state) ?? 'the next step'
    const who = isMachineEntry(h) ? 'it moved automatically' : `${entryName(h)} moved it`
    return `Passed over on ${formatDateTime(h.timestamp)} — ${who} straight from ${from} to ${to}`
  }

  return (
    <TooltipProvider delayDuration={200}>
      {/* pt/pb: the scroll box clips vertically too — room for the current
        step's ring. */}
      <div ref={scrollRef} className='overflow-x-auto pt-1.5 pb-1' data-state-track>
        <div className='flex w-full items-start'>
          {relevant.map((s, i) => {
            const isCurrent = s.id === currentStateId
            const isVisited = visitedIds.has(s.id)
            // A step after the current one is not done THIS round, even when
            // the record passed it before a send back (army 11 a1 F-8: Level 2
            // kept its ✓ while the record was back at Level 1).
            const isDone = isVisited && !isCurrent && (currentIndex < 0 || i < currentIndex)
            const doneBefore = isVisited && !isCurrent && !isDone
            const crossed = !isVisited && !isCurrent ? crossedBy.get(s.id) : undefined
            const predicted = !isVisited && !isCurrent ? skippedStates?.get(s.id) : undefined
            const skipReasons =
              crossed || predicted
                ? [...(crossed ? [crossedReason(crossed)] : []), ...(predicted ?? [])]
                : undefined
            const isSkipped = skipReasons !== undefined
            const nodeColor = s.color ?? '#94a3b8'
            const isLast = i === relevant.length - 1
            const nextState = !isLast ? relevant[i + 1] : null
            const edge = nextState ? edgeEntries(s.id, nextState.id) : []
            return (
              <div key={s.id} className='flex flex-1 items-start'>
                {/* The label column keeps a readable floor of its own: the old
                floor sat on the step AND its 40px connector together, leaving
                the label a few pixels on a narrow track. */}
                <div className='flex min-w-[76px] flex-1 flex-col items-center gap-1.5 px-1'>
                  <div
                    key={isCurrent ? 'cur' : isDone ? 'done' : isSkipped ? 'skip' : 'todo'}
                    data-track-current={isCurrent || undefined}
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                      isCurrent || isDone ? 'nvr-fill-sweep' : ''
                    }`}
                    // Per-state help text (#81) — instant tip via TipLayer.
                    data-tip={
                      doneBefore
                        ? `Passed before the record was sent back — it needs this step again.${s.description ? ` ${s.description}` : ''}`
                        : s.description || undefined
                    }
                    data-track-again={doneBefore || undefined}
                    style={{
                      backgroundColor:
                        isCurrent || isDone ? nodeColor : isSkipped ? 'transparent' : '#f1f5f9',
                      border:
                        isCurrent || isDone
                          ? 'none'
                          : isSkipped
                            ? '1.5px dashed #cbd5e1'
                            : '1.5px solid #e2e8f0',
                      boxShadow: isCurrent ? `0 0 0 3px white, 0 0 0 5px ${nodeColor}` : undefined
                    }}
                  >
                    {isDone ? (
                      <Check className='h-3.5 w-3.5 text-white' strokeWidth={2.5} />
                    ) : isCurrent ? (
                      <div className='h-2.5 w-2.5 rounded-full bg-white/80' />
                    ) : isSkipped ? (
                      <Minus className='h-3 w-3 text-slate-400' strokeWidth={2.5} />
                    ) : (
                      <div className='h-2 w-2 rounded-full bg-slate-300' />
                    )}
                  </div>
                  {isSkipped ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          className='w-full cursor-help break-words text-center leading-snug'
                          style={{
                            fontSize: '11px',
                            color: '#94a3b8',
                            fontWeight: 400,
                            wordBreak: 'break-word',
                            textDecoration: 'line-through',
                            textDecorationColor: '#cbd5e1'
                          }}
                        >
                          {s.label}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent className='max-w-[260px]'>
                        <p className='text-[11px] font-medium'>Skipped for this record</p>
                        {skipReasons.length > 0 ? (
                          <ul className='mt-1 space-y-0.5 text-[11px] opacity-90'>
                            {skipReasons.map((r) => (
                              <li key={r}>{r}</li>
                            ))}
                          </ul>
                        ) : (
                          <p className='mt-1 text-[11px] opacity-90'>
                            Its skip conditions are met.
                          </p>
                        )}
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    <span
                      // Steps still to come: slate-500 on white (4.8:1) — the old
                      // #94a3b8 was near-invisible in light mode (army 11 a1).
                      className={cn(
                        'w-full break-words text-center leading-snug',
                        !isCurrent && !isDone && 'text-slate-500 dark:text-slate-400'
                      )}
                      style={{
                        fontSize: '11px',
                        color: isCurrent ? nodeColor : isDone ? '#475569' : undefined,
                        fontWeight: isCurrent ? 600 : isDone ? 500 : 400,
                        wordBreak: 'break-word'
                      }}
                    >
                      {s.label}
                    </span>
                  )}
                </div>
                {!isLast && (
                  <div className='mt-[13px] flex w-10 shrink-0 flex-col items-center gap-1.5'>
                    {(() => {
                      const lineColor = isDone ? `${nodeColor}55` : '#e8ecf0'
                      return (
                        <div className='flex w-full shrink-0 items-center'>
                          <div
                            className='h-0.5 flex-1 rounded-l-sm'
                            style={{ backgroundColor: lineColor }}
                          />
                          <div
                            style={{
                              width: 0,
                              height: 0,
                              borderTop: '3px solid transparent',
                              borderBottom: '3px solid transparent',
                              borderLeft: `5px solid ${lineColor}`
                            }}
                          />
                        </div>
                      )
                    })()}
                    {edge.map((h) => {
                      const isSendback = h.from_state !== s.id
                      const hopSpan =
                        Math.abs(
                          (trackIndex.get(h.to_state) ?? 0) -
                            (trackIndex.get(h.from_state ?? '') ?? 0)
                        ) > 1
                          ? (labelOf.get(h.to_state) ?? '')
                          : null
                      return (
                        <Tooltip key={h.id}>
                          <TooltipTrigger asChild>
                            <div className='flex w-full cursor-default flex-col items-center gap-0.5'>
                              <span
                                className='text-center font-mono text-[9px] font-semibold leading-none'
                                style={{ color: isSendback ? '#d97706' : '#475569' }}
                              >
                                {isSendback && '↩ '}
                                {entryInitials(h)}
                              </span>
                              <span className='text-[8.5px] leading-none text-slate-400'>
                                {formatRelative(h.timestamp)}
                              </span>
                            </div>
                          </TooltipTrigger>
                          <TooltipContent side='top' className='space-y-0.5 text-[12px]'>
                            {isMachineEntry(h) ? (
                              <>
                                <p className='font-medium'>
                                  {isSendback ? '↩ Sent back · ' : ''}
                                  {machineHeadline(h)}
                                </p>
                                {machineDetail(h) && (
                                  <p className='max-w-[280px] text-muted-foreground'>
                                    {machineDetail(h)}
                                  </p>
                                )}
                              </>
                            ) : (
                              <p className='font-medium'>
                                {isSendback ? '↩ Sent back by' : 'Approved by'} {entryName(h)}
                              </p>
                            )}
                            {hopSpan && (
                              <p className='text-muted-foreground'>→ straight to {hopSpan}</p>
                            )}
                            <p className='text-muted-foreground'>{formatDateTime(h.timestamp)}</p>
                          </TooltipContent>
                        </Tooltip>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </TooltipProvider>
  )
}

// ─── History timeline ─────────────────────────────────────────────────────────

function HistoryTimeline({ history }: { history: PipelineHistoryEntry[] }) {
  if (history.length === 0)
    return <p className='text-[12px] text-slate-400 italic'>No transitions yet.</p>
  return (
    <div className='space-y-3'>
      {history.map((h) => {
        const machine = isMachineEntry(h)
        const userName = machine
          ? machineHeadline(h)
          : withBehalf([h.first_name, h.last_name].filter(Boolean).join(' ') || h.user_email, h)
        // The engine's own stamp ("auto: <rule>") is not a note anyone wrote.
        const lifecycle = lifecycleNote(h)
        const note = h.comment && !machine && !lifecycle ? h.comment : null
        const detail = lifecycle ?? (machine ? machineDetail(h) : null)
        return (
          <div key={h.id} className='flex items-start gap-2.5 text-[12px]'>
            <div className='mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-200' />
            <div className='flex-1 min-w-0'>
              <div className='flex items-center gap-1.5 flex-wrap'>
                {h.from_state_label ? (
                  <StateBadge label={h.from_state_label} color={h.from_state_color} small />
                ) : (
                  <span className='text-[11px] text-slate-400 italic'>started</span>
                )}
                <ArrowRight className='h-3 w-3 shrink-0 text-slate-300' />
                <StateBadge label={h.to_state_label} color={h.to_state_color} small />
              </div>
              {note && <p className='mt-1 text-slate-500 italic'>"{note}"</p>}
              <p
                className='mt-0.5 text-slate-400'
                data-history-on-behalf={h.on_behalf_of_name ? (h.on_behalf_of ?? '') : undefined}
              >
                {machine && <Zap className='mr-1 inline h-3 w-3' aria-hidden />}
                {userName}
                {detail ? ` · ${detail}` : ''} · {formatRelative(h.timestamp)}
              </p>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Async user picker ────────────────────────────────────────────────────────

function AsyncUserPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 50)
    else setQuery('')
  }, [open])
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => setDebouncedQuery(query), 250)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query])

  type User = { id: string; first_name: string | null; last_name: string | null; email: string }
  const { data, isLoading } = useQuery<User[]>({
    queryKey: ['users', 'async-search', debouncedQuery],
    queryFn: () =>
      client
        .request<{ data: User[]; total: number }>(
          get('/users', {
            limit: 50,
            sort: 'first_name',
            ...(debouncedQuery ? { search: debouncedQuery } : {})
          })
        )
        .then((r) => r.data),
    enabled: open,
    staleTime: 30_000
  })
  // The directory card (any signed-in person), never GET /users/:id — that
  // is admin-only and left a non-admin looking at the picked person's raw id.
  const { data: selectedUser } = useQuery<User | null>({
    ...userCardQuery<User>(client, value),
    enabled: !!value,
    staleTime: 5 * 60_000
  })
  const users = data ?? []
  // The search row it was picked from answers at once; the card after.
  const picked = selectedUser ?? users.find((u) => u.id === value) ?? null
  const selectedLabel = picked
    ? [picked.first_name, picked.last_name].filter(Boolean).join(' ').trim() || picked.email
    : value
      ? 'Selected person'
      : null
  const nameOf = (u: User) => [u.first_name, u.last_name].filter(Boolean).join(' ').trim()

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className='relative flex h-8 w-full'>
        <PopoverTrigger asChild>
          <button
            type='button'
            className='flex h-full w-full items-center justify-between gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 text-left text-[13px] text-slate-700 hover:border-slate-300'
          >
            <span className={`flex-1 truncate ${selectedLabel ? '' : 'text-slate-400'}`}>
              {selectedLabel ?? 'Select a user…'}
            </span>
            <ChevronDown className='h-3.5 w-3.5 shrink-0 text-slate-400' />
          </button>
        </PopoverTrigger>
        {value && (
          <button
            type='button'
            onClick={(e) => {
              e.stopPropagation()
              onChange('')
            }}
            className='absolute right-6 top-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-muted dark:hover:text-slate-300'
          >
            <X className='h-3 w-3' />
          </button>
        )}
      </div>
      <PopoverContent align='start' className='w-72 p-0' sideOffset={4}>
        <div className='border-b border-slate-100 px-2 py-1.5'>
          <div className='relative'>
            <Search className='absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400' />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='Search users…'
              className='h-7 w-full rounded-md bg-slate-50 pl-7 pr-2 text-[12px] placeholder-slate-400 focus:outline-none focus:ring-1 focus:ring-nvr-cyan/40'
            />
          </div>
        </div>
        <div className='max-h-56 overflow-y-auto py-1'>
          {isLoading ? (
            <div className='flex items-center gap-2 px-3 py-2 text-[12px] text-slate-400'>
              <Loader2 className='h-3.5 w-3.5 animate-spin' />
              Loading…
            </div>
          ) : users.length === 0 ? (
            <div className='px-3 py-2 text-[12px] text-slate-400'>No results</div>
          ) : (
            users.map((u) => {
              const name = nameOf(u)
              const label = name ? `${name} (${u.email})` : u.email
              const selected = u.id === value
              return (
                <button
                  key={u.id}
                  type='button'
                  onClick={() => {
                    onChange(u.id)
                    setOpen(false)
                  }}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-slate-50 ${selected ? 'font-medium text-slate-800' : 'text-slate-600'}`}
                >
                  <Check
                    className={`h-3.5 w-3.5 shrink-0 ${selected ? 'text-nvr-cyan' : 'opacity-0'}`}
                  />
                  {label}
                </button>
              )
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ─── Owners section ───────────────────────────────────────────────────────────

/** An owner's avatar + name as one button that opens the shared user card
 *  (UserChip with a custom trigger — the same card chat and the header use). */
function OwnerPersonButton({
  userId,
  name,
  email,
  initials
}: {
  userId: string
  name: string
  email: string
  initials: string
}) {
  return (
    <UserChip userId={userId}>
      <button
        type='button'
        aria-label={`${name} — profile`}
        className='group/owner flex min-w-0 flex-1 items-center gap-2.5 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
      >
        <UserAvatar
          userId={userId}
          alt={name}
          className='h-6 w-6'
          fallback={
            <span className='flex h-6 w-6 shrink-0 select-none items-center justify-center rounded-full bg-nvr-cyan/10 text-[10px] font-semibold text-nvr-navy/80 dark:bg-nvr-cyan/15 dark:text-nvr-cyan'>
              {initials}
            </span>
          }
        />
        <span className='min-w-0 flex-1'>
          <span className='block truncate text-[12px] font-medium text-slate-700 underline-offset-2 group-hover/owner:underline dark:text-slate-200'>
            {name}
          </span>
          <span className='block truncate text-[11px] text-slate-400 dark:text-slate-500'>
            {email}
          </span>
        </span>
      </button>
    </UserChip>
  )
}

function OwnersSection({
  collection,
  item,
  states,
  currentStateId,
  returned = false
}: {
  collection: string
  item: string
  states: PipelineState[]
  currentStateId?: string | null
  /** The record came back to its current step (a send-back). */
  returned?: boolean
}) {
  const client = useNivaroClient()
  const queryClient = useQueryClient()
  const { isAdmin } = useItemEditAuth()
  const [adding, setAdding] = useState(false)
  const [userId, setUserId] = useState('')
  const [stateScope, setStateScope] = useState('')
  const [scopeOpen, setScopeOpen] = useState(false)
  const ownersKey = ['pipeline-instance-owners', collection, item]

  // `meta.can_add` is the POST's own rule (admins + the current step's
  // owners): seeded beside the shared owners cache, whose shape stays a list.
  const canAddKey = ['pipeline-owners-can-add', collection, item]
  const ownersRead = () =>
    client
      .request<{ data: PipelineInstanceOwner[]; meta?: { can_add?: boolean } }>(
        get(`/pipelines/instance/${collection}/${item}/owners`)
      )
      .then((r) => {
        queryClient.setQueryData(canAddKey, r.meta?.can_add ?? null)
        return r
      })
  const { data: owners, isLoading: ownersLoading } = useQuery<PipelineInstanceOwner[]>({
    queryKey: ownersKey,
    queryFn: () => ownersRead().then((r) => r.data)
  })
  const { data: canAddAnswer } = useQuery<boolean | null>({
    queryKey: canAddKey,
    queryFn: () => ownersRead().then((r) => r.meta?.can_add ?? null),
    enabled: !ownersLoading,
    staleTime: 30_000
  })
  // Offered only when the add would land — an approver's Add answered 403 every time.
  // An older server without the flag: admins only.
  const canAddOwner = typeof canAddAnswer === 'boolean' ? canAddAnswer : isAdmin

  // Resolved owners per state (owner-group derived) — same key/data as the
  // Approval Chain popover, so the cache is shared between the two.
  const { data: allOwners, isLoading: groupOwnersLoading } = useQuery<Record<
    string,
    AllOwnersEntry
  > | null>({
    queryKey: ['pipeline-all-owners', collection, item],
    queryFn: () =>
      client
        .request<{ data: Record<string, AllOwnersEntry> | null }>(
          get(`/pipelines/instance/${collection}/${item}/owners/all`)
        )
        .then((r) => r.data ?? null),
    enabled: !!currentStateId,
    staleTime: 30_000
  })

  // Group-derived owners for the CURRENT state, minus anyone already listed as
  // a manual assignment — manual rows carry the state chip + remove button.
  const manualUserIds = new Set((owners ?? []).map((o) => o.user))
  const groupOwners = currentStateId
    ? (allOwners?.[currentStateId]?.owners ?? []).filter((o) => !manualUserIds.has(o.id))
    : []
  // Owners of the current step who cannot act (suspended, redacted, out of
  // office) — marked in the roster so a creator never counts on them
  // (army8 b02: a suspended approver was listed like any other).
  const unavailableById = new Map(
    (currentStateId ? (allOwners?.[currentStateId]?.unavailable ?? []) : []).map((u) => [
      String(u.id).toUpperCase(),
      u
    ])
  )

  // A record in its first step with nobody resolved is with the person who
  // created it — "Back with Mark Lee" after a send-back — not "No owners".
  // Display only: who may move the record is the server's answer.
  const resolvedCount = groupOwners.length + (owners?.length ?? 0)
  const atInitial = !!states.find((s) => s.id === currentStateId)?.is_initial
  const ownersSettled = !ownersLoading && !groupOwnersLoading
  const { data: creator } = useQuery<{ id: string; name: string | null } | null>({
    queryKey: ['pipeline-record-creator', collection, item],
    queryFn: () =>
      client
        .request<{ data: { id: string; name: string | null } | null }>(
          get(`/pipelines/instance/${collection}/${item}/creator`)
        )
        .then((r) => r.data ?? null),
    enabled: atInitial && ownersSettled && resolvedCount === 0,
    staleTime: 60_000
  })
  const withCreator = atInitial && resolvedCount === 0 && creator?.name ? creator : null

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ownersKey })
    queryClient.invalidateQueries({ queryKey: ['pipeline-instance', collection, item] })
  }

  const addOwner = useMutation({
    mutationFn: () =>
      client.request(
        post(`/pipelines/instance/${collection}/${item}/owners`, {
          user: userId,
          state: stateScope || undefined
        })
      ),
    onSuccess: () => {
      invalidate()
      setUserId('')
      setStateScope('')
      setAdding(false)
      toast.success('Owner added')
    },
    // The server's reason (a 403 says why), not a bare status phrase.
    onError: (err) => toast.error(userErrorMessage(err, 'Failed to add owner'))
  })

  // One click removes (no confirm); the toast's Undo puts the same seat back.
  const removeOwner = useMutation({
    mutationFn: (o: PipelineInstanceOwner) =>
      client.request(del(`/pipelines/instance-owners/${o.id}`)),
    onSuccess: (_r, o) => {
      invalidate()
      const name = [o.first_name, o.last_name].filter(Boolean).join(' ') || o.email
      toast.success(`${name} removed as an owner`, {
        action: {
          label: 'Undo',
          onClick: () =>
            void client
              .request(
                post(`/pipelines/instance/${collection}/${item}/owners`, {
                  user: o.user,
                  state: o.state || undefined
                })
              )
              .then(() => invalidate())
              .catch((err) => toast.error(userErrorMessage(err, 'Could not add the owner back')))
        }
      })
    },
    onError: (err) => toast.error(userErrorMessage(err, 'Failed to remove owner'))
  })

  const ownerInitials = (o: PipelineInstanceOwner) => {
    const f = o.first_name?.[0] ?? ''
    const l = o.last_name?.[0] ?? ''
    return (`${f}${l}`.trim() || o.email[0] || '?').toUpperCase()
  }
  const stateLabelFor = (v: string | null) => {
    if (!v) return null
    return states.find((s) => s.id === v || s.key === v)?.label ?? v
  }

  return (
    <div>
      <div className='mb-3 flex items-center justify-between'>
        <span className='flex items-center gap-1.5 text-[11px] font-medium text-slate-400'>
          <Users className='h-3.5 w-3.5' />
          Owners
          {ownersLoading || groupOwnersLoading ? (
            <span className='inline-block h-3 w-4 animate-pulse rounded bg-slate-200 dark:bg-[hsl(var(--nvr-skeleton))]' />
          ) : withCreator ? null : (
            <span className='text-slate-300'>({resolvedCount})</span>
          )}
        </span>
        <span className='flex items-center gap-3'>
          {currentStateId && <WhyOwnersButton collection={collection} itemId={String(item)} />}
          {!adding && canAddOwner && (
            <button
              type='button'
              onClick={() => setAdding(true)}
              className='flex items-center gap-1 text-[11px] text-slate-400 transition-colors hover:text-nvr-cyan'
            >
              <UserPlus className='h-3 w-3' />
              Add
            </button>
          )}
        </span>
      </div>
      {ownersLoading || groupOwnersLoading ? (
        <div className='flex items-center gap-2 py-1.5 text-[12px] text-slate-400'>
          <Loader2 className='h-3.5 w-3.5 animate-spin' />
          Resolving owners…
        </div>
      ) : withCreator ? (
        <p className='text-[12px] text-slate-500 dark:text-muted-foreground'>
          {returned ? 'Back with' : 'With'}{' '}
          <UserChip userId={withCreator.id}>
            <button
              type='button'
              aria-label={`${withCreator.name} — profile`}
              className='rounded font-medium text-slate-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-foreground'
            >
              {withCreator.name}
            </button>
          </UserChip>
        </p>
      ) : resolvedCount === 0 ? (
        <p className='text-[12px] text-slate-400'>No owners assigned.</p>
      ) : (
        <div className='space-y-px'>
          {groupOwners.map((o) => {
            const name = [o.first_name, o.last_name].filter(Boolean).join(' ') || o.email
            const initials = (
              `${o.first_name?.[0] ?? ''}${o.last_name?.[0] ?? ''}`.trim() ||
              o.email[0] ||
              '?'
            ).toUpperCase()
            return (
              <div
                key={`group-${o.id}`}
                className='-mx-2 flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-slate-50 dark:hover:bg-white/5'
              >
                <OwnerPersonButton userId={o.id} name={name} email={o.email} initials={initials} />
                {(() => {
                  const u = unavailableById.get(String(o.id).toUpperCase())
                  if (!u) return null
                  return (
                    <span
                      data-owner-unavailable={u.reason}
                      className={cn(
                        'shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium',
                        u.delegate
                          ? 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
                          : 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300'
                      )}
                      data-tip={
                        u.delegate
                          ? `${name} is ${REASON_WORD[u.reason] ?? u.reason} — ${u.delegate.name} covers`
                          : `${name} is ${REASON_WORD[u.reason] ?? u.reason} and can't approve this step`
                      }
                    >
                      {u.delegate
                        ? `${REASON_WORD[u.reason] ?? u.reason} · ${u.delegate.name} covers`
                        : (REASON_WORD[u.reason] ?? u.reason)}
                    </span>
                  )
                })()}
                {o.queue_only ? (
                  <span
                    className='shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400'
                    data-tip='The record is in their queue, but only the step’s owners can move it'
                  >
                    in their queue
                  </span>
                ) : (
                  <span className='shrink-0 rounded-full bg-nvr-cyan/10 px-1.5 py-0.5 text-[10px] font-medium text-nvr-navy/70 dark:text-nvr-cyan'>
                    owner group
                  </span>
                )}
              </div>
            )
          })}
          {(owners ?? []).map((o) => (
            <div
              key={o.id}
              className='group -mx-2 flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-slate-50 dark:hover:bg-white/5'
            >
              <OwnerPersonButton
                userId={o.user}
                name={[o.first_name, o.last_name].filter(Boolean).join(' ') || o.email}
                email={o.email}
                initials={ownerInitials(o)}
              />
              <span className='shrink-0 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'>
                manual
              </span>
              <span className='shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500'>
                {o.state ? stateLabelFor(o.state) : 'all states'}
              </span>
              <button
                type='button'
                aria-label={`Remove ${[o.first_name, o.last_name].filter(Boolean).join(' ') || o.email} as an owner`}
                disabled={removeOwner.isPending}
                onClick={() => removeOwner.mutate(o)}
                className='shrink-0 rounded p-0.5 text-slate-300 opacity-0 transition-all hover:text-red-500 focus-visible:opacity-100 group-hover:opacity-100'
              >
                <X className='h-3 w-3' />
              </button>
            </div>
          ))}
        </div>
      )}
      {adding && (
        <div className='mt-3 space-y-2 rounded-lg border border-slate-200 bg-slate-50 dark:bg-slate-900/30 dark:border-border p-3'>
          <p className='text-[11px] font-semibold text-slate-500'>Add owner</p>
          <AsyncUserPicker value={userId} onChange={setUserId} />
          {!isAdmin ? (
            <p className='text-[11px] text-slate-500 dark:text-slate-400'>
              Hands off the current step.
            </p>
          ) : (
            <Popover open={scopeOpen} onOpenChange={setScopeOpen}>
              <PopoverTrigger asChild>
                <button
                  type='button'
                  className='flex h-8 w-full items-center justify-between rounded-md border border-slate-200 bg-white px-2.5 text-left text-[13px] text-slate-700 transition-colors hover:border-slate-300 dark:border-border dark:bg-transparent dark:text-slate-300'
                >
                  <span className='truncate'>
                    {stateScope
                      ? (states.find((s) => s.id === stateScope)?.label ?? stateScope)
                      : 'All states'}
                  </span>
                  <ChevronDown className='h-3.5 w-3.5 shrink-0 text-slate-400' />
                </button>
              </PopoverTrigger>
              <PopoverContent align='start' sideOffset={4} className='w-52 p-1'>
                {(['', ...states.map((s) => s.id)] as string[]).map((id) => {
                  const label =
                    id === '' ? 'All states' : (states.find((s) => s.id === id)?.label ?? id)
                  const active = stateScope === id
                  return (
                    <button
                      key={id}
                      type='button'
                      className={cn(
                        'flex w-full rounded px-2.5 py-1.5 text-left text-[13px] transition-colors hover:bg-slate-50 dark:hover:bg-white/5',
                        active && 'font-medium text-slate-800 dark:text-slate-200'
                      )}
                      onClick={() => {
                        setStateScope(id)
                        setScopeOpen(false)
                      }}
                    >
                      {label}
                    </button>
                  )
                })}
              </PopoverContent>
            </Popover>
          )}
          <div className='flex items-center justify-end gap-2 pt-0.5'>
            <Button
              type='button'
              size='sm'
              variant='ghost'
              className='h-7 text-[12px]'
              onClick={() => {
                setAdding(false)
                setUserId('')
                setStateScope('')
              }}
            >
              Cancel
            </Button>
            <Button
              type='button'
              size='sm'
              className='h-7 text-[12px]'
              disabled={!userId || addOwner.isPending}
              onClick={() => addOwner.mutate()}
            >
              {addOwner.isPending ? <Loader2 className='h-3.5 w-3.5 animate-spin' /> : 'Add'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Approval Chain View ──────────────────────────────────────────────────────

/**
 * The confirm panel's target, as the record will actually land (army 8
 * b06-N-U): a forward move into states the engine will pass through names
 * where it goes and why, instead of the transition's nominal target.
 */
function confirmLanding(
  pendingTx: PipelineTransition | null | undefined,
  currentState: PipelineState | null | undefined,
  states: PipelineState[] | undefined,
  chain: Record<string, AllOwnersEntry> | null | undefined
) {
  if (!pendingTx || !states?.length) return null
  const byId = new Map(states.map((s) => [String(s.id).toUpperCase(), s]))
  const to = byId.get(String(pendingTx.to_state).toUpperCase())
  const fromSort = Number(currentState?.sort)
  // Skips apply going forward; a send back lands where it says.
  if (!to || !Number.isFinite(fromSort) || !(Number(to.sort) > fromSort)) return null
  const l = landingState(String(pendingTx.to_state), states, chain)
  return l && l.skipped.length > 0 ? l : null
}

function LandingNote({ landing }: { landing: ReturnType<typeof landingState<PipelineState>> }) {
  if (!landing || landing.skipped.length === 0) return null
  const groups = landingSkipGroups(landing)
  // One reason for every skipped step: one sentence, as before.
  if (groups.length === 1) {
    const g = groups[0]
    return (
      <p
        data-confirm-skips
        className='text-[11.5px] leading-snug text-slate-600 dark:text-slate-300'
      >
        Goes straight to <span className='font-medium'>{landing.state.label}</span> —{' '}
        {joinLabels(g.labels)} {g.labels.length === 1 ? 'is' : 'are'} skipped
        {g.reason ? ` (${g.reason})` : ''}.
      </p>
    )
  }
  // Different reasons (army 9 b06: Level 3 below 20,000, Level 4 below 50,000):
  // each skipped step with its own.
  return (
    <div
      data-confirm-skips
      className='text-[11.5px] leading-snug text-slate-600 dark:text-slate-300'
    >
      <p>
        Goes straight to <span className='font-medium'>{landing.state.label}</span>. Skipped on the
        way:
      </p>
      <ul className='mt-0.5 list-disc space-y-0.5 pl-4'>
        {groups.map((g) => (
          <li key={g.labels.join('|')}>
            <span className='font-medium'>{joinLabels(g.labels)}</span>
            {g.reason ? ` — ${g.reason}` : ''}
          </li>
        ))}
      </ul>
    </div>
  )
}

interface AllOwnersEntry {
  state: PipelineState
  owners: Array<{
    id: string
    email: string
    first_name: string | null
    last_name: string | null
    /** Named only by the binding's fallback field (the creator on a review
     *  step): the record sits in their queue, but they cannot approve it. */
    queue_only?: boolean
  }>
  /** Server-predicted: this state's skip criteria currently evaluate true
   *  (no resolved owners, threshold conditions, lookup_compare…) — the
   *  pipeline will pass straight through it. */
  skipped?: boolean
  /** Human sentences explaining WHY the skip criteria match right now
   *  (e.g. "requisition amount (14,560) is below the threshold amount of 25,000"). */
  skip_reasons?: string[]
  /** Server-computed: this state is on the record's actual path — reachable
   *  from the initial state through the taken history edges and any branch
   *  edges whose conditions this record satisfies. false = another branch's
   *  state (e.g. Beeline submission on an Oracle-path workflow); hide it. */
  on_path?: boolean
  /** Owners who cannot act right now (#12) — OOO/suspended/redacted — with
   *  the delegate that stands in for them, when one resolves. */
  unavailable?: Array<{
    id: string
    name: string
    reason: 'out' | 'suspended' | 'redacted'
    delegate: { id: string; name: string; expires_at: string | null } | null
  }>
  /** Every raw owner of this state is unable to act — approvals would stall here. */
  blocked?: boolean
}

const REASON_WORD: Record<string, string> = {
  out: 'out of office',
  suspended: 'suspended',
  redacted: 'redacted'
}

function ApprovalChainView({
  collection,
  item,
  states,
  currentStateId
}: {
  collection: string
  item: string
  states: PipelineState[]
  currentStateId?: string | null
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const { data, isLoading } = useQuery<Record<string, AllOwnersEntry> | null>({
    queryKey: ['pipeline-all-owners', collection, item],
    queryFn: () =>
      client
        .request<{ data: Record<string, AllOwnersEntry> | null }>(
          get(`/pipelines/instance/${collection}/${item}/owners/all`)
        )
        .then((r) => r.data ?? null),
    enabled: open,
    staleTime: 30_000
  })

  // Only the record's actual path — other branches' states (on_path false)
  // are noise here. Legacy responses without the flag show everything.
  const sorted = [...states]
    .filter((s) => !data || data[s.id]?.on_path !== false)
    .sort((a, b) => a.sort - b.sort)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          title='View approval chain'
          className='flex h-6 w-6 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-muted dark:hover:text-slate-300'
          onClick={(e) => e.stopPropagation()}
        >
          <Users className='h-3.5 w-3.5' />
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' sideOffset={6} className='w-[576px] p-0 overflow-hidden'>
        <div className='border-b border-slate-100 px-4 py-3'>
          <p className='text-[12px] font-semibold text-slate-700'>Approval Chain</p>
          <p className='text-[11px] text-slate-400 mt-0.5'>Owners per pipeline state</p>
        </div>
        <div className='max-h-[504px] overflow-y-auto'>
          {isLoading ? (
            <div className='space-y-px p-3'>
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className='h-10 w-full' />
              ))}
            </div>
          ) : !data ? (
            <p className='px-4 py-3 text-[12px] text-slate-400'>No pipeline configured.</p>
          ) : (
            <div className='divide-y divide-slate-100 dark:divide-border/60'>
              {sorted.map((s) => {
                const owners = (data[s.id]?.owners ?? []).map((o) => ({
                  id: o.id,
                  name: [o.first_name, o.last_name].filter(Boolean).join(' ') || o.email
                }))
                const isCurrent = s.id === currentStateId
                const isSkipped = data[s.id]?.skipped === true && !isCurrent
                const skipReasons = (data[s.id]?.skip_reasons ?? []).filter(Boolean)
                const unavailable = data[s.id]?.unavailable ?? []
                const blocked = data[s.id]?.blocked === true && !isSkipped
                return (
                  <div
                    key={s.id}
                    className={cn(
                      'flex items-center gap-3 px-4 py-2.5',
                      // Hex-with-alpha rather than bg-nvr-cyan/N — the
                      // nvr-cyan token is an opaque var() so Tailwind silently
                      // drops opacity modifiers on it. Kept very light so the
                      // tint doesn't clash with the state badge's own color.
                      isCurrent && 'bg-nvr-cyan/[0.06] dark:bg-nvr-cyan/[0.11]',
                      isSkipped && 'opacity-60',
                      blocked && 'bg-red-50 dark:bg-red-500/10'
                    )}
                    data-chain-blocked={blocked ? '' : undefined}
                  >
                    <StateBadge label={s.label} color={s.color} small />
                    <div className='flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5'>
                      {isSkipped ? (
                        // Radix tooltip with zero delay — native `title` waits on
                        // the OS hover timer, and a truncated reason needs its
                        // full text the moment the cursor lands on it.
                        <TooltipProvider delayDuration={0}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className='flex min-w-0 flex-1 cursor-default items-center gap-2'>
                                <span className='inline-flex shrink-0 items-center gap-1 rounded-full border border-dashed border-slate-300 px-2 py-0.5 text-[10.5px] font-medium text-slate-400 dark:border-slate-600 dark:text-slate-500'>
                                  Skipped
                                </span>
                                {skipReasons.length > 0 && (
                                  <span className='min-w-0 flex-1 truncate text-[11px] text-slate-400 dark:text-slate-500'>
                                    {skipReasons.join(' · ')}
                                  </span>
                                )}
                              </div>
                            </TooltipTrigger>
                            <TooltipContent
                              side='bottom'
                              align='start'
                              className='max-w-[420px] space-y-0.5 text-[11.5px] leading-snug'
                            >
                              <p className='text-slate-500 dark:text-slate-400'>
                                The pipeline will pass through this state without stopping:
                              </p>
                              {skipReasons.length > 0 ? (
                                skipReasons.map((r) => <p key={r}>{r}</p>)
                              ) : (
                                <p>Skip criteria currently match</p>
                              )}
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ) : (
                        <>
                          <OwnerAvatars owners={owners} max={10} emptyLabel='—' />
                          {unavailable.map((u) => (
                            <span
                              key={u.id}
                              data-tip={`${u.name} is ${REASON_WORD[u.reason] ?? u.reason}${
                                u.delegate
                                  ? ` — ${u.delegate.name} covers${u.delegate.expires_at ? ` until ${toLocalDateString(u.delegate.expires_at)}` : ''}`
                                  : ' and nobody is covering'
                              }`}
                              className={cn(
                                'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10.5px] font-medium',
                                u.delegate
                                  ? 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
                                  : 'border-red-200 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300'
                              )}
                            >
                              {u.name}
                              {u.delegate ? (
                                <>
                                  {' → '}
                                  {u.delegate.name}
                                  {u.delegate.expires_at && (
                                    <span className='opacity-70'>
                                      , until{' '}
                                      {new Date(u.delegate.expires_at).toLocaleDateString(
                                        undefined,
                                        {
                                          month: 'short',
                                          day: 'numeric'
                                        }
                                      )}
                                    </span>
                                  )}
                                </>
                              ) : (
                                <span className='opacity-80'>
                                  {' '}
                                  · {REASON_WORD[u.reason] ?? u.reason}
                                </span>
                              )}
                            </span>
                          ))}
                          {blocked && (
                            <span className='inline-flex items-center gap-1 rounded-full bg-red-600 px-2 py-0.5 text-[10.5px] font-semibold text-white'>
                              No one can act here
                            </span>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

// ─── Pipeline Panel ───────────────────────────────────────────────────────────

export function PipelinePanel({
  collection,
  item,
  defaultExpanded,
  title,
  showApprovalChain,
  hideActionsCollapsed,
  hideActionsExpanded,
  onBeforeTransition,
  addendumPending,
  addendumView,
  asRole
}: {
  collection: string
  item: string
  defaultExpanded?: boolean
  title?: string
  showApprovalChain?: boolean
  /** Admin "view as role" (#8): evaluate available transitions for this role instead of the caller. */
  asRole?: string | null
  /** Layout-configurable: suppress the transition buttons inside the slot
   * (collapsed header row / expanded body) — redundant when the record header
   * already renders PipelineTransitionButtons. */
  hideActionsCollapsed?: boolean
  hideActionsExpanded?: boolean
  onBeforeTransition?: () => boolean | Promise<boolean>
  addendumPending?: boolean
  addendumView?: boolean
}) {
  if (item === 'new') return null
  return (
    <PipelinePanelInner
      key={`${collection}:${item}`}
      collection={collection}
      item={item}
      defaultExpanded={defaultExpanded}
      title={title}
      showApprovalChain={showApprovalChain}
      hideActionsCollapsed={hideActionsCollapsed}
      hideActionsExpanded={hideActionsExpanded}
      onBeforeTransition={onBeforeTransition}
      addendumPending={addendumPending}
      addendumView={addendumView}
      asRole={asRole}
    />
  )
}

/**
 * "What am I approving?" — the change summary for the state the approver is
 * signing off on. Fetched only while a transition confirm is open; a record
 * untouched since entering the state renders one quiet line rather than
 * nothing, because "no changes" is itself the answer.
 */
function ApprovalBriefStrip({
  collection,
  item,
  omitLines
}: {
  collection: string
  item: string | number
  /** Brief lines already shown in the amber warning below — said once (army11 f4 M5). */
  omitLines?: BriefLineView[]
}) {
  const client = useNivaroClient()
  const { data } = useQuery({
    queryKey: approvalBriefKey(collection, item),
    queryFn: () => fetchApprovalBrief(client, collection, item),
    staleTime: 30_000,
    retry: false
  })
  if (!data) return null
  // What people changed — a title the record rebuilt is not someone's edit.
  const byPeople = data.changed_by_people ?? data.changed_total
  const omitted = new Set((omitLines ?? []).map(briefLineKey))
  const lines = (data.lines ?? []).filter((l) => !omitted.has(briefLineKey(l)))

  return (
    <div className='rounded-md border border-slate-200 bg-white px-3 py-2 text-[11.5px] dark:border-border dark:bg-card'>
      <p className='text-slate-500 dark:text-muted-foreground'>
        <span className='font-medium text-slate-700 dark:text-foreground'>
          Since entering this state
        </span>{' '}
        ({briefAgeText(data.days_in_state)}):{' '}
        {data.changed_total === 0 && data.comments === 0 && data.addendums.count === 0 ? (
          <span>no changes to this record.</span>
        ) : (
          <>
            {byPeople > 0 && (
              <span>
                {byPeople} field{byPeople === 1 ? '' : 's'} changed
                {data.edited_by.length > 0 ? ` by ${data.edited_by.join(', ')}` : ''}
              </span>
            )}
            {byPeople === 0 &&
              data.changed_total > 0 &&
              data.comments === 0 &&
              data.addendums.count === 0 && (
                <span>only values the record fills in itself changed.</span>
              )}
            {data.comments > 0 && (
              <span>
                {byPeople > 0 ? ' · ' : ''}
                {data.comments} comment{data.comments === 1 ? '' : 's'}
              </span>
            )}
            {data.addendums.count > 0 && (
              <span>
                {' · '}
                {data.addendums.count} addendum{data.addendums.count === 1 ? '' : 's'}
                {data.addendums.cost_impact !== 0
                  ? ` (${data.addendums.cost_impact > 0 ? '+' : ''}$${Math.abs(data.addendums.cost_impact).toLocaleString()})`
                  : ''}
              </span>
            )}
          </>
        )}
      </p>
      {data.field_changes.length > 0 && (
        <div className='mt-1 space-y-0.5'>
          {data.field_changes.slice(0, 5).map((f) => {
            // Labels, not column keys (army11 f3/f4 M5, a1 F-4); a long value is cut
            // around where the two differ, so the change itself stays visible.
            const pair = briefDiffPair(f.old, f.new)
            return (
              <p
                key={f.field}
                data-brief-change={f.field}
                className='text-[11px] text-slate-500 dark:text-muted-foreground'
              >
                <span className='font-medium text-slate-700 dark:text-foreground'>
                  {f.label || titleCase(f.field)}
                </span>
                {f.auto ? <span> (updated automatically)</span> : null}:{' '}
                {pair.old !== null && (
                  <>
                    <span className='text-red-600 line-through dark:text-red-400'>{pair.old}</span>
                    <span aria-hidden='true'> → </span>
                    <span className='sr-only'> changed to </span>
                  </>
                )}
                <span className='text-emerald-700 dark:text-emerald-400'>{pair.new}</span>
              </p>
            )
          })}
          {data.field_changes.length > 5 && (
            <p className='text-[10.5px] text-slate-400'>
              +{data.field_changes.length - 5} more — see History for the full trail
            </p>
          )}
        </div>
      )}
      {lines.map((l) => (
        <p
          key={`${l.label}:${l.text}`}
          data-brief-line={l.label}
          className='mt-1 text-slate-500 dark:text-muted-foreground'
        >
          <span className='font-medium text-slate-700 dark:text-foreground'>{l.label}</span>{' '}
          <span
            className={
              l.tone === 'danger'
                ? 'text-red-700 dark:text-red-300'
                : l.tone === 'warn'
                  ? 'text-amber-700 dark:text-amber-300'
                  : ''
            }
          >
            {l.text}
          </span>
        </p>
      ))}
    </div>
  )
}

function PipelinePanelInner({
  collection,
  item,
  defaultExpanded,
  title,
  showApprovalChain,
  hideActionsCollapsed,
  hideActionsExpanded,
  onBeforeTransition,
  addendumPending,
  addendumView,
  asRole
}: {
  collection: string
  item: string
  defaultExpanded?: boolean
  title?: string
  showApprovalChain?: boolean
  hideActionsCollapsed?: boolean
  hideActionsExpanded?: boolean
  onBeforeTransition?: () => boolean | Promise<boolean>
  addendumPending?: boolean
  addendumView?: boolean
  asRole?: string | null
}) {
  const client = useNivaroClient()
  const queryClient = useQueryClient()
  const { isAdmin: canMoveState } = useItemEditAuth()
  // The record's ⋯ menu → Move to state…: open the panel and its form here.
  const [moveSignal, setMoveSignal] = useState(0)
  const moveAnchorRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!canMoveState) return
    const onOpen = (e: Event) => {
      const d = (e as CustomEvent<OpenMoveStateRequest>).detail
      if (!d || d.claimed || d.collection !== collection || String(d.item) !== String(item)) return
      d.claimed = true
      setExpanded(true)
      setMoveSignal((n) => n + 1)
      setTimeout(
        () => moveAnchorRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
        80
      )
    }
    window.addEventListener(OPEN_MOVE_STATE_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_MOVE_STATE_EVENT, onOpen)
  }, [canMoveState, collection, item])
  const [comment, setComment] = useState('')
  const [pendingTransition, setPendingTransition] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [requirementsDialog, setRequirementsDialog] = useState<RequirementsDialogState | null>(null)
  // A refusal the caller can fix here (REFUSAL_FIX_ACTIONS), e.g. PRIORITY_REQUIRED.
  const [fixOffer, setFixOffer] = useState<RefusalFixOffer | null>(null)
  // A move pressed while a check would refuse it (its advisory): the notice opens on the fix.
  const [armedMove, setArmedMove] = useState<string | null>(null)
  // Brief lines that warned before a forward move (army6 D6): the confirm says "<move> anyway".
  const [forwardWarning, setForwardWarning] = useState<BriefLineView[]>([])
  const checkForwardMove = useForwardMoveCheck(collection, String(item))
  // #1722 — "Kim is approving" for the others, while this panel's confirm or requirements
  // dialog is open; and the same notice from anyone else's.
  useRecordSignalWhile(collection, item, 'transition', !!pendingTransition || !!requirementsDialog)
  const approvingNames = useRecordSignalPeers(collection, item, 'transition')
  const syncedFromProp = useRef(false)
  useEffect(() => {
    if (!syncedFromProp.current && defaultExpanded !== undefined) {
      syncedFromProp.current = true
      setExpanded(defaultExpanded)
    }
  }, [defaultExpanded])
  // One decision per press: a double click sent the transition twice (the
  // guard below is awaited, so the button had not disabled yet) and the twin
  // came back as an error toast.
  const transitionBusyRef = useRef(false)
  const runTransition = (vars: { transition_id: string; comment?: string; lock_ack?: boolean }) => {
    if (transitionBusyRef.current) return
    transitionBusyRef.current = true
    setFixOffer(null)
    executeTransition.mutate(vars, {
      onSettled: (_data, err) => {
        if (err) {
          transitionBusyRef.current = false
          return
        }
        // Stay busy until the record's pipeline read has come back (a15-8).
        void settle().finally(() => {
          transitionBusyRef.current = false
        })
      }
    })
  }
  const trySetPending = async (txId: string, opts?: { cleared?: boolean }) => {
    if (transitionBusyRef.current) return
    if (pendingTransition === txId) {
      setPendingTransition(null)
      return
    }
    // The server already said this move would be refused (its advisory): show why, and the
    // fix, instead of sending it off to be refused. Ask again in the background in case that
    // has changed. `cleared` = the fix just ran, the cached advisory is the old answer.
    if (
      !opts?.cleared &&
      (data?.available_transitions ?? []).some((t) => t.id === txId && t.advisory)
    ) {
      setPendingTransition(null)
      setFixOffer(null)
      setArmedMove(txId)
      void queryClient.invalidateQueries({ queryKey: ['pipeline-instance', collection, item] })
      return
    }
    setArmedMove(null)
    // The guard may save the form first, so it can be async — awaiting it is
    // what lets one click mean "save, then transition".
    if (onBeforeTransition) {
      transitionBusyRef.current = true
      let ok = false
      try {
        ok = await onBeforeTransition()
      } finally {
        transitionBusyRef.current = false
      }
      if (!ok) return
    }
    // Most transitions are simply "yes, move it on": a confirm step there is a
    // second click carrying no information. Only stop and ask when the
    // transition is configured to want a note.
    const tx = (transitions ?? []).find((t) => t.id === txId)
    const mode = String((tx as { comment_mode?: string } | undefined)?.comment_mode ?? 'none')
    // Terminal moves and partner orders always ask (army 11).
    const always = asksFirst(tx, data?.states ?? [], data?.instance?.current_state)
    if (mode !== 'optional' && mode !== 'required') {
      // army6 D6 — a forward move whose brief warns (forecast over / left) asks first.
      if (tx && !isSendBack(tx, data?.states ?? [], data?.instance?.current_state)) {
        transitionBusyRef.current = true
        let warnings: BriefLineView[] = []
        try {
          warnings = await checkForwardMove()
        } finally {
          transitionBusyRef.current = false
        }
        if (warnings.length > 0 || always) {
          setForwardWarning(warnings)
          setPendingTransition(txId)
          return
        }
      }
      if (always) {
        setForwardWarning([])
        setPendingTransition(txId)
        return
      }
      runTransition({ transition_id: txId })
      return
    }
    setForwardWarning([])
    setPendingTransition(txId)
  }
  // Same key as every other instance read on the page when no role preview is
  // active — three panels (header buttons, slot, summary strip) share one fetch.
  const queryKey = asRole
    ? ['pipeline-instance', collection, item, asRole]
    : ['pipeline-instance', collection, item]
  const { settling, settle } = useTransitionSettle(queryKey)
  const { data, isLoading } = useQuery<PipelinePanelData>({
    queryKey,
    queryFn: () =>
      client
        .request<{ data: PipelinePanelData | null }>(
          get(
            `/pipelines/instance/${collection}/${item}${asRole ? `?as_role=${encodeURIComponent(asRole)}` : ''}`
          )
        )
        .then(
          (r) =>
            r.data ?? {
              instance: null,
              states: [],
              available_transitions: [],
              all_transitions: [],
              history: [],
              binding: null
            }
        ),
    staleTime: 10_000
  })
  // army6 M19 — a button that newly appears in the slot is inert for a beat.
  const freshTx = useFreshTransitions(
    data ? (data.available_transitions ?? []).map((t) => String(t.id)) : null,
    `${collection}:${item}`
  )
  useEffect(
    () =>
      queryClient.getQueryCache().subscribe((event) => {
        if (event.type !== 'updated' || event.action.type !== 'success') return
        const k = event.query.queryKey
        if (Array.isArray(k) && k[0] === 'item' && k[1] === collection && String(k[2]) === item)
          queryClient.invalidateQueries({ queryKey: ['pipeline-instance', collection, item] })
      }),
    [queryClient, collection, item]
  )
  // Server-computed path relevance for the state track — same key/data as the
  // Approval Chain popover + OwnersSection, so the cache is shared.
  const { data: pathOwners, isLoading: pathOwnersLoading } = useQuery<Record<
    string,
    AllOwnersEntry
  > | null>({
    queryKey: ['pipeline-all-owners', collection, item],
    queryFn: () =>
      client
        .request<{ data: Record<string, AllOwnersEntry> | null }>(
          get(`/pipelines/instance/${collection}/${item}/owners/all`)
        )
        .then((r) => r.data ?? null),
    // Also when a send back is on offer: its target may be a chain step this record skipped.
    // And while a move is being confirmed: the panel names where it really lands.
    enabled: (expanded || hasSendBackOffer(data) || !!pendingTransition) && !!data?.instance,
    staleTime: 30_000
  })
  const onPathIds = useMemo(() => {
    if (!pathOwners) return null
    const entries = Object.entries(pathOwners)
    if (entries.length === 0 || entries.every(([, e]) => e.on_path === undefined)) return null
    return new Set(entries.filter(([, e]) => e.on_path !== false).map(([id]) => id))
  }, [pathOwners])

  // Which states this record will never enter, with the engine's own reason.
  // The approval chain already renders these; the track showed them as plain
  // grey, identical to states still ahead — so "skipped forever" and "coming
  // next" were indistinguishable.
  const skippedStates = useMemo(() => {
    if (!pathOwners) return null
    const out = new Map<string, string[]>()
    for (const [id, e] of Object.entries(pathOwners)) {
      if (e.skipped) out.set(id, e.skip_reasons ?? [])
    }
    return out
  }, [pathOwners])

  const startPipeline = useMutation({
    mutationFn: () => client.request(post(`/pipelines/instance/${collection}/${item}/start`, {})),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey })
      toast.success('Pipeline started')
    },
    onError: () => toast.error('Failed to start pipeline')
  })
  const executeTransition = useMutation({
    mutationFn: ({
      transition_id,
      comment,
      reviewed,
      lock_ack
    }: {
      transition_id: string
      comment?: string
      /** Set by the requirements dialog's re-submit: the rows were just reviewed. */
      reviewed?: boolean
      /** "<name> is editing this record" was shown and the person moves it anyway. */
      lock_ack?: boolean
    }) =>
      client.request(
        post(`/pipelines/instance/${collection}/${item}/transition`, {
          transition_id,
          comment,
          ...(reviewed ? { reviewed: true } : {}),
          ...(lock_ack ? { lock_ack: true } : {})
        })
      ),
    onMutate: (variables) => ({
      slow: slowMoveToast(
        [...(data?.available_transitions ?? []), ...(data?.all_transitions ?? [])].find(
          (t) => t.id === variables.transition_id
        )?.label
      )
    }),
    onSuccess: (res, variables, context) => {
      queryClient.invalidateQueries({ queryKey })
      if (collection === 'nivaro_addendums')
        queryClient.invalidateQueries({ queryKey: ['addendums'] })
      // A transition changes owners, integrations pushes and audience —
      // refresh the Record Insights popover caches too.
      invalidateRecordInsights(queryClient, collection, String(item))
      // ...and its on_success writes (order number, line sales_order_ids)
      // — the header and the child grids, so the form shows them at once.
      invalidateRecordData(queryClient, collection, String(item))
      // The header Owners tile + owner panels: the move changed who owns it.
      invalidateOwnerReads(queryClient, collection, String(item))
      setFixOffer(null)
      setComment('')
      setPendingTransition(null)
      setRequirementsDialog(null)
      toast.success(transitionToastText(data, variables.transition_id, res), context?.slow.done())
    },
    onError: (err: unknown, variables, context) => {
      context?.slow.fail()
      // The twin of a press already being applied (another tab, a retried
      // request): nothing was done twice — refresh quietly, no error toast.
      if (isDuplicateTransition(err)) {
        queryClient.invalidateQueries({ queryKey })
        return
      }
      // Someone else is editing it right now (army 11 f4 M4): say who, and let
      // the person wait or move it anyway — never a dead "Failed" toast.
      const lockedMove = lockedMoveOffer(err)
      if (lockedMove) {
        setPendingTransition(null)
        const label =
          [...(data?.available_transitions ?? []), ...(data?.all_transitions ?? [])].find(
            (t) => t.id === variables.transition_id
          )?.label ?? 'Move'
        toast.warning(lockedMove.message, {
          id: `nvr-locked-move:${collection}:${String(item)}`,
          duration: 20_000,
          action: {
            label: `${label} anyway`,
            onClick: () => runTransition({ ...variables, lock_ack: true })
          },
          cancel: { label: 'Wait', onClick: () => {} }
        })
        return
      }
      const requirements = transitionRequirementsFromError(err)
      if (requirements) {
        setRequirementsDialog((prev) => ({
          payload: requirements,
          transitionId: variables.transition_id,
          comment: variables.comment,
          revision: (prev?.revision ?? 0) + 1
        }))
        return
      }
      // Show the FULL server message — for a blocked external submission it
      // carries the transition label + HTTP status + response body, which is
      // what the user needs to act on. userErrorMessage reads `error` unless
      // it is only the status phrase, then `message`: a coded refusal from
      // the global handler answers {error: 'Forbidden', message: '<why>'}
      // and the toast used to say just "Forbidden".
      const resp = (err as { response?: { status?: number } })?.response
      // A refusal the caller may be able to fix right here (Priority flag).
      setFixOffer(refusalFixFor(err, variables))
      toast.error(userErrorMessage(err, 'Failed to execute transition'), {
        duration: 12000,
        // What to do next + Copy details (lib/error-toast.ts); "Why?" below wins the action slot.
        ...errorToastOptions(err, { action: 'Transition' }),
        // #1867: a refusal carries "Why?" — the role, owner or access rule
        // that stopped it, and who can change it.
        ...(isAccessRefusal(err)
          ? {
              action: deniedToastAction(client, {
                collection,
                itemId: String(item),
                action: 'transition',
                transitionId: variables.transition_id
              })
            }
          : {})
      })
      // A blocked transition (e.g. an ERP push failure) lands here as a plain 422:
      // the dialog's line values already saved — close it and refresh the
      // persistent failure banner immediately.
      setRequirementsDialog(null)
      setPendingTransition(null)
      // The push that just failed wrote a submission AND an obligation —
      // the failure banner and the partner lines refresh together, and so
      // does the record (an `on_error.set` status such as fusion_status=error).
      invalidateRecordInsights(queryClient, collection, String(item))
      invalidateRecordData(queryClient, collection, String(item))
      if (resp?.status === 409) {
        queryClient.invalidateQueries({ queryKey })
      }
    }
  })

  // A page-level "run this transition" request (lib/run-transition.ts — the
  // Integrations popup's "re-run <Submit to Warehouse>" fix) behaves exactly
  // like a click on the button: save first, then execute, dialogs and all.
  // First mount to hear it claims it; a transition not available from the
  // current step is claimed AND explained rather than silently dropped.
  const runTransitionRef = useRef(trySetPending)
  runTransitionRef.current = trySetPending
  const availableRef = useRef(data?.available_transitions ?? [])
  availableRef.current = data?.available_transitions ?? []
  useEffect(() => {
    const onRun = (ev: Event) => {
      const d = (ev as CustomEvent<RunTransitionRequest>).detail
      if (!d || d.claimed) return
      if (d.collection !== collection || String(d.item) !== String(item)) return
      d.claimed = true
      const wanted = String(d.transition_id).toUpperCase()
      const tx = availableRef.current.find((t) => String(t.id).toUpperCase() === wanted)
      if (!tx) {
        toast.error('That step is not available from where the record is now')
        return
      }
      void runTransitionRef.current(tx.id)
    }
    window.addEventListener(RUN_TRANSITION_EVENT, onRun)
    return () => window.removeEventListener(RUN_TRANSITION_EVENT, onRun)
  }, [collection, item])

  if (isLoading)
    // Collapsed-shell skeleton at the real header height (px-5 py-3.5 row) —
    // returning null here made the whole Progress bar pop in after load and
    // shove everything below it down.
    return (
      <div className='overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-border dark:bg-card'>
        <div className='flex w-full items-center gap-2.5 px-5 py-3.5'>
          <Skeleton className='h-3.5 w-3.5 shrink-0 rounded' />
          <Skeleton className='h-4 w-20' />
          <Skeleton className='h-[22px] w-40 rounded-full' />
          <Skeleton className='ml-auto h-3.5 w-3.5 rounded' />
        </div>
      </div>
    )
  if (!data?.binding) return null

  const { instance, available_transitions: transitions, history, states } = data
  const stateById = new Map((states ?? []).map((s) => [s.id, s]))
  const currentState = instance?.current_state_obj ?? null
  const pendingTx = pendingTransition
    ? (transitions ?? []).find((t) => t.id === pendingTransition)
    : null
  const pendingToState = pendingTx ? stateById.get(pendingTx.to_state) : null
  const landing = confirmLanding(pendingTx, currentState, states, pathOwners)
  const landedState = landing?.state ?? pendingToState
  // A completed instance normally shows no actions — EXCEPT escape hatches
  // authored FROM the terminal state the record sits in (Uncancel). Mirrors
  // the server guard exactly: any other transition would 400.
  const escapeTransitions =
    instance?.completed_at && transitions
      ? transitions.filter(
          (t) =>
            t.from_state &&
            String(t.from_state).toUpperCase() === String(instance.current_state).toUpperCase()
        )
      : null
  const visibleTransitions = instance?.completed_at
    ? (escapeTransitions ?? [])
    : withoutSkippedSendBacks(
        transitions ?? [],
        states ?? [],
        instance?.current_state,
        skippedStates
      )
  const hasTransitions = visibleTransitions.length > 0
  const moveNotices = distinctAdvisories(visibleTransitions)
  const armedTx = armedMove ? visibleTransitions.find((t) => t.id === armedMove) : null

  const renderTransitionButtons = (txList: PipelineTransition[], small = false) => {
    const byLabel = new Map<string, PipelineTransition[]>()
    for (const tx of txList) {
      const l = byLabel.get(tx.label) ?? []
      l.push(tx)
      byLabel.set(tx.label, l)
    }
    return Array.from(byLabel.entries()).map(([label, txs]) => {
      const txColor = txs[0]?.color ?? null
      const isActive = txs.some((t) => t.id === pendingTransition)
      const colorStyle = (active: boolean) =>
        txColor
          ? active
            ? { backgroundColor: txColor, borderColor: txColor }
            : { borderColor: txColor, color: txColor }
          : undefined
      if (txs.length === 1) {
        const tx = txs[0]
        const running =
          executeTransition.isPending && executeTransition.variables?.transition_id === tx.id
        return (
          <Button
            key={label}
            size='sm'
            variant={isActive ? 'default' : 'outline'}
            className={`${small ? 'h-7 text-[11px]' : 'text-[12px]'} gap-1.5 data-[fresh=true]:opacity-60`}
            style={colorStyle(isActive)}
            disabled={executeTransition.isPending || settling}
            aria-disabled={freshTx.dimmed(tx.id) || undefined}
            data-fresh={freshTx.dimmed(tx.id) || undefined}
            {...freshTx.bind(tx.id)}
            {...blockedMoveProps(tx)}
            onClick={() => {
              if (freshTx.press(tx.id)) void trySetPending(tx.id)
            }}
          >
            {running ? (
              <Loader2 className='h-3 w-3 animate-spin' />
            ) : (
              tx.advisory && <BlockedMark />
            )}
            {label}
          </Button>
        )
      }
      return (
        <DropdownMenu key={label}>
          <DropdownMenuTrigger asChild>
            <Button
              size='sm'
              variant={isActive ? 'default' : 'outline'}
              className={`${small ? 'h-7 text-[11px]' : 'text-[12px]'} gap-1.5`}
              style={colorStyle(isActive)}
              disabled={executeTransition.isPending || settling}
            >
              {label}
              <ChevronDown className='h-3 w-3' />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align='start'>
            {[...txs]
              .sort(
                (a, b) =>
                  (stateById.get(a.to_state)?.sort ?? 999) -
                  (stateById.get(b.to_state)?.sort ?? 999)
              )
              .map((tx) => (
                <DropdownMenuItem
                  key={tx.id}
                  onSelect={() => trySetPending(tx.id)}
                  {...blockedMoveProps(tx)}
                >
                  {tx.color && (
                    <span
                      className='mr-2 inline-block h-2 w-2 shrink-0 rounded-full'
                      style={{ backgroundColor: tx.color }}
                    />
                  )}
                  {stateById.get(tx.to_state)?.label ?? tx.to_state}
                  {tx.advisory && <BlockedMark className='ml-auto' />}
                </DropdownMenuItem>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )
    })
  }

  const fixPanel = fixOffer ? (
    <RefusalFixPanel
      collection={collection}
      item={String(item)}
      offer={fixOffer}
      onDismiss={() => setFixOffer(null)}
      onFixed={() =>
        runTransition({ transition_id: fixOffer.transitionId, comment: fixOffer.comment })
      }
    />
  ) : null
  const sendBack = latestSendBack(history ?? [], instance?.current_state, states ?? [])

  const confirmForm = (
    <div className='space-y-3 rounded-lg border border-slate-200 bg-slate-50 dark:bg-slate-900/30 dark:border-border p-3.5'>
      <div className='flex flex-wrap items-center gap-2'>
        <span className='text-[11px] font-semibold text-slate-400'>Confirming</span>
        {pendingTx && (
          <span className='text-[12px] font-medium text-slate-700'>{pendingTx.label}</span>
        )}
        {currentState && landedState && (
          <div className='ml-auto flex items-center gap-1.5'>
            <StateBadge label={currentState.label} color={currentState.color} small />
            <ArrowRight className='h-3 w-3 shrink-0 text-slate-300' />
            <StateBadge label={landedState.label} color={landedState.color} small />
          </div>
        )}
      </div>
      <LandingNote landing={landing} />
      <OrderSendNote collection={collection} item={String(item)} tx={pendingTx} />
      <ApprovalBriefStrip collection={collection} item={item} omitLines={forwardWarning} />
      <ForwardMoveWarning lines={forwardWarning} />
      <input
        type='text'
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder={
          String((pendingTx as { comment_mode?: string } | undefined)?.comment_mode ?? '') ===
          'required'
            ? 'Add a note (required)'
            : 'Add a comment (optional)'
        }
        className='w-full rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[13px] placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-nvr-cyan/30'
      />
      <div className='flex items-center justify-end gap-2'>
        <Button
          type='button'
          size='sm'
          variant='ghost'
          className='h-7 text-[12px]'
          onClick={() => setPendingTransition(null)}
        >
          Cancel
        </Button>
        <Button
          type='button'
          size='sm'
          className='h-7 gap-1.5 text-[12px]'
          // A required note that can be skipped is not required.
          disabled={
            executeTransition.isPending ||
            (String((pendingTx as { comment_mode?: string } | undefined)?.comment_mode ?? '') ===
              'required' &&
              comment.trim() === '')
          }
          onClick={() =>
            runTransition({
              transition_id: pendingTransition!,
              comment: comment.trim() || undefined
            })
          }
        >
          {executeTransition.isPending ? (
            <Loader2 className='h-3.5 w-3.5 animate-spin' />
          ) : (
            <>
              <span>
                {forwardWarning.length > 0 && pendingTx ? `${pendingTx.label} anyway` : 'Confirm'}
              </span>
              <Check className='h-3 w-3' />
            </>
          )}
        </Button>
      </div>
    </div>
  )

  return (
    <>
      <div
        className={`overflow-hidden rounded-xl border bg-white dark:bg-card ${addendumView ? 'border-amber-300 dark:border-amber-600/50' : 'border-slate-200 dark:border-border'}`}
      >
        <div
          role='button'
          tabIndex={0}
          onClick={() => setExpanded((v) => !v)}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setExpanded((v) => !v)}
          className='flex w-full cursor-pointer items-center gap-2.5 px-5 py-3.5 transition-colors hover:bg-slate-50/50 dark:hover:bg-white/[0.02]'
        >
          <GitBranch className='h-3.5 w-3.5 shrink-0 text-slate-400' />
          <span className='text-[13px] font-medium text-slate-800 dark:text-slate-200'>
            {title || 'Pipeline'}
          </span>
          <div className='flex items-center gap-1.5'>
            {addendumView && (
              <span className='flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-400'>
                Addendum workflow
              </span>
            )}
            {currentState && <StateBadge label={currentState.label} color={currentState.color} />}
            <RecordFlagChips flags={data?.flags} />
            {(data?.auto_held?.length ?? 0) > 0 && (
              <span
                className='flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-400'
                data-tip={(data?.auto_held ?? [])
                  .map((h) => `${h.transition_label ?? 'Automatic move'}: ${h.error ?? 'refused'}`)
                  .join('\n')}
                data-pipeline-auto-held-pill
              >
                <AlertTriangle className='h-3 w-3 shrink-0' />
                Needs a person
              </span>
            )}
            {addendumPending && (
              <span className='flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 border border-amber-200 dark:bg-amber-500/10 dark:text-amber-400 dark:border-amber-500/20'>
                <span className='h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse shrink-0' />
                Addendum in review
              </span>
            )}
            {approvingNames.length > 0 && (
              <span
                className='flex items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-medium text-sky-700 dark:border-sky-500/20 dark:bg-sky-500/10 dark:text-sky-300'
                data-pipeline-approving
              >
                <span className='h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-sky-400' />
                {signalSentence(approvingNames, 'approving')}
              </span>
            )}
          </div>
          <div className='ml-auto flex items-center gap-2' onClick={(e) => e.stopPropagation()}>
            {!expanded && hasTransitions && !hideActionsCollapsed && (
              <div className='flex flex-wrap items-center gap-1.5'>
                {renderTransitionButtons(visibleTransitions, true)}
              </div>
            )}
            {!expanded && !instance && data?.binding && (
              <Button
                size='sm'
                variant='outline'
                className='h-7 gap-1.5 text-[11px]'
                onClick={(e) => {
                  e.stopPropagation()
                  startPipeline.mutate()
                }}
                disabled={startPipeline.isPending}
              >
                {startPipeline.isPending ? (
                  <Loader2 className='h-3 w-3 animate-spin' />
                ) : (
                  <GitBranch className='h-3 w-3' />
                )}
                Start
              </Button>
            )}
            {/* Instance-only workflows (addendums) have no collection binding —
                the chain resolves from the instance's template server-side. */}
            {showApprovalChain && (data?.binding || data?.instance) && (
              <ApprovalChainView
                collection={collection}
                item={item}
                states={states ?? []}
                currentStateId={data?.instance?.current_state ?? null}
              />
            )}
          </div>
          <ChevronDown
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-150',
              expanded && 'rotate-180'
            )}
          />
        </div>
        {/* A move a check would refuse says so here, before it is pressed — open or folded. */}
        {moveNotices.map(({ advisory, moves }) => (
          <MoveAdvisoryNotice
            key={`${advisory.code}:${advisory.message}`}
            collection={collection}
            item={String(item)}
            advisory={advisory}
            armedMove={
              armedTx && moves.some((m) => m.id === armedTx.id)
                ? { id: armedTx.id, label: armedTx.label }
                : null
            }
            onDismiss={() => setArmedMove(null)}
            onFixed={(thenMove) => {
              setArmedMove(null)
              void queryClient.invalidateQueries({ queryKey })
              if (thenMove) void trySetPending(thenMove.id, { cleared: true })
            }}
          />
        ))}
        {!expanded && pendingTransition && (
          <div className='border-t border-slate-100 dark:border-border/60 px-4 py-3'>
            {confirmForm}
          </div>
        )}
        {!expanded && fixPanel && (
          <div className='border-t border-slate-100 dark:border-border/60 px-4 py-3'>
            {fixPanel}
          </div>
        )}
        {/* Why it came back — shown open or folded, while it sits where it was sent. */}
        {sendBack && !instance?.completed_at && <SendBackNotice entry={sendBack} />}
        {expanded && (
          <div className='border-t border-slate-100 dark:border-border/60'>
            <AutoHeldNotice held={data?.auto_held ?? []} />
            {addendumPending && (
              <div className='flex items-center gap-2 border-b border-amber-100 bg-amber-50 px-5 py-2.5 dark:border-amber-500/20 dark:bg-amber-500/10'>
                <span className='h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0' />
                <p className='text-[12px] text-amber-700 dark:text-amber-400'>
                  An addendum is in review — coordinate transitions carefully.
                </p>
              </div>
            )}
            {!instance ? (
              <div className='flex items-center justify-between gap-4 px-5 py-4'>
                <p className='text-[13px] text-slate-500'>Pipeline not started for this record.</p>
                <Button
                  size='sm'
                  variant='outline'
                  className='shrink-0 gap-1.5 text-[12px]'
                  onClick={() => startPipeline.mutate()}
                  disabled={startPipeline.isPending}
                >
                  {startPipeline.isPending ? (
                    <Loader2 className='h-3.5 w-3.5 animate-spin' />
                  ) : (
                    <GitBranch className='h-3.5 w-3.5' />
                  )}
                  Start Pipeline
                </Button>
              </div>
            ) : (
              <div className='divide-y divide-slate-100 dark:divide-border/60'>
                {(states ?? []).length > 1 && (
                  <div className='space-y-3 px-5 py-4'>
                    {pathOwnersLoading ? (
                      // Path pruning arrives with the owners query — rendering
                      // the UNPRUNED track first meant every state briefly
                      // showed, then snapped into formation. Hold a same-height
                      // placeholder until the real shape is known.
                      <div className='flex h-[52px] items-center gap-2'>
                        {[0, 1, 2, 3, 4].map((i) => (
                          <span key={i} className='flex items-center gap-2'>
                            <Skeleton className='h-7 w-7 rounded-full' />
                            {i < 4 && <Skeleton className='h-0.5 w-10' />}
                          </span>
                        ))}
                        <Skeleton className='ml-2 h-3 w-24' />
                      </div>
                    ) : (
                      <StateTrack
                        states={states}
                        allTransitions={data?.all_transitions ?? []}
                        availableTransitions={transitions ?? []}
                        currentStateId={instance.current_state}
                        history={history ?? []}
                        onPathIds={onPathIds}
                        skippedStates={skippedStates}
                      />
                    )}
                    {data?.branches && <BranchLanes data={data.branches} />}
                    <StateDurationTimeline
                      history={history ?? []}
                      completedAt={instance.completed_at}
                    />
                  </div>
                )}
                <div className='space-y-3 px-5 py-4'>
                  {/* This step's SLA clock + Adjust clock (#1239); null without a rule. */}
                  {!instance.completed_at && (
                    <SlaClockLine collection={collection} itemId={String(item)} />
                  )}
                  <OwnersSection
                    collection={collection}
                    item={item}
                    states={states ?? []}
                    currentStateId={data?.instance?.current_state ?? null}
                    returned={(data?.history ?? []).some(
                      (h) => !!h.from_state && h.to_state === data?.instance?.current_state
                    )}
                  />
                </div>
                {hasTransitions && !hideActionsExpanded && (
                  <div className='space-y-3 px-5 py-4'>
                    <div className='flex flex-wrap justify-end gap-2'>
                      {renderTransitionButtons(visibleTransitions)}
                    </div>
                    {pendingTransition && confirmForm}
                    {fixPanel}
                  </div>
                )}
                <div className='px-5 py-3'>
                  <button
                    type='button'
                    className='flex items-center gap-1.5 text-[12px] text-slate-400 transition-colors hover:text-slate-600'
                    onClick={() => setShowHistory((v) => !v)}
                  >
                    <ChevronDown
                      className={cn(
                        'h-3.5 w-3.5 transition-transform duration-200',
                        showHistory && 'rotate-180'
                      )}
                    />
                    Transition history{' '}
                    <span className='tabular-nums'>({history?.length ?? 0})</span>
                  </button>
                  {showHistory && (
                    <div className='mt-3'>
                      <HistoryTimeline history={history ?? []} />
                    </div>
                  )}
                </div>
                {canMoveState && (states ?? []).length > 1 && (
                  <div className='px-5 py-3' ref={moveAnchorRef}>
                    <MoveToStatePanel
                      collection={collection}
                      item={item}
                      states={states ?? []}
                      currentStateId={instance.current_state ?? null}
                      openSignal={moveSignal}
                      onMoved={() => {
                        void queryClient.invalidateQueries({ queryKey })
                        void queryClient.invalidateQueries({
                          queryKey: ['pipeline-instance', collection, item]
                        })
                      }}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      {requirementsDialog && (
        <Suspense fallback={null}>
          <TransitionRequirementsDialog
            key={requirementsDialog.revision}
            payload={requirementsDialog.payload}
            transitionId={requirementsDialog.transitionId}
            isRetry={requirementsDialog.revision > 1}
            onSubmitted={() =>
              // mutateAsync so the dialog can stay busy until the transition
              // settles; the mutation's own onError/onSuccess handle the outcome.
              executeTransition
                .mutateAsync({
                  transition_id: requirementsDialog.transitionId,
                  comment: requirementsDialog.comment,
                  reviewed: true
                })
                .catch(() => undefined)
            }
            executing={executeTransition.isPending}
            onClose={() => setRequirementsDialog(null)}
          />
        </Suspense>
      )}
    </>
  )
}

// ─── Transition buttons (for use next to Save button) ────────────────────────

export function PipelineTransitionButtons({
  collection,
  item,
  onBeforeTransition,
  wrap = true
}: {
  collection: string
  item: string
  onBeforeTransition?: () => boolean | Promise<boolean>
  /** false = single-line buttons (header hosting): wrapping would absorb the
   *  width pressure the header's overflow-collapse logic needs to see. When
   *  the header row still overflows with its tool strip folded, the buttons
   *  fold into one "Actions" menu so every step stays reachable. */
  wrap?: boolean
}) {
  if (item === 'new') return null
  return (
    <PipelineTransitionButtonsInner
      collection={collection}
      item={item}
      onBeforeTransition={onBeforeTransition}
      wrap={wrap}
    />
  )
}

function PipelineTransitionButtonsInner({
  collection,
  item,
  onBeforeTransition,
  wrap = true
}: {
  collection: string
  item: string
  onBeforeTransition?: () => boolean | Promise<boolean>
  wrap?: boolean
}) {
  const client = useNivaroClient()
  const queryClient = useQueryClient()
  const [comment, setComment] = useState('')
  const [pendingTransition, setPendingTransition] = useState<string | null>(null)
  const [requirementsDialog, setRequirementsDialog] = useState<RequirementsDialogState | null>(null)
  // A refusal the caller can fix here (REFUSAL_FIX_ACTIONS), e.g. PRIORITY_REQUIRED.
  const [fixOffer, setFixOffer] = useState<RefusalFixOffer | null>(null)
  // A move pressed while a check would refuse it (its advisory): the notice opens on the fix.
  const [armedMove, setArmedMove] = useState<string | null>(null)
  // Brief lines that warned before a forward move (army6 D6): the confirm says "<move> anyway".
  const [forwardWarning, setForwardWarning] = useState<BriefLineView[]>([])
  const checkForwardMove = useForwardMoveCheck(collection, String(item))
  // #1722 — other viewers of the record see "Kim is approving" while this dialog is open.
  useRecordSignalWhile(collection, item, 'transition', !!pendingTransition || !!requirementsDialog)
  const rootRef = useRef<HTMLDivElement>(null)
  const folded = useHeaderFold(rootRef, !wrap)
  // One decision per press: a double click sent the transition twice (the
  // guard below is awaited, so the button had not disabled yet) and the twin
  // came back as an error toast.
  const transitionBusyRef = useRef(false)
  const runTransition = (vars: { transition_id: string; comment?: string; lock_ack?: boolean }) => {
    if (transitionBusyRef.current) return
    transitionBusyRef.current = true
    setFixOffer(null)
    executeTransition.mutate(vars, {
      onSettled: (_data, err) => {
        if (err) {
          transitionBusyRef.current = false
          return
        }
        // Stay busy until the record's pipeline read has come back (a15-8).
        void settle().finally(() => {
          transitionBusyRef.current = false
        })
      }
    })
  }
  const trySetPending = async (txId: string, opts?: { cleared?: boolean }) => {
    if (transitionBusyRef.current) return
    if (pendingTransition === txId) {
      setPendingTransition(null)
      return
    }
    // The server already said this move would be refused (its advisory): show why, and the
    // fix, instead of sending it off to be refused. Ask again in the background in case that
    // has changed. `cleared` = the fix just ran, the cached advisory is the old answer.
    if (
      !opts?.cleared &&
      (data?.available_transitions ?? []).some((t) => t.id === txId && t.advisory)
    ) {
      setPendingTransition(null)
      setFixOffer(null)
      setArmedMove(txId)
      void queryClient.invalidateQueries({ queryKey: ['pipeline-instance', collection, item] })
      return
    }
    setArmedMove(null)
    // The guard may save the form first, so it can be async — awaiting it is
    // what lets one click mean "save, then transition".
    if (onBeforeTransition) {
      transitionBusyRef.current = true
      let ok = false
      try {
        ok = await onBeforeTransition()
      } finally {
        transitionBusyRef.current = false
      }
      if (!ok) return
    }
    // Most transitions are simply "yes, move it on": a confirm step there is a
    // second click carrying no information. Only stop and ask when the
    // transition is configured to want a note.
    const tx = (transitions ?? []).find((t) => t.id === txId)
    const mode = String((tx as { comment_mode?: string } | undefined)?.comment_mode ?? 'none')
    // Terminal moves and partner orders always ask (army 11).
    const always = asksFirst(tx, data?.states ?? [], data?.instance?.current_state)
    if (mode !== 'optional' && mode !== 'required') {
      // army6 D6 — a forward move whose brief warns (forecast over / left) asks first.
      if (tx && !isSendBack(tx, data?.states ?? [], data?.instance?.current_state)) {
        transitionBusyRef.current = true
        let warnings: BriefLineView[] = []
        try {
          warnings = await checkForwardMove()
        } finally {
          transitionBusyRef.current = false
        }
        if (warnings.length > 0 || always) {
          setForwardWarning(warnings)
          setPendingTransition(txId)
          return
        }
      }
      if (always) {
        setForwardWarning([])
        setPendingTransition(txId)
        return
      }
      runTransition({ transition_id: txId })
      return
    }
    setForwardWarning([])
    setPendingTransition(txId)
  }
  const queryKey = ['pipeline-instance', collection, item]
  const { settling, settle } = useTransitionSettle(queryKey)
  const { data } = useQuery<PipelinePanelData>({
    queryKey,
    queryFn: () =>
      client
        .request<{ data: PipelinePanelData | null }>(
          get(`/pipelines/instance/${collection}/${item}`)
        )
        .then(
          (r) =>
            r.data ?? {
              instance: null,
              states: [],
              available_transitions: [],
              all_transitions: [],
              history: [],
              binding: null
            }
        ),
    staleTime: 10_000
  })
  // army6 M19 — a button that newly appears in the slot is inert for a beat.
  const freshTx = useFreshTransitions(
    data ? (data.available_transitions ?? []).map((t) => String(t.id)) : null,
    `${collection}:${item}`
  )
  // Same key as the panel's chain read: shared cache, fetched here only for a send back's sake.
  const { data: chainOwners } = useQuery<Record<string, AllOwnersEntry> | null>({
    queryKey: ['pipeline-all-owners', collection, item],
    queryFn: () =>
      client
        .request<{ data: Record<string, AllOwnersEntry> | null }>(
          get(`/pipelines/instance/${collection}/${item}/owners/all`)
        )
        .then((r) => r.data ?? null),
    // Also while a move is being confirmed: the panel names where it really lands.
    enabled: hasSendBackOffer(data) || !!pendingTransition,
    staleTime: 30_000
  })
  const skippedChain = useMemo(() => {
    if (!chainOwners) return null
    const out = new Map<string, string[]>()
    for (const [id, e] of Object.entries(chainOwners))
      if (e.skipped) out.set(id, e.skip_reasons ?? [])
    return out
  }, [chainOwners])
  const executeTransition = useMutation({
    mutationFn: ({
      transition_id,
      comment,
      reviewed,
      lock_ack
    }: {
      transition_id: string
      comment?: string
      /** Set by the requirements dialog's re-submit: the rows were just reviewed. */
      reviewed?: boolean
      /** "<name> is editing this record" was shown and the person moves it anyway. */
      lock_ack?: boolean
    }) =>
      client.request(
        post(`/pipelines/instance/${collection}/${item}/transition`, {
          transition_id,
          comment,
          ...(reviewed ? { reviewed: true } : {}),
          ...(lock_ack ? { lock_ack: true } : {})
        })
      ),
    onMutate: (variables) => ({
      slow: slowMoveToast(
        [...(data?.available_transitions ?? []), ...(data?.all_transitions ?? [])].find(
          (t) => t.id === variables.transition_id
        )?.label
      )
    }),
    onSuccess: (res, variables, context) => {
      queryClient.invalidateQueries({ queryKey })
      if (collection === 'nivaro_addendums')
        queryClient.invalidateQueries({ queryKey: ['addendums'] })
      // A transition changes owners, integrations pushes and audience —
      // refresh the Record Insights popover caches too.
      invalidateRecordInsights(queryClient, collection, String(item))
      // ...and its on_success writes (order number, line sales_order_ids)
      // — the header and the child grids, so the form shows them at once.
      invalidateRecordData(queryClient, collection, String(item))
      // The header Owners tile + owner panels: the move changed who owns it.
      invalidateOwnerReads(queryClient, collection, String(item))
      setFixOffer(null)
      setComment('')
      setPendingTransition(null)
      setRequirementsDialog(null)
      toast.success(transitionToastText(data, variables.transition_id, res), context?.slow.done())
    },
    onError: (err: unknown, variables, context) => {
      context?.slow.fail()
      // The twin of a press already being applied (another tab, a retried
      // request): nothing was done twice — refresh quietly, no error toast.
      if (isDuplicateTransition(err)) {
        queryClient.invalidateQueries({ queryKey })
        return
      }
      // Someone else is editing it right now (army 11 f4 M4): say who, and let
      // the person wait or move it anyway — never a dead "Failed" toast.
      const lockedMove = lockedMoveOffer(err)
      if (lockedMove) {
        setPendingTransition(null)
        const label =
          [...(data?.available_transitions ?? []), ...(data?.all_transitions ?? [])].find(
            (t) => t.id === variables.transition_id
          )?.label ?? 'Move'
        toast.warning(lockedMove.message, {
          id: `nvr-locked-move:${collection}:${String(item)}`,
          duration: 20_000,
          action: {
            label: `${label} anyway`,
            onClick: () => runTransition({ ...variables, lock_ack: true })
          },
          cancel: { label: 'Wait', onClick: () => {} }
        })
        return
      }
      const requirements = transitionRequirementsFromError(err)
      if (requirements) {
        setRequirementsDialog((prev) => ({
          payload: requirements,
          transitionId: variables.transition_id,
          comment: variables.comment,
          revision: (prev?.revision ?? 0) + 1
        }))
        return
      }
      // Show the FULL server message — for a blocked external submission it
      // carries the transition label + HTTP status + response body, which is
      // what the user needs to act on. userErrorMessage reads `error` unless
      // it is only the status phrase, then `message`: a coded refusal from
      // the global handler answers {error: 'Forbidden', message: '<why>'}
      // and the toast used to say just "Forbidden".
      const resp = (err as { response?: { status?: number } })?.response
      // A refusal the caller may be able to fix right here (Priority flag).
      setFixOffer(refusalFixFor(err, variables))
      toast.error(userErrorMessage(err, 'Failed to execute transition'), {
        duration: 12000,
        // What to do next + Copy details (lib/error-toast.ts); "Why?" below wins the action slot.
        ...errorToastOptions(err, { action: 'Transition' }),
        // #1867: a refusal carries "Why?" — the role, owner or access rule
        // that stopped it, and who can change it.
        ...(isAccessRefusal(err)
          ? {
              action: deniedToastAction(client, {
                collection,
                itemId: String(item),
                action: 'transition',
                transitionId: variables.transition_id
              })
            }
          : {})
      })
      // A blocked transition (e.g. an ERP push failure) lands here as a plain 422:
      // the dialog's line values already saved — close it and refresh the
      // persistent failure banner immediately.
      setRequirementsDialog(null)
      setPendingTransition(null)
      // The push that just failed wrote a submission AND an obligation —
      // the failure banner and the partner lines refresh together, and so
      // does the record (an `on_error.set` status such as fusion_status=error).
      invalidateRecordInsights(queryClient, collection, String(item))
      invalidateRecordData(queryClient, collection, String(item))
      if (resp?.status === 409) {
        queryClient.invalidateQueries({ queryKey })
      }
    }
  })

  // A page-level "run this transition" request (lib/run-transition.ts — the
  // Integrations popup's "re-run <Submit to Warehouse>" fix) behaves exactly
  // like a click on the button: save first, then execute, dialogs and all.
  // First mount to hear it claims it; a transition not available from the
  // current step is claimed AND explained rather than silently dropped.
  const runTransitionRef = useRef(trySetPending)
  runTransitionRef.current = trySetPending
  const availableRef = useRef(data?.available_transitions ?? [])
  availableRef.current = data?.available_transitions ?? []
  useEffect(() => {
    const onRun = (ev: Event) => {
      const d = (ev as CustomEvent<RunTransitionRequest>).detail
      if (!d || d.claimed) return
      if (d.collection !== collection || String(d.item) !== String(item)) return
      d.claimed = true
      const wanted = String(d.transition_id).toUpperCase()
      const tx = availableRef.current.find((t) => String(t.id).toUpperCase() === wanted)
      if (!tx) {
        toast.error('That step is not available from where the record is now')
        return
      }
      void runTransitionRef.current(tx.id)
    }
    window.addEventListener(RUN_TRANSITION_EVENT, onRun)
    return () => window.removeEventListener(RUN_TRANSITION_EVENT, onRun)
  }, [collection, item])

  if (!data?.binding || !data?.instance) return null
  // Completed instances keep only escape hatches from their terminal state
  // (Uncancel) — everything else would 400 server-side.
  const transitions = withoutSkippedSendBacks(
    (data.available_transitions ?? []).filter(
      (t) =>
        !data.instance!.completed_at ||
        (t.from_state &&
          String(t.from_state).toUpperCase() === String(data.instance!.current_state).toUpperCase())
    ),
    data.states ?? [],
    data.instance.current_state,
    data.instance.completed_at ? null : skippedChain
  )
  if (transitions.length === 0) return null
  const stateById = new Map((data.states ?? []).map((s) => [s.id, s]))
  const currentState = data.instance.current_state_obj ?? null
  const pendingTx = pendingTransition ? transitions.find((t) => t.id === pendingTransition) : null
  const armedTx = armedMove ? transitions.find((t) => t.id === armedMove) : null
  const pendingToState = pendingTx ? stateById.get(pendingTx.to_state) : null
  const landing = confirmLanding(pendingTx, currentState, data.states ?? [], chainOwners)
  const landedState = landing?.state ?? pendingToState
  const byLabel = new Map<string, PipelineTransition[]>()
  for (const tx of transitions) {
    const l = byLabel.get(tx.label) ?? []
    l.push(tx)
    byLabel.set(tx.label, l)
  }
  const sortByTarget = (txs: PipelineTransition[]) =>
    [...txs].sort(
      (a, b) => (stateById.get(a.to_state)?.sort ?? 999) - (stateById.get(b.to_state)?.sort ?? 999)
    )
  // The confirm panel opens leftwards from the buttons; on a phone-width
  // sheet 600px would run off the sheet's left edge, where it is clipped.
  const confirmWidth = (() => {
    const box = rootRef.current?.getBoundingClientRect()
    if (!box) return 600
    const host = rootRef.current?.closest('[role="dialog"]')?.getBoundingClientRect()
    return Math.max(260, Math.min(600, box.right - (host?.left ?? 0) - 12))
  })()

  return (
    <div ref={rootRef} className='relative'>
      {folded ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size='sm'
              variant='outline'
              className='shrink-0 gap-1.5 text-[12px]'
              disabled={executeTransition.isPending || settling}
              data-transitions-folded
            >
              {executeTransition.isPending && <Loader2 className='h-3 w-3 animate-spin' />}
              Actions
              <ChevronDown className='h-3 w-3' />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align='end' className='min-w-[200px]'>
            {Array.from(byLabel.entries()).map(([label, txs], gi, all) =>
              txs.length === 1 ? (
                <DropdownMenuGroup key={label}>
                  {/* A plain step right after a labelled group is set apart
                    from it, or it reads as one more target of that group. */}
                  {gi > 0 && all[gi - 1][1].length > 1 && <DropdownMenuSeparator />}
                  <DropdownMenuItem
                    onSelect={() => trySetPending(txs[0].id)}
                    {...blockedMoveProps(txs[0])}
                  >
                    {txs[0].color && (
                      <span
                        className='mr-2 inline-block h-2 w-2 shrink-0 rounded-full'
                        style={{ backgroundColor: txs[0].color }}
                      />
                    )}
                    {label}
                    {txs[0].advisory && <BlockedMark className='ml-auto' />}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              ) : (
                <DropdownMenuGroup key={label}>
                  {gi > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuLabel className='text-[11px] text-muted-foreground'>
                    {label}
                  </DropdownMenuLabel>
                  {sortByTarget(txs).map((tx) => (
                    <DropdownMenuItem
                      key={tx.id}
                      onSelect={() => trySetPending(tx.id)}
                      {...blockedMoveProps(tx)}
                    >
                      {tx.color && (
                        <span
                          className='mr-2 inline-block h-2 w-2 shrink-0 rounded-full'
                          style={{ backgroundColor: tx.color }}
                        />
                      )}
                      {stateById.get(tx.to_state)?.label ?? tx.to_state}
                      {tx.advisory && <BlockedMark className='ml-auto' />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              )
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <div
          className={
            wrap
              ? 'flex flex-wrap justify-end gap-2'
              : 'flex shrink-0 items-center justify-end gap-2'
          }
        >
          {/* Flags (On hold, Sent back) show once, beside the state in the
              Pipeline panel — a second copy here squeezed the action row
              (Rob 2026-11-11). */}
          {Array.from(byLabel.entries()).map(([label, txs]) => {
            // A partner order never wears an approval colour (army 11 a2 F2):
            // neutral outline + a send glyph, and it always asks first.
            const isOrder = txs.some((t) => (t.order_partners?.length ?? 0) > 0)
            const txColor = isOrder ? null : (txs[0]?.color ?? null)
            const isActive = txs.some((t) => t.id === pendingTransition)
            const colorStyle = (active: boolean) =>
              txColor
                ? active
                  ? { backgroundColor: txColor, borderColor: txColor }
                  : { borderColor: txColor, color: txColor }
                : undefined
            if (txs.length === 1) {
              const tx = txs[0]
              const running =
                executeTransition.isPending && executeTransition.variables?.transition_id === tx.id
              const button = (
                <Button
                  key={label}
                  size='sm'
                  variant={isActive ? 'default' : 'outline'}
                  className='gap-1.5 text-[12px] data-[fresh=true]:opacity-60'
                  style={colorStyle(isActive)}
                  disabled={executeTransition.isPending || settling}
                  aria-disabled={freshTx.dimmed(tx.id) || undefined}
                  data-fresh={freshTx.dimmed(tx.id) || undefined}
                  {...freshTx.bind(tx.id)}
                  {...blockedMoveProps(tx)}
                  onClick={() => {
                    if (freshTx.press(tx.id)) void trySetPending(tx.id)
                  }}
                >
                  {running ? (
                    <Loader2 className='h-3 w-3 animate-spin' />
                  ) : tx.advisory ? (
                    <BlockedMark />
                  ) : (
                    isOrder && <Send className='h-3 w-3' aria-hidden />
                  )}
                  {label}
                </Button>
              )
              // #616 — a step that sends something to a partner says, before
              // it is pressed, whether what it sends is complete.
              if (!(tx.pushes && tx.pushes > 0)) return button
              return (
                <span key={label} className='relative inline-flex'>
                  {button}
                  <PushReadinessChip
                    collection={collection}
                    itemId={item}
                    transitionId={tx.id}
                    label={label}
                    compact
                  />
                </span>
              )
            }
            return (
              <DropdownMenu key={label}>
                <DropdownMenuTrigger asChild>
                  <Button
                    size='sm'
                    variant={isActive ? 'default' : 'outline'}
                    className='gap-1.5 text-[12px]'
                    style={colorStyle(isActive)}
                    disabled={executeTransition.isPending || settling}
                  >
                    {label}
                    <ChevronDown className='h-3 w-3' />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align='start'>
                  {sortByTarget(txs).map((tx) => (
                    <DropdownMenuItem
                      key={tx.id}
                      onSelect={() => trySetPending(tx.id)}
                      {...blockedMoveProps(tx)}
                    >
                      {tx.color && (
                        <span
                          className='mr-2 inline-block h-2 w-2 shrink-0 rounded-full'
                          style={{ backgroundColor: tx.color }}
                        />
                      )}
                      {stateById.get(tx.to_state)?.label ?? tx.to_state}
                      {tx.advisory && <BlockedMark className='ml-auto' />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )
          })}
        </div>
      )}
      {pendingTransition && (
        <div
          className='absolute right-0 top-full z-50 mt-1 space-y-3 rounded-lg border border-slate-200 bg-white shadow-lg dark:bg-card dark:border-border p-3.5'
          style={{ width: confirmWidth }}
        >
          <div className='flex flex-wrap items-center gap-2'>
            <span className='text-[11px] font-semibold text-slate-400'>Confirming</span>
            {pendingTx && (
              <span className='text-[12px] font-medium text-slate-700'>{pendingTx.label}</span>
            )}
            {currentState && landedState && (
              <div className='ml-auto flex items-center gap-1.5'>
                <StateBadge label={currentState.label} color={currentState.color} small />
                <ArrowRight className='h-3 w-3 shrink-0 text-slate-300' />
                <StateBadge label={landedState.label} color={landedState.color} small />
              </div>
            )}
          </div>
          <LandingNote landing={landing} />
          <OrderSendNote collection={collection} item={String(item)} tx={pendingTx} />
          <ApprovalBriefStrip collection={collection} item={item} omitLines={forwardWarning} />
          <ForwardMoveWarning lines={forwardWarning} />
          <input
            type='text'
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={
              String((pendingTx as { comment_mode?: string } | null)?.comment_mode ?? '') ===
              'required'
                ? 'Add a note (required)'
                : 'Add a comment (optional)'
            }
            className='w-full rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[13px] placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-nvr-cyan/30'
          />
          <div className='flex items-center justify-end gap-2'>
            <Button
              type='button'
              size='sm'
              variant='ghost'
              className='h-7 text-[12px]'
              onClick={() => setPendingTransition(null)}
            >
              Cancel
            </Button>
            <Button
              type='button'
              size='sm'
              className='h-7 gap-1.5 text-[12px]'
              // Same rule as the panel's confirm: a required note must be
              // filled in before this commits.
              disabled={
                executeTransition.isPending ||
                (String((pendingTx as { comment_mode?: string } | null)?.comment_mode ?? '') ===
                  'required' &&
                  comment.trim() === '')
              }
              onClick={() =>
                runTransition({
                  transition_id: pendingTransition,
                  comment: comment.trim() || undefined
                })
              }
            >
              {executeTransition.isPending ? (
                <Loader2 className='h-3.5 w-3.5 animate-spin' />
              ) : (
                <>
                  <span>
                    {forwardWarning.length > 0 && pendingTx
                      ? `${pendingTx.label} anyway`
                      : 'Confirm'}
                  </span>
                  <Check className='h-3 w-3' />
                </>
              )}
            </Button>
          </div>
        </div>
      )}
      {armedTx?.advisory && !pendingTransition && (
        <MoveAdvisoryNotice
          floating
          collection={collection}
          item={String(item)}
          advisory={armedTx.advisory}
          armedMove={{ id: armedTx.id, label: armedTx.label }}
          className='absolute right-0 top-full z-50 mt-1'
          style={{ width: confirmWidth }}
          onDismiss={() => setArmedMove(null)}
          onFixed={(thenMove) => {
            setArmedMove(null)
            void queryClient.invalidateQueries({ queryKey })
            if (thenMove) void trySetPending(thenMove.id, { cleared: true })
          }}
        />
      )}
      {fixOffer && !pendingTransition && (
        <RefusalFixPanel
          collection={collection}
          item={String(item)}
          offer={fixOffer}
          className='absolute right-0 top-full z-50 mt-1 shadow-lg'
          style={{ width: confirmWidth }}
          onDismiss={() => setFixOffer(null)}
          onFixed={() =>
            runTransition({ transition_id: fixOffer.transitionId, comment: fixOffer.comment })
          }
        />
      )}
      {requirementsDialog && (
        <Suspense fallback={null}>
          <TransitionRequirementsDialog
            key={requirementsDialog.revision}
            payload={requirementsDialog.payload}
            transitionId={requirementsDialog.transitionId}
            isRetry={requirementsDialog.revision > 1}
            onSubmitted={() =>
              // mutateAsync so the dialog can stay busy until the transition
              // settles; the mutation's own onError/onSuccess handle the outcome.
              executeTransition
                .mutateAsync({
                  transition_id: requirementsDialog.transitionId,
                  comment: requirementsDialog.comment,
                  reviewed: true
                })
                .catch(() => undefined)
            }
            executing={executeTransition.isPending}
            onClose={() => setRequirementsDialog(null)}
          />
        </Suspense>
      )}
    </div>
  )
}
