// @ts-nocheck

// example-flows extension
//
// Demonstrates registering custom operation types and custom trigger types
// so they appear in the Nivaro flow editor alongside built-in ops/triggers.
//
// Custom operations:
//   ctx.flows.registerOperation({ type, label, fields, handler })
//   — type:    unique string (namespace it: '<ext-id>:<name>')
//   — fields:  drives the config UI in the flow editor (no custom UI code needed)
//   — handler: called at runtime with (parsedOptions, flowData, execContext)
//              must return { status: 'resolve' | 'reject', output: FlowData }
//
// Custom triggers:
//   ctx.flows.registerTrigger({ type, label, fields })
//   — type:   unique string; appears in the trigger dropdown
//   — fields: config shown in the trigger panel when selected
//   Emit the trigger from hooks, cron jobs, or route handlers:
//   ctx.flows.emit('my-trigger-type', { ...payload })
//
// Drop this folder into api/extensions/ to activate it.

import type { FastifyInstance } from 'fastify'
import type { Knex } from 'knex'

// ─── Shared types (mirror of ExtensionContext from loader.ts) ─────────────────

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

type FlowData = Record<string, unknown>
type OpResult = { status: 'resolve' | 'reject'; output: FlowData }

interface ExtensionContext {
  app: FastifyInstance
  database: Knex
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
      fields?: FlowFieldSchema[]
      handler(opts: FlowData, data: FlowData, ctx: FlowExecContext): Promise<OpResult>
    }): void
    registerTrigger(trigger: {
      type: string
      label: string
      description?: string
      fields?: FlowFieldSchema[]
    }): void
    emit(triggerType: string, payload: FlowData): void
  }
}

interface Extension {
  id: string
  register(ctx: ExtensionContext): void | Promise<void>
}

// ─── Extension ────────────────────────────────────────────────────────────────

