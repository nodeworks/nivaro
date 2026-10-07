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

/**
 * Per-key ordering for trigger events. An event emitted with an `orderKey`
 * waits until every flow started for the PREVIOUS event with that key has
 * finished; different keys never wait on each other. The slot is reserved
 * synchronously at emit time, so the order is the order of the emitTrigger
 * calls even though the flow lookup itself is async.
 *
 * Why: a manual transition that sets off an automatic one (Waiting on PO →
 * Completed) emits two workflow-transition events a few milliseconds apart.
 * Started in parallel, their partner pushes race and the older state can land
 * last ("Completed" then "Waiting on PO"). In-process only — two API processes
 * moving the same record at the same moment are not ordered against each other.
 */
const orderChains = new Map<string, Promise<void>>()

// The executor imports this module, so it is loaded lazily — once, with every
// caller sharing the same promise.
let executorModule: Promise<typeof import('../services/flow-executor.js')> | null = null
function loadExecutor(): Promise<typeof import('../services/flow-executor.js')> {
  executorModule ??= import('../services/flow-executor.js')
  return executorModule
}

/** How long one event may hold its key before the next event starts anyway. */
export const ORDERED_EVENT_TIMEOUT_MS = 120_000

function runInOrder(key: string, work: () => Promise<void>, timeoutMs: number): void {
  const prev = orderChains.get(key) ?? Promise.resolve()
  const next = prev.then(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs)
      timer.unref?.()
    })
    return Promise.race([work().catch(() => {}), timeout]).finally(() => clearTimeout(timer))
  })
  orderChains.set(key, next)
  void next.finally(() => {
    if (orderChains.get(key) === next) orderChains.delete(key)
  })
}

/** Test seam: how many keys currently hold a chain. */
export function orderedTriggerKeyCount(): number {
  return orderChains.size
}

/** Fire all active flows registered to this extension trigger type. Fire-and-forget. */
export function emitTrigger(
  triggerType: string,
  payload: Record<string, unknown>,
  log: FastifyBaseLogger,
  userId?: string,
  opts?: { excludeFlowIds?: string[]; orderKey?: string; orderTimeoutMs?: number }
): void {
  const exclude = new Set((opts?.excludeFlowIds ?? []).map((id) => String(id).toUpperCase()))
  const run = async (): Promise<void> => {
    const { executeFlow } = await loadExecutor()
    const flows = await db<{ id: string; name: string }>('nivaro_flows').where({
      trigger: triggerType,
      status: 'active'
    })
    const runs: Promise<unknown>[] = []
    for (const flow of flows) {
      if (exclude.has(String(flow.id).toUpperCase())) continue
      runs.push(
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
      )
    }
    await Promise.all(runs)
  }
  if (opts?.orderKey) {
    runInOrder(
      `${triggerType}|${opts.orderKey}`,
      () =>
        run().catch((err: unknown) => log.error({ err, triggerType }, 'emitTrigger: run failed')),
      opts.orderTimeoutMs ?? ORDERED_EVENT_TIMEOUT_MS
    )
    return
  }
  run().catch((err: unknown) => log.error({ err, triggerType }, 'emitTrigger: import failed'))
}
