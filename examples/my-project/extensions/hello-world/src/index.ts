// @ts-nocheck

import type { FastifyInstance } from 'fastify'
import type { Knex } from 'knex'

// Matches the Nivaro ExtensionContext interface
interface HookContext {
  collection: string
  payload?: Record<string, unknown>
  item?: Record<string, unknown>
  previousData?: Record<string, unknown>
  id?: string | number
}

interface HookRegistry {
  before(
    collection: string,
    action: 'create' | 'update' | 'delete',
    fn: (ctx: HookContext) => void | Promise<void>
  ): void
  after(
    collection: string,
    action: 'create' | 'update' | 'delete',
    fn: (ctx: HookContext) => void | Promise<void>
  ): void
}

interface CronRegistry {
  schedule(name: string, cronExpression: string, fn: () => void | Promise<void>): void
}

interface FlowFieldSchema {
  key: string
  label: string
  type: 'string' | 'number' | 'boolean' | 'select' | 'textarea' | 'json'
  options?: Array<{ value: string; label: string }>
  placeholder?: string
  required?: boolean
  description?: string
  defaultValue?: unknown
}

interface FlowExecContext {
  flowId: string
  flowName: string
  trigger: string
  payload: Record<string, unknown>
  log: FastifyInstance['log']
  userId?: string
}

interface ExtensionContext {
  app: FastifyInstance
  database: Knex
  logger: FastifyInstance['log']
  hooks: HookRegistry
  cron: CronRegistry
  callExternalApi(
    apiId: string,
    options?: { method?: string; path?: string; body?: unknown }
  ): Promise<unknown>
  flows: {
    registerOperation(op: {
      type: string
      label: string
      description?: string
      color?: string
      fields?: FlowFieldSchema[]
      handler(
        opts: Record<string, unknown>,
        data: Record<string, unknown>,
        ctx: FlowExecContext
      ): Promise<{ status: 'resolve' | 'reject'; output: Record<string, unknown> }>
    }): void
    registerTrigger(trigger: {
      type: string
      label: string
      description?: string
      fields?: FlowFieldSchema[]
    }): void
    emit(triggerType: string, payload: Record<string, unknown>): void
  }
}

interface Extension {
  id: string
  register(ctx: ExtensionContext): void | Promise<void>
}

const extension: Extension = {
  id: 'hello-world',

  async register({ app, database, logger, hooks, cron, callExternalApi }) {
    logger.info('Hello World extension loaded')

    // ── Custom API routes ────────────────────────────────────────────────────
    await app.register(
      async (fastify) => {
        // GET /api/hello
        fastify.get('/hello', async (_req, reply) => {
          return reply.send({ message: 'Hello from a custom extension!' })
        })

        // GET /api/hello/users/count — query the database
        fastify.get('/hello/users/count', async (_req, reply) => {
          const [{ count }] = await database('nivaro_users').count('id as count')
          return reply.send({ count: Number(count) })
        })
      },
      { prefix: '/api' }
    )

    // ── Hooks ────────────────────────────────────────────────────────────────
    hooks.before('articles', 'create', async ({ payload }) => {
      logger.info({ payload }, 'article about to be created')
    })

    hooks.after('articles', 'update', async ({ item, previousData }) => {
      logger.info({ item, previousData }, 'article updated')
    })

    // ── Cron ─────────────────────────────────────────────────────────────────
    cron.schedule('hello-daily', '0 9 * * *', async () => {
      logger.info('hello-world daily cron fired')
    })
  }
}

export default extension
