import { db } from '../db/index.js'
import type { BranchLane } from './branch-lanes.js'

/**
 * "2 of 3 signed — waiting on Ana Ruiz (Finance)" (Rob 2026-11-13, #15).
 *
 * A step needs several sign-offs in two places in the engine:
 *  - a parallel split (routes/workflows.ts, drawn as lanes by branch-lanes.ts):
 *    the record waits at the split until every branch reaches a terminal
 *    state — each finished branch is one sign-off, its owners are who the
 *    open ones wait on;
 *  - an approval chain (nivaro_approval_* — routes/approvals.ts) running on
 *    the record for the step it sits in: each approved chain step is one
 *    sign-off, the current step's approver (a person, or anyone in a role) is
 *    who it waits on.
 * Multiple OWNERS of one pipeline step are not a sign-off set: any one of
 * them moves the record. A step with a single sign-off gets nothing new.
 *
 * Names follow the Owners panel: anyone who may read the record sees the
 * step's people; a redacted account reads "Former user".
 */

export interface SignOffWaiting {
  /** The branch or chain step that has not signed ("Finance"). */
  label: string
  /** Who it waits on — at most SIGN_OFF_NAMES; `more` counts the rest. */
  names: string[]
  more: number
}

export interface SignOffSigned {
  label: string
  /** Who signed (null = the engine finished the branch on its own). */
  name: string | null
  at: string | null
}

export interface SignOffSummary {
  kind: 'branches' | 'chain'
  /** The approval chain's name; null for branches. */
  title: string | null
  required: number
  signed: number
  waiting: SignOffWaiting[]
  signers: SignOffSigned[]
}

export const SIGN_OFF_NAMES = 2

export interface SignOffPerson {
  id: string
  first_name?: string | null
  last_name?: string | null
  email?: string | null
  is_redacted?: boolean | number | null
}

/** Redacted: flagged, or renamed "Redacted Redacted" by the legacy proc. */
function redacted(p: SignOffPerson): boolean {
  if (p.is_redacted === true || p.is_redacted === 1) return true
  const f = String(p.first_name ?? '')
    .trim()
    .toLowerCase()
  const l = String(p.last_name ?? '')
    .trim()
    .toLowerCase()
  return f === 'redacted' && l === 'redacted'
}