const plugin: Extension = {
  id: 'example-flows',

  async register({ app, database, logger, hooks, cron, flows }) {
    // ── Custom trigger: record-flagged ────────────────────────────────────────
    //
    // Fires when any record in a watched collection is flagged. Emit it from a
    // hook (below) so active flows using this trigger execute automatically.
    //
    // In the flow editor: select "Record Flagged" in the trigger dropdown.
    // The `collection` field lets each flow scope to a specific table.

    flows.registerTrigger({
      type: 'example-flows:record-flagged',
      label: 'Record Flagged',
      description: 'Fires when a record is marked as flagged in any collection',
      fields: [
        {
          key: 'collection',
          label: 'Collection',
          type: 'string',
          placeholder: 'e.g. articles',
          description: 'Only fire for this collection. Leave blank to fire for all.'
        }
      ]
    })

    // Hook that emits the trigger whenever a record gains flagged=true
    hooks.after('*', 'update', async (ctx) => {
      const c = ctx as {
        collection: string
        item?: Record<string, unknown>
        previousData?: Record<string, unknown>
      }
      const nowFlagged = c.item?.flagged === true || c.item?.flagged === 1
      const wasFlagged = c.previousData?.flagged === true || c.previousData?.flagged === 1
      if (nowFlagged && !wasFlagged) {
        flows.emit('example-flows:record-flagged', {
          collection: c.collection,
          item: c.item ?? {}
        })
      }
    })

    // ── Custom trigger: daily-digest ──────────────────────────────────────────
    //
    // Fires on a cron schedule. Flows using this trigger run automatically
    // at the configured time without any user action.

    flows.registerTrigger({
      type: 'example-flows:daily-digest',
      label: 'Daily Digest',
      description: 'Fires once per day at midnight UTC'
    })

    cron.schedule('daily-digest-emit', '0 0 * * *', () => {
      flows.emit('example-flows:daily-digest', { firedAt: new Date().toISOString() })
    })

    // ── Custom operation: format-text ─────────────────────────────────────────
    //
    // Reads a string field from flow data, applies a transformation, and writes
    // the result back under a new key. All config comes from `fields` — no
    // custom UI code needed; the flow editor renders it automatically.

    flows.registerOperation({
      type: 'example-flows:format-text',
      label: 'Format Text',
      description: 'Transform a text field: uppercase, lowercase, trim, slugify',
      color: '#7c3aed',
      fields: [
        {
          key: 'source_field',
          label: 'Source Field',
          type: 'string',
          placeholder: 'e.g. title',
          required: true,
          description: 'Dot-path into flow data (e.g. item.title)'
        },
        {
          key: 'transform',
          label: 'Transform',
          type: 'select',
          options: [
            { value: 'uppercase', label: 'UPPERCASE' },
            { value: 'lowercase', label: 'lowercase' },
            { value: 'trim', label: 'Trim whitespace' },
            { value: 'slugify', label: 'slugify' },
            { value: 'titlecase', label: 'Title Case' }
          ],
          defaultValue: 'trim'
        },
        {
          key: 'output_key',
          label: 'Output Key',
          type: 'string',
          placeholder: 'e.g. $formatted_title',
          required: true,
          description: 'Key written into flow data with the result'
        }
      ],

      async handler(opts, data, ctx) {
        const sourcePath = String(opts.source_field ?? '')
        const transform = String(opts.transform ?? 'trim')
        const outputKey = String(opts.output_key ?? '$formatted')

        // Resolve dot-path
        const raw = sourcePath.split('.').reduce<unknown>((cur, key) => {
          if (cur !== null && cur !== undefined && typeof cur === 'object') {
            return (cur as Record<string, unknown>)[key]
          }
          return undefined
        }, data)

        const input = String(raw ?? '')

        let result: string
        switch (transform) {
          case 'uppercase':
            result = input.toUpperCase()
            break
          case 'lowercase':
            result = input.toLowerCase()
            break
          case 'trim':
            result = input.trim()
            break
          case 'titlecase':
            result = input.replace(/\b\w/g, (c) => c.toUpperCase())
            break
          case 'slugify':
            result = input
              .toLowerCase()
              .trim()
              .replace(/[^\w\s-]/g, '')
              .replace(/[\s_]+/g, '-')
              .replace(/^-+|-+$/g, '')
            break
          default:
            result = input
        }

        ctx.log.debug(
          { flowId: ctx.flowId, sourcePath, transform, outputKey },
          'format-text applied'
        )
        return { status: 'resolve', output: { ...data, [outputKey]: result } }
      }
    })

    // ── Custom operation: db-lookup ───────────────────────────────────────────
    //
    // Fetches a single row from any collection table and merges it into flow
    // data. Useful for enriching a record with related data mid-flow.

    flows.registerOperation({
      type: 'example-flows:db-lookup',
      label: 'DB Lookup',
      description: 'Fetch a row from a collection and merge it into flow data',
      color: '#0891b2',
      fields: [
        {
          key: 'collection',
          label: 'Collection (table name)',
          type: 'string',
          placeholder: 'e.g. articles',
          required: true
        },
        {
          key: 'match_field',
          label: 'Match Field',
          type: 'string',
          placeholder: 'e.g. id',
          required: true
        },
        {
          key: 'match_value_path',
          label: 'Match Value (flow data path)',
          type: 'string',
          placeholder: 'e.g. item.author_id',
          required: true,
          description: 'Dot-path into current flow data whose value is used for the WHERE clause'
        },
        {
          key: 'output_key',
          label: 'Output Key',
          type: 'string',
          placeholder: 'e.g. $author',
          defaultValue: '$lookup_result',
          description: 'Key written into flow data with the fetched row'
        },
        {
          key: 'fail_on_missing',
          label: 'Reject if not found',
          type: 'boolean',
          defaultValue: false
        }
      ],

      async handler(opts, data, ctx) {
        const collection = String(opts.collection ?? '')
        const matchField = String(opts.match_field ?? 'id')
        const matchPath = String(opts.match_value_path ?? '')
        const outputKey = String(opts.output_key ?? '$lookup_result')
        const failOnMissing = opts.fail_on_missing === true

        const matchValue = matchPath.split('.').reduce<unknown>((cur, key) => {
          if (cur !== null && cur !== undefined && typeof cur === 'object') {
            return (cur as Record<string, unknown>)[key]
          }
          return undefined
        }, data)

        if (matchValue === undefined || matchValue === null) {
          ctx.log.warn(
            { flowId: ctx.flowId, matchPath },
            'db-lookup: match value not found in flow data'
          )
          if (failOnMissing)
            return { status: 'reject', output: { ...data, $error: 'lookup match value missing' } }
          return { status: 'resolve', output: data }
        }

        try {
          const row = await database(collection)
            .where({ [matchField]: matchValue })
            .first()
          if (!row && failOnMissing) {
            return {
              status: 'reject',
              output: { ...data, $error: `no row found in ${collection}` }
            }
          }
          ctx.log.debug(
            { flowId: ctx.flowId, collection, matchField, matchValue },
            'db-lookup: row fetched'
          )
          return { status: 'resolve', output: { ...data, [outputKey]: row ?? null } }
        } catch (err) {
          ctx.log.error({ err, flowId: ctx.flowId, collection }, 'db-lookup: query failed')
          return { status: 'reject', output: { ...data, $error: 'db lookup failed' } }
        }
      }
    })

    // ── Manual trigger endpoint for testing ───────────────────────────────────
    //
    // POST /api/example-flows/trigger-flagged
    // { "collection": "articles", "item": { "id": 1, "title": "Test" } }
    //
    // Lets you fire the record-flagged trigger manually for testing flows
    // without needing to actually update a record.

    app.register(
      async (fastify) => {
        fastify.post('/example-flows/trigger-flagged', async (req, reply) => {
          const body = req.body as { collection?: string; item?: Record<string, unknown> }
          flows.emit('example-flows:record-flagged', {
            collection: body.collection ?? 'unknown',
            item: body.item ?? {}
          })
          return reply.send({ ok: true, message: 'Trigger emitted' })
        })
      },
      { prefix: '/api' }
    )

    logger.info('[example-flows] registered — 2 triggers, 2 operations')
  }
}

export default plugin
