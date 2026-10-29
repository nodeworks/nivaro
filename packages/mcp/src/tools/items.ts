/**
 * Record tools — read, aggregate, create (rehearsed by default), update, delete.
 *
 * Every call rides the SDK's items commands, so the API's own permission,
 * row-level security, validation and change-reason rules decide the outcome.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  type AggregateQuery,
  aggregateItems,
  type Command,
  createItem,
  deleteItem,
  type Filter,
  type NivaroClient,
  readItems,
  readMcpCapabilities,
  rehearseCreateItem,
  updateItem
} from '@nivaro/sdk'
import { z } from 'zod'
import { DESTRUCTIVE, READ, WRITE, WRITE_IDEMPOTENT } from '../annotations.js'
import {
  CONFIRM_TTL_MS,
  checkConfirmToken,
  confirmSecretFor,
  mintConfirmToken
} from '../confirm.js'
import { fail, ok, refuse } from '../result.js'
import {
  clampLimit,
  collectionName,
  jsonObject,
  MAX_LIMIT,
  recordId,
  stringList,
  toList,
  toObject
} from '../schema.js'

/** `readItem` with a field projection — the SDK's own command takes none. */
export function readItemFields(
  collection: string,
  id: string | number,
  fields?: string[]
): Command<{ data: Record<string, unknown> }> {
  return {
    _method: 'GET',
    _path: `/items/${collection}/${id}`,
    _params: fields?.length ? { fields: fields.join(',') } : undefined
  }
}

const filterInput = jsonObject
  .optional()
  .describe(
    'Filter object: { status: { _eq: "active" }, owner: { last_name: { _contains: "Smith" } }, tags: { _some: { name: { _eq: "x" } } }, _and/_or: [...] }. Operators: _eq _neq _gt _gte _lt _lte _in _nin _null _nnull _contains _starts_with _ends_with.'
  )

/** PATCH /items/:collection/:id?dry_run=1 — the update rehearsed, nothing saved (#3222). */
export function rehearseUpdateCommand(
  collection: string,
  id: string | number,
  data: Record<string, unknown>
): Command<Record<string, unknown>> {
  return {
    _method: 'PATCH',
    _path: `/items/${collection}/${id}`,
    _params: { dry_run: 1 },
    _body: data
  }
}

/** A rehearsal report cut for a model: long values clipped, empty parts left out. */
export function compactUpdateReport(report: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { dry_run: true }
  for (const [k, v] of Object.entries(report)) {
    if (k === 'dry_run') continue
    if (Array.isArray(v) && v.length === 0) continue
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) continue
    if (k === 'changes' && Array.isArray(v)) {
      out.changes = (v as Array<Record<string, unknown>>).map((c) => ({
        field: c.field,
        from: clipValue(c.from),
        to: clipValue(c.to)
      }))
      continue
    }
    out[k] = v
  }
  return out
}

function clipValue(v: unknown): unknown {
  if (typeof v === 'string') return v.length > 300 ? `${v.slice(0, 300)}…` : v
  if (v && typeof v === 'object') {
    const json = JSON.stringify(v)
    return json.length > 300 ? `${json.slice(0, 300)}… (truncated)` : v
  }
  return v
}

/** A short preview of the record a rehearsal would delete (scalars only, a dozen fields). */
function previewOf(row: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!row || typeof row !== 'object') return out
  for (const [k, v] of Object.entries(row as Record<string, unknown>)) {
    if (Object.keys(out).length >= 12) break
    if (v == null || typeof v === 'object') continue
    out[k] = typeof v === 'string' && v.length > 120 ? `${v.slice(0, 120)}…` : v
  }
  return out
}

