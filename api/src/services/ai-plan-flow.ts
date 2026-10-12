import { randomUUID } from 'node:crypto'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { logActivity } from './activity.js'
import type { PlanStepDef } from './ai-plan-runner.js'
import { httpError, isAdmin, loadPlan } from './ai-plans.js'

/**
 * Turn a plan that worked into a DRAFT FLOW (#1849), administrators only.
 * Each step becomes a flow operation chained in order; the records the plan
 * acted on become, as the administrator chooses:
 *   same     the same record ids, fixed (a manual flow)
 *   filter   the step's original filter, resolved again each run (manual)
 *   trigger  whichever record fired an update event on the collection
 * The flow is created SWITCHED OFF; the admin opens it in the flow tester
 * (dry run by default) before turning it on. A step with no flow
 * equivalent becomes a log operation that says so, so nothing is dropped
 * silently.
 */

export type FlowRecords = 'same' | 'filter' | 'trigger'

export interface DraftFlowOp {
  key: string
  name: string
  type: string
  options: Record<string, unknown>
}

export interface DraftFlow {
  name: string
  description: string
  trigger: 'manual' | 'event'
  trigger_options: Record<string, unknown> | null
  operations: DraftFlowOp[]
  notes: string[]
}

const str = (v: unknown) => (v == null ? '' : String(v))

function placeholder(step: PlanStepDef, why: string): DraftFlowOp {
  return {
    key: `step_${step.n}`,
    name: `${step.n}. ${step.title}`.slice(0, 255),
    type: 'log',
    options: {
      level: 'warn',
      message: `Plan step ${step.n} (${step.kind}) has no flow operation: ${why}. Replace this operation or do it by hand.`
    }
  }
}

/** Map a plan's steps to flow operations (pure — exported for tests). */
export function planToFlowDraft(
  title: string,
  steps: PlanStepDef[],
  records: FlowRecords,
  runAs: string | null = null
): DraftFlow {
  // Only an administrator's explicit choice — never the plan's owner or the
  // admin by default: a run with nobody behind it is refused instead.
  const asWho = runAs ? { run_as: runAs } : {}
  const ordered = [...steps].sort((a, b) => a.n - b.n)
  const notes: string[] = []
  const operations: DraftFlowOp[] = []
  const recordStep = ordered.find((s) => s.kind === 'bulk_update')
  const eventCollection = records === 'trigger' ? str(recordStep?.payload.collection) : ''
  if (records === 'trigger' && !eventCollection) {
    throw httpError('“Whichever record changed” needs a step that updates records', 400)
  }
  for (const step of ordered) {
    const p = step.payload ?? {}
    const name = `${step.n}. ${step.title}`.slice(0, 255)
    const key = `step_${step.n}`
    switch (step.kind) {
      case 'bulk_update': {
        const collection = str(p.collection)
        const target =
          records === 'filter' && step.input?.filter && typeof step.input.filter === 'object'
            ? { filter: step.input.filter }
            : records === 'trigger' && collection === eventCollection
              ? { ids: '{{keys}}' }
              : { ids: ((p.ids as string[]) ?? []).map(String).join(',') }
        if (records === 'trigger' && collection !== eventCollection) {
          notes.push(
            `Step ${step.n} acts on ${collection}, not the trigger's collection — it keeps its fixed records.`
          )
        }
        operations.push({
          key,
          name,
          type: 'item-write',
          options: { mode: 'update', collection, ...target, data: p.changes ?? {}, ...asWho }
        })
        break
      }
      case 'create_record':
        operations.push({
          key,
          name,
          type: 'item-write',
          options: {
            mode: 'create',
            collection: str(p.collection),
            data: p.data ?? {},
            ...asWho
          }
        })
        break
      case 'create_task':
        operations.push({
          key,
          name,
          type: 'task',
          options: {
            collection: str(p.collection),
            item: str(p.item ?? p.id),
            title: str(p.title),
            description: str(p.description),
            assignee: str(p.assignee),
            due_date: str(p.due_date),
            priority: str(p.priority) || 'normal'
          }
        })
        break
      case 'send_message': {
        const people = ((p.people as string[]) ?? []).slice(0, 10)
        people.forEach((id, i) => {
          operations.push({
            key: people.length > 1 ? `${key}_${i + 1}` : key,
            name: people.length > 1 ? `${name} (${i + 1})` : name,
            type: 'notification',
            options: { recipient: id, subject: str(p.subject), message: str(p.message) }
          })
        })
        if (p.owners_of) {
          operations.push(
            placeholder(step, 'messaging the owners of records is resolved per run in a plan only')
          )
          notes.push(
            `Step ${step.n} messaged record owners — add a notification per owner by hand.`
          )
        }
        break
      }
      case 'post_chat':
        operations.push({
          key,
          name,
          type: 'chat-post',
          options: { room: str(p.room), message: str(p.message) }
        })
        break
      case 'run_flow':
        operations.push({
          key,
          name,
          type: 'run-flow',
          options: { flow_id: str(p.flow_id), payload: p.data ?? {}, wait: true }
        })
        break
      default:
        operations.push(placeholder(step, `${step.kind} steps are plan-only`))
        notes.push(
          `Step ${step.n} (${step.kind}) has no flow operation — a log operation marks it.`
        )
    }
  }
  return {
    name: `${title} (from plan)`.slice(0, 255),
    description: '',
    trigger: records === 'trigger' ? 'event' : 'manual',
    trigger_options:
      records === 'trigger'
        ? { timing: 'after', types: ['update'], collections: [eventCollection] }
        : null,
    operations,
    notes
  }
}

