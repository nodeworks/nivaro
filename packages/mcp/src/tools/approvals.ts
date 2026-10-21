/**
 * Approval tools (#2494) — the steps waiting on the key's user, and approve /
 * reject one with a note. Decisions go through POST /approvals/instances/:id/decide,
 * i.e. the approval service and chain rules (right approver, current step,
 * pending status) exactly as the app applies them; nothing is re-checked here
 * except that a rehearsal looks the step up in the caller's own waiting list.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { decideApproval, type NivaroClient, readMyWork } from '@nivaro/sdk'
import { z } from 'zod'
import { READ, WRITE } from '../annotations.js'
import { fail, ok } from '../result.js'
import { clampTo, numericId } from '../schema.js'

type Row = Record<string, unknown>

async function waiting(client: NivaroClient): Promise<Row[]> {
  const data = (await client.request(readMyWork())).data as unknown as Row
  return Array.isArray(data.approvals) ? (data.approvals as Row[]) : []
}

export function registerApprovalTools(server: McpServer, client: NivaroClient) {
  server.registerTool(
    'list_approvals',
    {
      title: 'Approvals waiting on me',
      description:
        "Approval steps waiting on the key's user (directly or through their role): instance id, chain, the record and the current step. Decide one with decide_approval.",
      inputSchema: {
        limit: z.number().int().optional().describe('1–50, default 25.')
      },
      annotations: READ
    },
    async ({ limit }) => {
      try {
        const n = clampTo(limit, 25, 50)
        const rows = await waiting(client)
        return ok({
          total: rows.length,
          approvals: rows.slice(0, n).map((a) => ({
            instance_id: a.id,
            chain: a.chain_name,
            collection: a.collection,
            item: a.item,
            current_step: a.current_step
          })),
          ...(rows.length > n ? { note: `Showing the first ${n} of ${rows.length}.` } : {}),
          next: 'Call decide_approval with an instance_id to approve or reject.'
        })
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'decide_approval',
    {
      title: 'Approve or reject an approval step',
      description:
        "Approve or reject the current step of an approval instance as the key's user, with a note. The approval service refuses anyone who is not the step's approver, a step already decided, or an instance no longer pending. Rehearses by default (dry_run: true): checks the step is waiting on the key's user and writes nothing. A rejection should carry a note.",
      inputSchema: {
        instance_id: numericId.describe('Approval instance id (from list_approvals).'),
        decision: z.enum(['approved', 'rejected']),
        note: z.string().max(2000).optional().describe('The reason, kept with the decision.'),
        dry_run: z
          .boolean()
          .default(true)
          .describe('true (default) rehearses, nothing is decided; false records the decision.')
      },
      annotations: WRITE
    },
    async ({ instance_id, decision, note, dry_run }) => {
      try {
        if (dry_run !== false) {
          const mine = (await waiting(client)).find((a) => Number(a.id) === instance_id)
          return ok({
            dry_run: true,
            would_succeed: !!mine,
            ...(mine
              ? { step: { chain: mine.chain_name, collection: mine.collection, item: mine.item } }
              : { why_not: "No step of that approval is waiting on the key's user" }),
            decision,
            ...(decision === 'rejected' && !note ? { hint: 'Add a note saying why.' } : {})
          })
        }
        const res = await client.request(decideApproval(instance_id, decision, note))
        return ok({ dry_run: false, data: res.data })
      } catch (err) {
        return fail(err)
      }
    }
  )
}
