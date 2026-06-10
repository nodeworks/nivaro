import type { FastifyBaseLogger } from 'fastify'
import { db } from '../db/index.js'

// Re-export types needed by extension context and executor
export interface FlowData extends Record<string, unknown> {}

export interface ExecutionContext {
  flowId: string
  flowName: string
  trigger: string
  payload: Record<string, unknown>
  log: FastifyBaseLogger
  userId?: string
}

export type OpResult = { status: 'resolve' | 'reject'; output: FlowData }
export type OpHandler = (
  opts: Record<string, unknown>,
  data: FlowData,
  ctx: ExecutionContext
) => Promise<OpResult>

export interface OpFieldSchema {
  key: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'select' | 'textarea' | 'json'
  options?: Array<{ value: string; label: string }>
  placeholder?: string
  required?: boolean
  description?: string
  defaultValue?: unknown
}

export interface RegisteredOp {
  type: string
  label: string
  description?: string
  color?: string // hex, e.g. '#7c3aed'
  fields?: OpFieldSchema[]
  handler: OpHandler
}

export interface RegisteredTrigger {
  type: string
  label: string
  description?: string
  fields?: OpFieldSchema[]
}

// Module-level registries
const _ops = new Map<string, RegisteredOp>()
const _triggers = new Map<string, RegisteredTrigger>()

export function registerOp(op: RegisteredOp): void {
  _ops.set(op.type, op)
}

export function registerTrigger(trigger: RegisteredTrigger): void {
  _triggers.set(trigger.type, trigger)
}

export function getOp(type: string): RegisteredOp | undefined {
  return _ops.get(type)
}

export function listOps(): Array<Omit<RegisteredOp, 'handler'>> {
  return [..._ops.values()].map(({ handler: _, ...rest }) => rest)
}

export function listTriggers(): RegisteredTrigger[] {
  return [..._triggers.values()]
}

/** Fire all active flows registered to this extension trigger type. Fire-and-forget. */
export function emitTrigger(
  triggerType: string,
  payload: Record<string, unknown>,
  log: FastifyBaseLogger,
  userId?: string
): void {
  // Lazy import to avoid circular dep with executor
  import('../services/flow-executor.js')
    .then(async ({ executeFlow }) => {
      const flows = await db<{ id: string; name: string }>('nivaro_flows').where({
        trigger: triggerType,
        status: 'active'
      })
      for (const flow of flows) {
        executeFlow({
          flowId: flow.id,
          flowName: flow.name,
          trigger: triggerType,
          payload,
          log,
          userId
        }).catch((err: unknown) =>
          log.error({ err, flowId: flow.id, triggerType }, 'Extension trigger flow failed')
        )
      }
    })
    .catch((err: unknown) => log.error({ err, triggerType }, 'emitTrigger: import failed'))
}
