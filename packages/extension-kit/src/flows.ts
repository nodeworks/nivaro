import type { FastifyBaseLogger } from 'fastify'

export interface FlowData extends Record<string, unknown> {}

export interface FlowTraceStep {
  key: string
  name: string
  type: string
  status: 'resolve' | 'reject' | 'async'
  preview?: unknown
}

/** What a flow operation handler runs inside. */
export interface FlowExecutionContext {
  flowId: string
  flowName: string
  trigger: string
  payload: Record<string, unknown>
  log: FastifyBaseLogger
  userId?: string
  /** Test mode: side-effect ops render but do not send — a preview lands in
   *  the trace instead. A custom op must honour it. */
  dryRun?: boolean
  /** When provided, the executor appends one step per executed operation. */
  trace?: FlowTraceStep[]
}

export type OpResult = { status: 'resolve' | 'reject'; output: FlowData }
export type OpHandler = (
  opts: Record<string, unknown>,
  data: FlowData,
  ctx: FlowExecutionContext
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

export interface FlowOpRegistration {
  type: string
  label: string
  description?: string
  /** hex, e.g. '#7c3aed' */
  color?: string
  fields?: OpFieldSchema[]
  handler: OpHandler
}

export interface FlowTriggerRegistration {
  type: string
  label: string
  description?: string
  fields?: OpFieldSchema[]
}
