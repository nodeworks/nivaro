/**
 * Access-explain tool (#2495) — "why can't this person see this record".
 * Wraps GET /api/access-explain/:collection/:id?user_id=…, which re-runs each
 * access gate separately (role permission, row filter, User Scopes) and names
 * the ones that hid the record. Reasons only, never record data. Registered
 * with the admin tools; the API refuses the as-another-person form to anyone
 * who is not an administrator.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { explainRecordAccess, type NivaroClient } from '@nivaro/sdk'
import { READ } from '../annotations.js'
import { fail, ok } from '../result.js'
import { collectionName, recordId, uuid } from '../schema.js'

export function registerAccessTools(server: McpServer, client: NivaroClient) {
  server.registerTool(
    'explain_access',
    {
      title: 'Why a record is hidden from someone',
      description:
        "Admin only. Why a person can or cannot see one record: each access gate (role permission, row filter, User Scopes dimensions) re-run separately, answering which one hid it. user_id = the person to judge (from find_people); omit for the key's own user. Reasons only — record values are never returned.",
      inputSchema: {
        collection: collectionName,
        id: recordId,
        user_id: uuid.optional().describe('The person to explain access for.')
      },
      annotations: READ
    },
    async ({ collection, id, user_id }) => {
      try {
        const res = await client.request(
          explainRecordAccess(collection, id, user_id ? { user_id } : undefined)
        )
        return ok({ collection, id, ...res.data })
      } catch (err) {
        return fail(err)
      }
    }
  )
}