export function registerItemTools(
  server: McpServer,
  client: NivaroClient,
  opts: { confirmSecret?: string } = {}
) {
  const confirmSecret = opts.confirmSecret ?? confirmSecretFor(null)
  // Whether the instance rehearses a PATCH with ?dry_run=1. An older one would SAVE it, so a
  // preview is only sent once the instance says it can (asked once per server).
  let previewSupport: Promise<boolean> | null = null
  const canPreviewUpdates = () => {
    previewSupport ??= client
      .request(readMcpCapabilities())
      .then((res) => (res.data as { update_preview?: unknown })?.update_preview === true)
      .catch(() => false)
    return previewSupport
  }
  server.registerTool(
    'read_items',
    {
      title: 'Read records',
      description: `Page through a collection's records as the key's user. Returns { data, total, limit, offset }. Limit is capped at ${MAX_LIMIT}; use offset to page. "fields" narrows the columns (dotted paths follow relations, e.g. "owner.email").`,
      inputSchema: {
        collection: collectionName,
        filter: filterInput,
        sort: stringList
          .optional()
          .describe(
            'Sort fields; prefix "-" for descending, e.g. ["-created_at", "owner.last_name"].'
          ),
        fields: stringList.optional().describe('Columns to return; omit for every column.'),
        search: z
          .string()
          .optional()
          .describe("Free-text search over the collection's text columns."),
        limit: z.number().int().optional().describe(`Rows per page (1–${MAX_LIMIT}, default 25).`),
        offset: z.number().int().min(0).optional()
      },
      annotations: READ
    },
    async ({ collection, filter, sort, fields, search, limit, offset }) => {
      try {
        const res = await client.request(
          readItems(collection, {
            filter: toObject(filter) as Filter | undefined,
            sort: toList(sort),
            fields: toList(fields),
            search: search || undefined,
            limit: clampLimit(limit),
            offset
          })
        )
        return ok(res)
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'read_item',
    {
      title: 'Read one record',
      description: 'One record by id. "fields" narrows the columns; dotted paths follow relations.',
      inputSchema: {
        collection: collectionName,
        id: recordId,
        fields: stringList.optional()
      },
      annotations: READ
    },
    async ({ collection, id, fields }) => {
      try {
        const res = await client.request(readItemFields(collection, id, toList(fields)))
        return ok(res.data)
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'aggregate_items',
    {
      title: 'Aggregate records',
      description:
        'Counts, sums, averages, minimums and maximums over the records a read_items call with the same filter would return — grouped by up to four fields. Returns { data: [{ group, countAll, sum, avg, min, max, count }], total }.',
      inputSchema: {
        collection: collectionName,
        filter: filterInput,
        search: z.string().optional(),
        groupBy: stringList.optional().describe('Up to 4 stored fields to group by.'),
        countAll: z.boolean().optional().describe('Count rows per group.'),
        count: stringList.optional().describe('Fields to count non-null values of.'),
        countDistinct: stringList.optional(),
        sum: stringList.optional(),
        avg: stringList.optional(),
        min: stringList.optional(),
        max: stringList.optional(),
        sort: stringList
          .optional()
          .describe('Group fields, "countAll" or "<function>.<field>", "-" first for descending.'),
        limit: z.number().int().optional().describe('Groups per page (max 1000).')
      },
      annotations: READ
    },
    async (args) => {
      try {
        const query: AggregateQuery = {
          filter: toObject(args.filter),
          search: args.search || undefined,
          groupBy: toList(args.groupBy),
          countAll: args.countAll,
          count: toList(args.count),
          countDistinct: toList(args.countDistinct),
          sum: toList(args.sum),
          avg: toList(args.avg),
          min: toList(args.min),
          max: toList(args.max),
          sort: toList(args.sort),
          limit: args.limit
        }
        if (
          !query.countAll &&
          !query.count &&
          !query.countDistinct &&
          !query.sum &&
          !query.avg &&
          !query.min &&
          !query.max
        ) {
          query.countAll = true
        }
        return ok(await client.request(aggregateItems(args.collection, query)))
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'create_item',
    {
      title: 'Create a record',
      description:
        'Create a record. By default this is a REHEARSAL (dry_run: true): rules, generated ids, validation and database constraints all run and the report says what would be stored or why the create would be refused — nothing is written. Pass dry_run: false to store it. Relations take ids; to-many aliases take id arrays; nested child rows ride as arrays under their alias.',
      inputSchema: {
        collection: collectionName,
        data: jsonObject.describe('Field values for the new record.'),
        dry_run: z
          .boolean()
          .default(true)
          .describe('true (default) rehearses without writing; false stores the record.')
      },
      annotations: WRITE
    },
    async ({ collection, data, dry_run }) => {
      try {
        const payload = toObject(data) ?? {}
        if (dry_run !== false) {
          const report = await client.request(rehearseCreateItem(collection, payload))
          return ok({ ...report, dry_run: true })
        }
        const res = await client.request(createItem(collection, payload))
        return ok({ dry_run: false, data: res.data })
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'update_item',
    {
      title: 'Update a record',
      description:
        'Patch the fields given on one record. Pass dry_run: true first to PREVIEW: every rule, hook, validation and database check runs and the answer lists each field that would change (from → to), the fields rules would fill in and why a save would be refused — nothing is saved. A collection may require a reason for certain field changes — the refusal (code CHANGE_REASON_REQUIRED) names them; retry with change_reason set. A 409 MIDAIR_COLLISION means someone else changed the same fields first.',
      inputSchema: {
        collection: collectionName,
        id: recordId,
        data: jsonObject.describe('Only the fields to change.'),
        change_reason: z
          .string()
          .optional()
          .describe("Why the change is made, recorded in the record's history."),
        dry_run: z
          .boolean()
          .optional()
          .describe('true previews the change (before/after) without saving; default false saves.')
      },
      annotations: WRITE_IDEMPOTENT
    },
    async ({ collection, id, data, change_reason, dry_run }) => {
      try {
        const payload = { ...(toObject(data) ?? {}) }
        if (change_reason) payload._change_reason = change_reason
        if (Object.keys(payload).length === 0) {
          return refuse('data must name at least one field to change', 'EMPTY_PATCH')
        }
        if (dry_run === true) {
          if (!(await canPreviewUpdates())) {
            return refuse(
              'This instance cannot preview updates (it needs a newer Nivaro). Nothing was sent or saved.',
              'PREVIEW_UNSUPPORTED'
            )
          }
          const report = await client.request(rehearseUpdateCommand(collection, id, payload))
          if (report?.dry_run !== true) {
            return refuse(
              'The instance did not answer with a preview. Check the record with read_item before trying again.',
              'PREVIEW_NOT_RETURNED'
            )
          }
          return ok(compactUpdateReport(report))
        }
        const res = await client.request(updateItem(collection, id, payload))
        return ok(res.data)
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'delete_item',
    {
      title: 'Delete a record',
      description:
        'Delete one record (it lands in the trash where the instance keeps one). Two steps: first call WITHOUT confirm_token (a rehearsal, dry_run: true by default) — it checks the record, shows what would be deleted and returns a confirm_token. Show the person what will be deleted and ask; only after they agree, call again with dry_run: false and that confirm_token (valid 10 minutes, for this record only).',
      inputSchema: {
        collection: collectionName,
        id: recordId,
        dry_run: z
          .boolean()
          .default(true)
          .describe('true (default) rehearses and returns a confirm_token; false deletes.'),
        confirm_token: z
          .string()
          .optional()
          .describe('The token a rehearsal of this exact delete returned. Required to delete.'),
        confirm: z
          .boolean()
          .optional()
          .describe('Deprecated: no longer enough on its own — a confirm_token is required.')
      },
      annotations: DESTRUCTIVE
    },
    async ({ collection, id, dry_run, confirm_token, confirm }) => {
      const action = `delete_item|${collection}|${String(id)}`
      const wantsDelete = dry_run === false || confirm === true
      if (wantsDelete && confirm_token != null) {
        const verdict = checkConfirmToken(confirmSecret, action, confirm_token)
        if (verdict !== 'ok') {
          return refuse(
            verdict === 'expired'
              ? `The confirm_token for ${collection}/${id} has expired. Rehearse again (dry_run: true) and ask the person once more. Nothing was deleted.`
              : `That confirm_token does not belong to deleting ${collection}/${id}. Rehearse this delete (dry_run: true) to get one. Nothing was deleted.`,
            verdict === 'expired' ? 'CONFIRM_TOKEN_EXPIRED' : 'CONFIRM_TOKEN_INVALID'
          )
        }
        try {
          await client.request(deleteItem(collection, id))
          return ok({ deleted: true, collection, id })
        } catch (err) {
          return fail(err)
        }
      }
      if (wantsDelete) {
        return refuse(
          `Deleting ${collection}/${id} needs the confirm_token from a rehearsal: call delete_item with dry_run: true first, show the person what would be deleted, and pass its confirm_token with dry_run: false once they agree. Nothing was deleted.`,
          'CONFIRM_TOKEN_REQUIRED'
        )
      }
      // The rehearsal: the record must be readable as the key's user.
      try {
        const res = await client.request(readItemFields(collection, id))
        return ok({
          dry_run: true,
          would_delete: { collection, id, record: previewOf(res?.data) },
          confirm_token: mintConfirmToken(confirmSecret, action),
          expires_in_seconds: CONFIRM_TTL_MS / 1000,
          note: 'Nothing was deleted. Ask the person; to delete, call again with dry_run: false and this confirm_token.'
        })
      } catch (err) {
        return fail(err)
      }
    }
  )
}