export async function planToFlow(
  admin: User,
  id: string,
  records: FlowRecords,
  runAs: string | null = null
): Promise<{ flow_id: string; name: string; operations: number; notes: string[] }> {
  if (!(await isAdmin(admin))) throw httpError('Only administrators can make flows', 403)
  if (!['same', 'filter', 'trigger'].includes(records))
    throw httpError('records must be same, filter or trigger', 400)
  const { row, doc } = await loadPlan(id)
  if (String(row.status) !== 'executed') {
    throw httpError('Only a plan that ran to the end can become a flow', 409)
  }
  if (runAs) {
    const { canSignIn, getUser } = await import('./users.js')
    const who = await getUser(runAs)
    if (!who || !canSignIn(who)) throw httpError('“Run as” must be an active person', 400)
  }
  const draft = planToFlowDraft(doc.title, doc.steps, records, runAs)
  const flowId = randomUUID()
  const now = new Date()
  const who =
    [admin.first_name, admin.last_name].filter(Boolean).join(' ') || admin.email || admin.id
  await db('nivaro_flows').insert({
    id: flowId,
    name: draft.name,
    description:
      `Made from Ask AI plan “${doc.title}” by ${who} on ${now.toISOString().slice(0, 10)}. Created switched off — run it in the tester, then turn it on.`.slice(
        0,
        1000
      ),
    status: 'inactive',
    trigger: draft.trigger,
    trigger_options: draft.trigger_options ? JSON.stringify(draft.trigger_options) : null,
    accountability: 'all',
    created_at: now,
    updated_at: now
  })
  // Chained top to bottom: each operation resolves to the next.
  const ids = draft.operations.map(() => randomUUID())
  for (let i = draft.operations.length - 1; i >= 0; i--) {
    const op = draft.operations[i]
    await db('nivaro_flow_operations').insert({
      id: ids[i],
      flow: flowId,
      name: op.name,
      key: op.key,
      type: op.type,
      position_x: 0,
      position_y: i * 160,
      options: JSON.stringify(op.options),
      resolve: ids[i + 1] ?? null,
      reject: null,
      created_at: now
    })
  }
  doc.flow_id = flowId
  await db('nivaro_ai_proposals')
    .where({ id })
    .update({ payload: JSON.stringify(doc) })
  await logActivity({
    action: 'create',
    collection: 'nivaro_flows',
    item: flowId,
    user: admin.id,
    comment: `draft flow from AI plan ${id} (${records})`
  })
  return {
    flow_id: flowId,
    name: draft.name,
    operations: draft.operations.length,
    notes: draft.notes
  }
}