/** A person's display name the way the Owners panel says it. */
export function signOffName(p: SignOffPerson | undefined, fallback: string | null): string | null {
  if (!p) {
    if (!fallback) return null
    return fallback.trim().toLowerCase() === 'redacted redacted' ? 'Former user' : fallback
  }
  if (redacted(p)) return 'Former user'
  return [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || p.email || fallback
}

const key = (id: string | null | undefined) => String(id ?? '').toUpperCase()

function capNames(names: string[]): { names: string[]; more: number } {
  const list = [...new Set(names.filter(Boolean))]
  return { names: list.slice(0, SIGN_OFF_NAMES), more: Math.max(0, list.length - SIGN_OFF_NAMES) }
}

const iso = (v: Date | string | null | undefined): string | null => {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

type LaneLike = Pick<BranchLane, 'label' | 'terminal' | 'finished_at' | 'steps'> & {
  owners?: Array<{ id: string; name: string }>
}

/** Sign-offs of an OPEN parallel split. Null when it joined or has one branch. */
export function branchSignOffs(
  branches: { open: boolean; lanes: LaneLike[] } | null | undefined,
  people: Map<string, SignOffPerson>
): SignOffSummary | null {
  if (!branches?.open || branches.lanes.length < 2) return null
  const signers: SignOffSigned[] = []
  const waiting: SignOffWaiting[] = []
  for (const lane of branches.lanes) {
    if (lane.terminal) {
      const last = lane.steps[lane.steps.length - 1]
      signers.push({
        label: lane.label,
        name: last ? signOffName(people.get(key(last.by_id)), last.by) : null,
        at: lane.finished_at ?? last?.entered_at ?? null
      })
    } else {
      const names = (lane.owners ?? [])
        .map((o) => signOffName(people.get(key(o.id)), o.name))
        .filter((n): n is string => !!n)
      waiting.push({ label: lane.label, ...capNames(names) })
    }
  }
  return {
    kind: 'branches',
    title: null,
    required: branches.lanes.length,
    signed: signers.length,
    waiting,
    signers
  }
}

export interface ChainStepRow {
  step_order: number
  label: string | null
  approver: string | null
  approver_role: string | null
}
export interface ChainDecisionRow {
  step_order: number
  user: string
  decision: string
  decided_at: Date | string | null
}

/** Sign-offs of a PENDING approval chain. Null with fewer than two steps. */
export function chainSignOffs(input: {
  name: string | null
  currentStep: number
  steps: ChainStepRow[]
  decisions: ChainDecisionRow[]
  people: Map<string, SignOffPerson>
  roleNames: Map<string, string>
}): SignOffSummary | null {
  const steps = [...input.steps].sort((a, b) => a.step_order - b.step_order)
  if (steps.length < 2) return null
  const stepLabel = (s: ChainStepRow, i: number) => s.label?.trim() || `Step ${i + 1}`
  const signers: SignOffSigned[] = []
  const waiting: SignOffWaiting[] = []
  steps.forEach((s, i) => {
    const approved = input.decisions
      .filter((d) => d.step_order === s.step_order && d.decision === 'approved')
      .sort((a, b) => new Date(a.decided_at ?? 0).getTime() - new Date(b.decided_at ?? 0).getTime())
    if (approved.length > 0) {
      const d = approved[0]
      signers.push({
        label: stepLabel(s, i),
        name: signOffName(input.people.get(key(d.user)), null),
        at: iso(d.decided_at)
      })
      return
    }
    if (s.step_order !== input.currentStep) return
    const names: string[] = []
    if (s.approver) {
      const n = signOffName(input.people.get(key(s.approver)), null)
      if (n) names.push(n)
    } else if (s.approver_role) {
      const role = input.roleNames.get(key(s.approver_role))
      if (role) names.push(`anyone in ${role}`)
    }
    waiting.push({ label: stepLabel(s, i), ...capNames(names) })
  })
  return {
    kind: 'chain',
    title: input.name,
    required: steps.length,
    signed: signers.length,
    waiting,
    signers
  }
}

interface ChainRow {
  id: number
  chain: number
  current_step: number
  name: string | null
  workflow_template: string | null
  state_key: string | null
}

/**
 * Every sign-off set the record's current step waits on: the open parallel
 * split (from the lanes the instance read already built) and any pending
 * approval chain for this step. Two small reads when a chain runs, one
 * (pending chains for the record) when none does. Best effort — the caller
 * swallows.
 */
export async function loadSignOffs(opts: {
  collection: string
  item: string
  template: string
  currentStateKey: string | null
  branches: { open: boolean; lanes: LaneLike[] } | null | undefined
}): Promise<SignOffSummary[]> {
  const chains = (await db('nivaro_approval_instances as ai')
    .join('nivaro_approval_chains as c', 'c.id', 'ai.chain')
    .where({ 'ai.collection': opts.collection, 'ai.item': opts.item, 'ai.status': 'pending' })
    .select('ai.id', 'ai.chain', 'ai.current_step', 'c.name', 'c.workflow_template', 'c.state_key')
    .catch(() => [])) as ChainRow[]
  // A chain tied to another pipeline or another step is not this step's.
  const here = chains.filter(
    (c) =>
      (!c.workflow_template || key(c.workflow_template) === key(opts.template)) &&
      (!c.state_key || c.state_key === opts.currentStateKey)
  )

  const [steps, decisions] = here.length
    ? await Promise.all([
        db('nivaro_approval_chain_steps')
          .whereIn(
            'chain',
            here.map((c) => c.chain)
          )
          .select('chain', 'step_order', 'label', 'approver', 'approver_role') as Promise<
          Array<ChainStepRow & { chain: number }>
        >,
        db('nivaro_approval_decisions')
          .whereIn(
            'instance',
            here.map((c) => c.id)
          )
          .select('instance', 'step_order', 'user', 'decision', 'decided_at') as Promise<
          Array<ChainDecisionRow & { instance: number }>
        >
      ])
    : [[], []]

  const ids = new Set<string>()
  for (const lane of opts.branches?.lanes ?? []) {
    for (const o of lane.owners ?? []) ids.add(String(o.id))
    for (const s of lane.steps) if (s.by_id) ids.add(String(s.by_id))
  }
  for (const s of steps) if (s.approver) ids.add(String(s.approver))
  for (const d of decisions) ids.add(String(d.user))
  const roleIds = [...new Set(steps.map((s) => s.approver_role).filter(Boolean) as string[])]

  const [peopleRows, roleRows] = await Promise.all([
    ids.size
      ? (db('nivaro_users')
          .whereIn('id', [...ids])
          .select('id', 'first_name', 'last_name', 'email', 'is_redacted')
          .catch(() =>
            db('nivaro_users')
              .whereIn('id', [...ids])
              .select('id', 'first_name', 'last_name', 'email')
          ) as Promise<SignOffPerson[]>)
      : Promise.resolve([] as SignOffPerson[]),
    roleIds.length
      ? (db('nivaro_roles').whereIn('id', roleIds).select('id', 'name') as Promise<
          Array<{ id: string; name: string | null }>
        >)
      : Promise.resolve([] as Array<{ id: string; name: string | null }>)
  ])
  const people = new Map(peopleRows.map((p) => [key(p.id), p]))
  const roleNames = new Map(roleRows.filter((r) => r.name).map((r) => [key(r.id), String(r.name)]))

  const out: SignOffSummary[] = []
  const lanes = branchSignOffs(opts.branches, people)
  if (lanes) out.push(lanes)
  for (const c of here) {
    const summary = chainSignOffs({
      name: c.name,
      currentStep: c.current_step,
      steps: steps.filter((s) => s.chain === c.chain),
      decisions: decisions.filter((d) => d.instance === c.id),
      people,
      roleNames
    })
    if (summary) out.push(summary)
  }
  return out
}
