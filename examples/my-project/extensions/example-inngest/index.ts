// @ts-nocheck

// Inngest + cron extension example
//
// Demonstrates two scheduling approaches:
//
//   1. ctx.cron  — in-process cron via croner. Simpler. No external service needed.
//                  Jobs run inside the API process. Use for lightweight recurring tasks.
//
//   2. inngest   — durable, retryable background functions. Use for work that needs
//                  reliable delivery, retry-on-failure, or cross-replica execution.
//
// IMPORTANT: Inngest functions created in extensions are NOT automatically served
// by the /api/inngest endpoint. You must also import the function objects and add
// them to the `functions` array in api/src/plugins/inngest.ts.

import type { FastifyInstance } from 'fastify'
import type { Inngest, InngestFunction } from 'inngest'
import type { Knex } from 'knex'

interface ExtensionContext {
  app: FastifyInstance
  database: Knex
  inngest: Inngest
  logger: FastifyInstance['log']
  hooks: {
    before(
      collection: string | '*',
      action: string | '*',
      fn: (...args: unknown[]) => unknown
    ): void
    after(collection: string | '*', action: string | '*', fn: (...args: unknown[]) => unknown): void
  }
  cron: {
    schedule(id: string, expression: string, fn: () => void | Promise<void>): void
    unschedule(id: string): void
  }
  callExternalApi(nameOrId: string | number, options?: Record<string, unknown>): Promise<unknown>
  flows: {
    registerOperation(op: {
      type: string
      label: string
      description?: string
      color?: string
      fields?: Array<{
        key: string
        label: string
        type: 'string' | 'number' | 'boolean' | 'select' | 'textarea' | 'json'
        options?: Array<{ value: string; label: string }>
        placeholder?: string
        required?: boolean
        description?: string
        defaultValue?: unknown
      }>
      handler(
        opts: Record<string, unknown>,
        data: Record<string, unknown>,
        ctx: {
          flowId: string
          flowName: string
          trigger: string
          payload: Record<string, unknown>
          log: FastifyInstance['log']
          userId?: string
        }
      ): Promise<{ status: 'resolve' | 'reject'; output: Record<string, unknown> }>
    }): void
    registerTrigger(trigger: {
      type: string
      label: string
      description?: string
      fields?: Array<{
        key: string
        label: string
        type: 'string' | 'number' | 'boolean' | 'select' | 'textarea' | 'json'
        options?: Array<{ value: string; label: string }>
        placeholder?: string
        required?: boolean
        description?: string
        defaultValue?: unknown
      }>
    }): void
    emit(triggerType: string, payload: Record<string, unknown>): void
  }
}

interface Extension {
  id: string
  register(ctx: ExtensionContext): void | Promise<void>
}

const registeredFunctions: InngestFunction.Any[] = []

const plugin: Extension = {
  id: 'example-inngest',

  async register({ app, inngest, database, logger, cron }) {
    // ─── 1. In-process cron (ctx.cron) ──────────────────────────────────────
    // Runs inside the API process. Good for lightweight, best-effort scheduled
    // work. Job IDs are scoped to this extension automatically.
    //
    // Standard cron syntax: minute hour day-of-month month day-of-week
    //   '*/5 * * * *'   → every 5 minutes
    //   '0 9 * * 1-5'   → 9am UTC, weekdays only
    //   '0 0 * * *'     → midnight UTC every day

    cron.schedule('heartbeat', '*/5 * * * *', async () => {
      const [row] = await database('nivaro_activity').count('id as n')
      const count = Number((row as { n: number }).n)
      logger.info({ count }, '[example-inngest] heartbeat — activity count')
    })

    // ─── 2. Inngest cron (durable, retryable) ───────────────────────────────
    // Managed by Inngest — survives process restarts, retries on failure.
    // Requires INNGEST_EVENT_KEY + INNGEST_SIGNING_KEY in .env, OR
    // run `npx inngest-cli@latest dev` locally (http://localhost:8288).
    //
    // After creating these functions, add them to api/src/plugins/inngest.ts:
    //   import { exampleInngestFunctions } from '../../extensions/example-inngest/index.js'
    //   const functions = [...exampleInngestFunctions]

    const dailyReport = inngest.createFunction(
      { id: 'example-daily-report' },
      { cron: '0 9 * * 1-5' }, // 9am UTC, weekdays
      async ({ step }) => {
        const count = await step.run('count-records', async () => {
          const [row] = await database('nivaro_activity').count('id as n')
          return Number((row as { n: number }).n)
        })
        logger.info({ count }, '[example-inngest] daily report')
        return { count }
      }
    )

    // ─── 3. Event-triggered Inngest function ─────────────────────────────────
    const greetUser = inngest.createFunction(
      { id: 'example-greet-user' },
      { event: 'example/greeting.requested' },
      async ({ event, step }) => {
        const name = (event.data as { name?: string }).name ?? 'world'
        const greeting = await step.run('build-greeting', () => `Hello, ${name}!`)
        await step.run('log-greeting', () => {
          logger.info({ greeting }, '[example-inngest] greeting built')
        })
        return { greeting }
      }
    )

    // ─── 4. Route that sends an Inngest event ────────────────────────────────
    app.register(async (fastify) => {
      fastify.post('/example/greet', async (req, reply) => {
        const { name } = req.body as { name?: string }
        await inngest.send({ name: 'example/greeting.requested', data: { name } })
        return reply.send({ ok: true, message: 'Greeting queued' })
      })
    })

    registeredFunctions.push(dailyReport, greetUser)
    logger.info('[example-inngest] registered')
  }
}

export { registeredFunctions as exampleInngestFunctions }
export default plugin
