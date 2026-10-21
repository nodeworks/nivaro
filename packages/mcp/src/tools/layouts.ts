/**
 * Layout tools (#2694) — read how a collection's forms are built and why a
 * record or a role sees what it sees, and PROPOSE layout changes. Registered
 * with the admin tools (`adminTools: true`); the API answers 403 to anyone
 * who is not an administrator either way.
 *
 * Nothing here changes a layout: propose_layout_ops stores the ops as a
 * proposal that an administrator reviews in the layout editor (Proposals),
 * then applies to their draft or rejects.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  describeLayoutForm,
  explainLayoutField,
  type NivaroClient,
  proposeLayoutOps,
  readLayoutOverview,
  whichLayoutForm
} from '@nivaro/sdk'
import { z } from 'zod'
import { READ, WRITE } from '../annotations.js'
import { fail, ok, refuse } from '../result.js'
import { collectionName, recordId } from '../schema.js'

const layoutId = z.number().int().positive().describe('Layout id (from describe_layout).')
const roleName = z
  .string()
  .max(80)
  .optional()
  .describe('Role name or id. Omitted = as an administrator.')

/** The ops vocabulary, short — the same batch the layout editor saves. */
const OPS_HELP = [
  'Each op is one of:',
  '{"op":"place","field":"<field key>","group_key":"<section key or null>","index":<n>,"patch"?:{…}}',
  '{"op":"move","from":{"field":"<key>","group_key":"<section key>"},"to_group_key":"<section key or null>","index":<n>}',
  '{"op":"update_placement","at":{"field":"<key>","group_key":"<section key>"},"patch":{"label_override"?,"col_span"?:12|6|4|3,"is_visible"?,"overrides"?:{"required"?,"readonly"?,"hidden"?}}}',
  '{"op":"remove","at":{"field":"<key>","group_key":"<section key>"}}',
  '{"op":"group_create","key":"<new key>","label":"<name>","group_type":"section"|"tab","parent_key":null,"index":<n>}',
  '{"op":"group_update","key":"<section key>","patch":{"label"?,"is_collapsed"?,"hidden_for_roles"?:"[\\"<role id>\\"]"}}',
  '{"op":"group_move","key":"<section key>","parent_key":null,"index":<n>}',
  '{"op":"group_remove","key":"<section key>","placements":"ungroup"|"delete"}',
  '{"op":"layout_update","patch":{"disable_comments"?,"validate_before_next"?,…}}'
].join(' ')

export function registerLayoutTools(server: McpServer, client: NivaroClient) {
  server.registerTool(
    'describe_layout',
    {
      title: 'Describe a form',
      description:
        'With layout_id: one form (layout) as an admin reads it — who gets it, its record rule, settings that are on, sections (key, label, rules) with their fields (key, label, width, required, read-only, hidden), and collection fields that are not on it. With only collection: every layout of the collection (id, name, kind, which records or roles get it) to pick from. Admin only.',
      inputSchema: {
        collection: collectionName.optional(),
        layout_id: layoutId.optional()
      },
      annotations: READ
    },
    async ({ collection, layout_id }) => {
      try {
        if (layout_id) return ok((await client.request(describeLayoutForm(layout_id))).data)
        if (!collection)
          return refuse('Give layout_id, or a collection to list its layouts', 'BAD_INPUT')
        const res = await client.request(readLayoutOverview(collection))
        return ok({
          collection,
          layouts: res.data.rows.map((r) => ({
            layout_id: r.layout_id,
            name: r.name,
            kind: r.layout_type,
            section: r.section,
            default: r.is_default,
            picked_by: r.reason?.kind ?? null,
            roles: r.reason?.role_names ?? undefined,
            fields: r.shape?.fields,
            warnings: r.warnings?.length ? r.warnings : undefined
          })),
          next: 'Call describe_layout with a layout_id for its sections and fields.'
        })
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'which_form',
    {
      title: 'Which form a record gets',
      description:
        'Which form (layout) a record opens with for a role, and why: the live resolver with every candidate it checked. Without item: the form any record of the collection gets. Admin only.',
      inputSchema: {
        collection: collectionName,
        item: recordId.optional(),
        role: roleName
      },
      annotations: READ
    },
    async ({ collection, item, role }) => {
      try {
        const res = await client.request(
          whichLayoutForm({
            collection,
            ...(item !== undefined ? { item: String(item) } : {}),
            ...(role ? { role } : {})
          })
        )
        return ok(res.data)
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'explain_field',
    {
      title: 'Why a field shows or hides',
      description:
        "Why a field is shown, hidden or read-only for a role (and a record): the role's permissions, the form it gets, where the field sits, and the form's rules (sections hidden or read-only for roles, sections that show only when…). Answers with a verdict and the reasons in order. Record values are never returned. Admin only.",
      inputSchema: {
        collection: collectionName,
        field: z.string().min(1).max(120).describe('Field key or label.'),
        role: roleName,
        item: recordId.optional(),
        layout_id: layoutId
          .optional()
          .describe('Judge this form instead of the one the resolver picks.')
      },
      annotations: READ
    },
    async ({ collection, field, role, item, layout_id }) => {
      try {
        const res = await client.request(
          explainLayoutField({
            collection,
            field,
            ...(role ? { role } : {}),
            ...(item !== undefined ? { item: String(item) } : {}),
            ...(layout_id ? { layout_id } : {})
          })
        )
        return ok(res.data)
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'propose_layout_ops',
    {
      title: 'Propose form changes',
      description: `Propose changes to a form for an administrator to review. NOTHING changes: the proposal waits in the layout editor (Proposals) until an administrator applies it to their draft or rejects it. Read the form with describe_layout first and use its field and section keys. Unknown fields and settings are left out (listed in "dropped"); changes that would not apply are refused with the reason. ${OPS_HELP}`,
      inputSchema: {
        layout_id: layoutId,
        ops: z.array(z.record(z.unknown())).min(1).max(200),
        note: z
          .string()
          .max(500)
          .optional()
          .describe('Why: one or two sentences the reviewing administrator reads first.')
      },
      annotations: WRITE
    },
    async ({ layout_id, ops, note }) => {
      try {
        const res = await client.request(
          proposeLayoutOps(layout_id, { ops, ...(note ? { note } : {}) })
        )
        return ok(res.data)
      } catch (err) {
        return fail(err)
      }
    }
  )
}
