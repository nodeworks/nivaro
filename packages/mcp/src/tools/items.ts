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
  rehearseCreateItem,
  updateItem
} from '@nivaro/sdk'
import { z } from 'zod'
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

export function registerItemTools(server: McpServer, client: NivaroClient) {
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
      annotations: { readOnlyHint: true }
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
      annotations: { readOnlyHint: true }
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
      annotations: { readOnlyHint: true }
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
      annotations: { destructiveHint: false }
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
        'Patch the fields given on one record. A collection may require a reason for certain field changes — the refusal (code CHANGE_REASON_REQUIRED) names them; retry with change_reason set. A 409 MIDAIR_COLLISION means someone else changed the same fields first.',
      inputSchema: {
        collection: collectionName,
        id: recordId,
        data: jsonObject.describe('Only the fields to change.'),
        change_reason: z
          .string()
          .optional()
          .describe("Why the change is made, recorded in the record's history.")
      },
      annotations: { destructiveHint: false, idempotentHint: true }
    },
    async ({ collection, id, data, change_reason }) => {
      try {
        const payload = { ...(toObject(data) ?? {}) }
        if (change_reason) payload._change_reason = change_reason
        if (Object.keys(payload).length === 0) {
          return refuse('data must name at least one field to change', 'EMPTY_PATCH')
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
        'Delete one record (it lands in the trash where the instance keeps one). Refused unless confirm is true — ask the person before confirming.',
      inputSchema: {
        collection: collectionName,
        id: recordId,
        confirm: z.boolean().optional().describe('Must be true to delete.')
      },
      annotations: { destructiveHint: true }
    },
    async ({ collection, id, confirm }) => {
      if (confirm !== true) {
        return refuse(
          `Deleting ${collection}/${id} needs confirm: true. Nothing was deleted.`,
          'CONFIRM_REQUIRED'
        )
      }
      try {
        await client.request(deleteItem(collection, id))
        return ok({ deleted: true, collection, id })
      } catch (err) {
        return fail(err)
      }
    }
  )
}
