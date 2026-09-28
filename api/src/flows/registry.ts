import type {
  FlowExecutionContext,
  FlowOpRegistration,
  FlowTriggerRegistration,
  OpFieldSchema,
  OpHandler
} from '@nivaro/extension-kit'
import type { FastifyBaseLogger } from 'fastify'
import { db } from '../db/index.js'

export type {
  FlowData,
  FlowTraceStep,
  OpFieldSchema,
  OpHandler,
  OpResult
} from '@nivaro/extension-kit'
/** The core's names for the kit's flow types. */
export type ExecutionContext = FlowExecutionContext
export type RegisteredOp = FlowOpRegistration
export type RegisteredTrigger = FlowTriggerRegistration
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
  userId?: string,
  opts?: { excludeFlowIds?: string[] }
): void {
  const exclude = new Set((opts?.excludeFlowIds ?? []).map((id) => String(id).toUpperCase()))
  // Lazy import to avoid circular dep with executor
  import('../services/flow-executor.js')
    .then(async ({ executeFlow }) => {
      const flows = await db<{ id: string; name: string }>('nivaro_flows').where({
        trigger: triggerType,
        status: 'active'
      })
      for (const flow of flows) {
        if (exclude.has(String(flow.id).toUpperCase())) continue
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
