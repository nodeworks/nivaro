/**
 * SLA and at-risk lookups (#2496) — read-only. One record or a batch of ids:
 * the SLA clock (state, elapsed, remaining, status) and, where an at-risk rule
 * matches, which rule and the conditions that made it match. Both ride the
 * app's own routes, so records the key's user cannot see are left out, and a
 * collection they cannot read is refused.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  evaluateAtRisk,
  getSlaStatus,
  listActiveAtRiskRules,
  type NivaroClient,
  readItems,
  readSlaStatusBatch
} from '@nivaro/sdk'
import { z } from 'zod'
import { READ } from '../annotations.js'
import { fail, ok, refuse } from '../result.js'
import { collectionName, recordId } from '../schema.js'

type Row = Record<string, unknown>

const MAX_IDS = 100

function conditionText(c: Row): string {
  const op = String(c.op ?? '')
  if (op === 'null') return `${c.field} is empty`
  if (op === 'nnull') return `${c.field} is set`
  const words: Record<string, string> = {
    eq: '=',
    neq: '!=',
    gt: '>',
    gte: '>=',
    lt: '<',
    lte: '<=',
    contains: 'contains'
  }
  return `${c.field} ${words[op] ?? op} ${JSON.stringify(c.value)}`
}

export function registerStatusTools(server: McpServer, client: NivaroClient) {
  server.registerTool(
    'sla_status',
    {
      title: 'SLA and at-risk status',
      description: `SLA clock and at-risk reasons for one record (item) or a batch of ids (items, up to ${MAX_IDS}) of a collection. SLA: status (ok / warning / breached), state, elapsed and remaining hours; records without an SLA rule are left out of a batch. At-risk: the rule that flags the record and the conditions that made it match. Records the key's user cannot see are not returned.`,
      inputSchema: {
        collection: collectionName,
        item: recordId.optional().describe('One record.'),
        items: z.array(recordId).min(1).max(MAX_IDS).optional().describe('Or a batch of ids.')
      },
      annotations: READ
    },
    async ({ collection, item, items }) => {
      try {
        let ids = items ? items.map(String) : item !== undefined ? [String(item)] : []
        if (ids.length === 0) return refuse('Give item, or items for a batch', 'BAD_INPUT')

        // The at-risk route checks the collection, not each row — so only ids the
        // key's user can read go on (a hidden record is omitted, as in the SLA routes).
        const seen = await client.request(
          readItems(collection, { fields: ['id'], filter: { id: { _in: ids } }, limit: ids.length })
        )
        const visible = new Set((seen.data ?? []).map((r) => String((r as Row).id)))
        const omitted = ids.length - visible.size
        if (visible.size === 0) {
          return refuse('Record not found', 'NOT_FOUND')
        }
        ids = ids.filter((id) => visible.has(id))

        const [sla, risk, rules] = await Promise.all([
          ids.length === 1 && !items
            ? client
                .request(getSlaStatus(collection, ids[0]))
                .then((s) => ({ [ids[0]]: s }) as unknown as Record<string, Row>)
            : client
                .request(readSlaStatusBatch(collection, ids))
                .then((r) => r.data as unknown as Record<string, Row>),
          client
            .request(evaluateAtRisk(collection, ids))
            .then((r) => r.data as unknown as Record<string, Row>),
          client
            .request(listActiveAtRiskRules(collection))
            .then((r) => (r.data ?? []) as unknown as Row[])
            .catch(() => [] as Row[])
        ])

        const results = ids.map((id) => {
          const s = sla[id] as Row | undefined
          const r = risk[id]
          const rule = r ? rules.find((x) => x.name === r.rule) : undefined
          const clock =
            s && s.status !== 'none'
              ? {
                  status: s.status,
                  state: s.state_key ?? null,
                  elapsed_hours: s.elapsed_hours ?? null,
                  remaining_hours:
                    s.remaining_hours ??
                    (typeof s.total_hours === 'number' && typeof s.elapsed_hours === 'number'
                      ? Math.round((s.total_hours - s.elapsed_hours) * 100) / 100
                      : null),
                  total_hours: s.total_hours ?? s.duration_hours ?? null
                }
              : null
          return {
            item: id,
            sla: clock,
            at_risk: r
              ? {
                  rule: r.rule,
                  color: r.color,
                  because: Array.isArray(rule?.conditions)
                    ? (rule?.conditions as Row[]).map(conditionText)
                    : undefined
                }
              : null
          }
        })
        return ok({
          collection,
          results,
          ...(omitted > 0 ? { omitted } : {}),
          note: 'sla null = no SLA clock running; at_risk null = no at-risk rule matches. Records you cannot see are omitted by the API.'
        })
      } catch (err) {
        return fail(err)
      }
    }
  )
}
