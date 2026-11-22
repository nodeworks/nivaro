/**
 * The agent's route handlers: the wire contract mapped onto the stack
 * operations. Every refusal is `{ error, code, fields? }` with a fixed
 * sentence; an Engine failure is 502 ENGINE_ERROR and never carries the
 * Engine's text. Log lines carry the operation, stack, status and code —
 * never a request body, a secret value or the token.
 *
 * PUT and restart both take the StackSpec (restart: ruling P4-16).
 *
 * Writes (PUT, restart, DELETE) run one at a time: two applies on the same
 * swarm would race on versions, and two stacks claiming one hostname at once
 * would both pass the hostname check.
 */
import type { AgentConfig } from './config.js'
import { type Engine, EngineError, EngineForbiddenError } from './engine.js'
import { StackError } from './errors.js'
import type { ExtensionDeps } from './extensions.js'
import type { Log } from './log.js'
import type { HandlerResult, Handlers } from './server.js'
import { OWNER_KEY_RE, validateStackSpec } from './spec.js'
import { applyStack, listStacks, removeStack, restartStack, stackStatus } from './stacks.js'

export type HandlerDeps = {
  nodeId: string
  health: Handlers['health']
  log?: Log
  sleep?: (ms: number) => Promise<void>
  extension?: ExtensionDeps
}

const EXPECT_RE = /^[a-f0-9]{64}$/

function refusal(status: number, code: string, error: string, fields?: unknown): HandlerResult {
  return { status, body: fields ? { error, code, fields } : { error, code } }
}

export function makeHandlers(engine: Engine, cfg: AgentConfig, deps: HandlerDeps): Handlers {
  const log: Log = deps.log ?? (() => {})
  let queue: Promise<unknown> = Promise.resolve()
  const stackDeps = () => ({
    nodeId: deps.nodeId,
    log,
    sleep: deps.sleep,
    extension: deps.extension
  })

  /** One write at a time. */
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn)
    queue = run.catch(() => {})
    return run
  }

  async function guarded(
    op: string,
    stack: string | null,
    fn: () => Promise<HandlerResult>
  ): Promise<HandlerResult> {
    try {
      return await fn()
    } catch (err) {
      const t = new Date().toISOString()
      if (err instanceof StackError) {
        log({ t, level: 'info', op, stack, status: err.status, code: err.code })
        return refusal(err.status, err.code, err.message, err.fields)
      }
      if (err instanceof EngineError) {
        log({ t, level: 'error', op, stack, status: 502, code: err.code })
        return refusal(502, 'ENGINE_ERROR', 'The Docker Engine could not be reached')
      }
      if (err instanceof EngineForbiddenError) {
        // The agent built a call its own guard refuses: a bug or tampered state. Nothing was sent.
        log({ t, level: 'error', op, stack, status: 500, code: err.code })
        return refusal(500, 'ENGINE_FORBIDDEN', 'The agent refused its own Engine call')
      }
      const errno = (err as NodeJS.ErrnoException | null)?.code
      log({
        t,
        level: 'error',
        op,
        stack,
        status: 500,
        code: 'INTERNAL',
        ...(typeof errno === 'string' && /^E[A-Z0-9]{1,30}$/.test(errno) ? { errno } : {})
      })
      return refusal(500, 'INTERNAL', 'Internal error')
    }
  }

  return {
    health: deps.health,

    listStacks: () =>
      guarded('list', null, async () => ({
        status: 200,
        body: { data: await listStacks(engine) }
      })),

    getStack: (name, q) =>
      guarded('status', name, async () => {
        if (q.expect !== null && !EXPECT_RE.test(q.expect)) {
          return refusal(400, 'EXPECT_INVALID', 'expect must be a spec hash')
        }
        return { status: 200, body: await stackStatus(engine, name, q.expect) }
      }),

    putStack: (name, body) =>
      guarded('apply', name, async () => {
        const v = validateStackSpec(body, cfg)
        if (!v.ok) return refusal(400, 'SPEC_INVALID', 'The stack spec is not valid', v.fields)
        const r = await serial(() => applyStack(engine, cfg, name, v.spec, stackDeps()))
        log({
          t: new Date().toISOString(),
          level: 'info',
          op: 'apply',
          stack: name,
          changed: r.changed.length,
          unchanged: r.unchanged.length
        })
        return { status: 202, body: r }
      }),

    restartStack: (name, body) =>
      guarded('restart', name, async () => {
        // Ruling P4-16: the restart carries the StackSpec; bodies are rendered fresh from it.
        const v = validateStackSpec(body, cfg)
        if (!v.ok) return refusal(400, 'SPEC_INVALID', 'The stack spec is not valid', v.fields)
        const r = await serial(() => restartStack(engine, cfg, name, v.spec, stackDeps()))
        return { status: 202, body: r }
      }),

    deleteStack: (name, q) =>
      guarded('remove', name, async () => {
        if (q.confirm !== name) {
          return refusal(400, 'CONFIRM_REQUIRED', 'Repeat the stack name in confirm to remove it')
        }
        // The owner the caller believes the stack has: exactly one of app / shared, and the
        // environment. removeStack refuses STACK_OWNER_MISMATCH unless the labels say the same.
        const key = (v: string | null) => typeof v === 'string' && OWNER_KEY_RE.test(v)
        const oneOwner = (q.app !== null) !== (q.shared !== null)
        if (!oneOwner || !(key(q.app) || key(q.shared)) || !key(q.environment)) {
          return refusal(
            400,
            'OWNER_REQUIRED',
            'Name the stack owner (app or shared) and environment to remove it'
          )
        }
        const owner = {
          ...(q.app !== null ? { app: q.app } : { shared: q.shared as string }),
          environment: q.environment as string
        }
        const r = await serial(() =>
          removeStack(
            engine,
            cfg,
            name,
            { removeVolumes: q.removeVolumes, owner },
            { sleep: deps.sleep, log }
          )
        )
        return { status: 200, body: r }
      })
  }
}
