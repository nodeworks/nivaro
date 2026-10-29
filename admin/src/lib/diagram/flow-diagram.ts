// Builds the plain-language Diagram of a flow: trigger box -> step boxes in
// order, "yes/no" branches for conditions, failed paths dashed.

import { type Diagram, type DiagramEdgeIn, type DiagramNodeIn, layoutGraph } from './layout'

export interface FlowOp {
  id: string
  name: string
  key?: string
  type: string
  options?: Record<string, unknown> | null
  resolve?: string | null
  reject?: string | null
}

export interface FlowDiagramInput {
  trigger: string
  trigger_options?: Record<string, unknown> | null
  operations: FlowOp[]
  /** external API id -> name. */
  apiNames?: Record<string, string>
  /** flow id -> name (for "Run another flow"). */
  flowNames?: Record<string, string>
}

export const TRIGGER_NODE_ID = '__trigger__'

const COND_OPS: Record<string, string> = {
  eq: 'is',
  neq: 'is not',
  gt: 'is more than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  contains: 'contains',
  in: 'is one of',
  exists: 'exists'
}

function str(v: unknown): string {
  return v == null ? '' : String(v).trim()
}

function human(path: unknown): string {
  const s = str(path)
  if (!s) return 'a value'
  return (s.split('.').pop() as string).replace(/^\$/, '').replace(/_/g, ' ')
}

function list(v: unknown): string {
  if (Array.isArray(v)) return v.map(String).join(', ')
  return str(v)
}

export function describeTrigger(
  trigger: string,
  o: Record<string, unknown> | null | undefined
): string {
  const opts = o ?? {}
  switch (trigger) {
    case 'manual':
      return 'Someone runs it by hand'
    case 'schedule':
      return str(opts.cron) ? `On a schedule (${str(opts.cron)})` : 'On a schedule'
    case 'webhook':
      return 'When a web request arrives'
    case 'event': {
      const past: Record<string, string> = {
        create: 'created',
        update: 'updated',
        delete: 'deleted'
      }
      const types = (Array.isArray(opts.types) ? opts.types : [])
        .map((t) => past[String(t)] ?? String(t))
        .join(' or ')
      const cols = list(opts.collections)
      const what = types ? `a record is ${types}` : 'a record changes'
      return `When ${what}${cols ? ` in ${cols}` : ''}`
    }
    default:
      return `When "${trigger}" fires`
  }
}

export function describeOperation(
  op: FlowOp,
  ctx: { apiNames?: Record<string, string>; flowNames?: Record<string, string> } = {}
): string {
  const o = op.options ?? {}
  switch (op.type) {
    case 'condition': {
      const operator = str(o.operator) || 'eq'
      const text = COND_OPS[operator] ?? operator
      const noValue = operator === 'exists'
      return `Check whether ${human(o.field)} ${text}${noValue ? '' : ` ${str(o.value) || '…'}`}`
    }
    case 'mail':
      return `Send email${str(o.to) ? ` to ${str(o.to)}` : ''}${str(o.subject) ? `: ${str(o.subject)}` : ''}`
    case 'notification':
      return `Notify ${str(o.recipient) || 'a person'}${str(o.subject) ? `: ${str(o.subject)}` : ''}`
    case 'webhook':
      return `Send a web request${str(o.url) ? ` to ${str(o.url)}` : ''}`
    case 'external-api': {
      const name = ctx.apiNames?.[String(o.api_id)] ?? `API ${str(o.api_id) || ''}`.trim()
      return `Call ${name}${str(o.endpoint) ? `: ${str(o.endpoint)}` : ''}`
    }
    case 'run-flow': {
      const name = ctx.flowNames?.[String(o.flow_id)] ?? 'another flow'
      return `Run flow ${name}`
    }
    case 'item-read':
      return `Look up ${str(o.collection) || 'a record'}`
    case 'item-write':
      return `Change ${str(o.collection) || 'a record'}${str(o.mode) ? ` (${str(o.mode)})` : ''}`
    case 'transform':
      return 'Reshape the data'
    case 'exec-script':
      return 'Run a script'
    case 'log':
      return `Write to the log${str(o.message) ? `: ${str(o.message)}` : ''}`
    case 'chat-post':
      return `Post a chat message${str(o.room) ? ` in ${str(o.room)}` : ''}`
    case 'task':
      return `Create a task${str(o.title) ? `: ${str(o.title)}` : ''}`
    case 'refresh-pages':
      return 'Tell open pages to refresh'
    case 'workflow-auto-sweep':
      return 'Move records along automatically'
    default:
      return op.type.replace(/-/g, ' ')
  }
}

export function buildFlowDiagram(input: FlowDiagramInput): Diagram {
  const ops = input.operations
  const ids = new Set(ops.map((o) => o.id))
  const referenced = new Set(
    ops.flatMap((o) => [o.resolve, o.reject]).filter((x): x is string => !!x && ids.has(x))
  )
  const nodes: DiagramNodeIn[] = [
    {
      id: TRIGGER_NODE_ID,
      title: describeTrigger(input.trigger, input.trigger_options),
      role: 'trigger',
      tags: ['Trigger']
    }
  ]
  const edges: DiagramEdgeIn[] = []
  for (const op of ops) {
    nodes.push({
      id: op.id,
      title: op.name || op.type,
      tags: op.type === 'condition' ? ['Branch'] : [],
      notes: [describeOperation(op, input)]
    })
  }
  for (const op of ops)
    if (!referenced.has(op.id)) {
      edges.push({ id: `start:${op.id}`, from: TRIGGER_NODE_ID, to: op.id })
    }
  for (const op of ops) {
    const cond = op.type === 'condition'
    if (op.resolve && ids.has(op.resolve)) {
      edges.push({
        id: `ok:${op.id}`,
        from: op.id,
        to: op.resolve,
        lines: cond ? ['Yes'] : undefined
      })
    }
    if (op.reject && ids.has(op.reject)) {
      edges.push({
        id: `no:${op.id}`,
        from: op.id,
        to: op.reject,
        lines: [cond ? 'Otherwise' : 'If it fails'],
        tone: 'fail',
        dashed: true
      })
    }
  }
  return layoutGraph(nodes, edges, { nodeW: 240, gapX: 120 })
}
