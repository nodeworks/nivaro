/**
 * Pipeline tools — where a record sits, who owns it, what it can do next.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  type NivaroClient,
  type ResolvedOwner,
  readAllStateOwners,
  readWorkflowInstance,
  transitionWorkflow,
  type WorkflowInstanceData
} from '@nivaro/sdk'
import { z } from 'zod'
import { fail, ok } from '../result.js'
import { collectionName, recordId, transitionId } from '../schema.js'

const HISTORY_ROWS = 10

export interface PipelineStateView {
  bound: boolean
  started: boolean
  completed: boolean
  current_state: { id: string; key: string; label: string; is_terminal: boolean } | null
  states: Array<{ id: string; key: string; label: string; sort: number }>
  available_transitions: Array<{
    id: string
    label: string
    to_state: { id: string; key: string; label: string } | null
  }>
  owners: Array<{ id: string; name: string; email: string }> | null
  history: Array<{
    at: string
    from: string | null
    to: string | null
    by: string | null
    comment: string | null
  }>
}

export function buildPipelineView(
  data: WorkflowInstanceData | null,
  ownersByState: Record<string, { owners: ResolvedOwner[] }> | null
): PipelineStateView {
  if (!data) {
    return {
      bound: false,
      started: false,
      completed: false,
      current_state: null,
      states: [],
      available_transitions: [],
      owners: null,
      history: []
    }
  }
  const stateById = new Map(data.states.map((s) => [s.id, s]))
  const current = data.instance ? stateById.get(data.instance.current_state) : undefined
  const owners = data.instance
    ? (ownersByState?.[data.instance.current_state]?.owners ?? null)
    : null
  return {
    bound: true,
    started: !!data.instance,
    completed: !!data.instance?.completed_at,
    current_state: current
      ? { id: current.id, key: current.key, label: current.label, is_terminal: current.is_terminal }
      : null,
    states: data.states.map((s) => ({ id: s.id, key: s.key, label: s.label, sort: s.sort })),
    available_transitions: data.available_transitions.map((t) => {
      const to = stateById.get(t.to_state)
      return {
        id: t.id,
        label: t.label,
        to_state: to ? { id: to.id, key: to.key, label: to.label } : null
      }
    }),
    owners: owners
      ? owners.map((o) => ({
          id: String(o.id),
          name: [o.first_name, o.last_name].filter(Boolean).join(' ') || o.email,
          email: o.email
        }))
      : null,
    history: data.history.slice(0, HISTORY_ROWS).map((h) => ({
      at: h.timestamp,
      from: h.from_state_label,
      to: h.to_state_label,
      by: [h.first_name, h.last_name].filter(Boolean).join(' ') || h.user_email || null,
      comment: h.comment
    }))
  }
}

export function registerPipelineTools(server: McpServer, client: NivaroClient) {
  server.registerTool(
    'list_pipeline_state',
    {
      title: 'Pipeline state of a record',
      description:
        "Where a record sits in its pipeline: current state, the transitions the key's user may run from it (with ids for the transition tool), who owns the current state, and the newest history entries. bound: false means the collection has no pipeline.",
      inputSchema: { collection: collectionName, id: recordId },
      annotations: { readOnlyHint: true }
    },
    async ({ collection, id }) => {
      try {
        const [instance, owners] = await Promise.all([
          client.request(readWorkflowInstance(collection, id)),
          client.request(readAllStateOwners(collection, id)).catch(() => ({ data: null }))
        ])
        return ok(buildPipelineView(instance.data, owners.data))
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'transition',
    {
      title: 'Move a record through its pipeline',
      description:
        "Run one of the available transitions from list_pipeline_state. The API checks the role, the transition's conditions and any required fields; a 422 names what is missing.",
      inputSchema: {
        collection: collectionName,
        id: recordId,
        transition_id: transitionId,
        comment: z.string().optional().describe("Recorded in the record's history.")
      },
      annotations: { destructiveHint: false }
    },
    async ({ collection, id, transition_id, comment }) => {
      try {
        const res = await client.request(transitionWorkflow(collection, id, transition_id, comment))
        return ok(res.data)
      } catch (err) {
        return fail(err)
      }
    }
  )
}
