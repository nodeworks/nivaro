/**
 * propose_schema_change (#3209): an agent drafts a field or collection change that waits for an
 * administrator. Nothing changes — the proposal is reviewed and applied (or rejected) on the
 * Data Model page by a person signed in to the admin; the API refuses an apply from any key or
 * connected app.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { type NivaroClient, type ProposedSchemaChange, proposeSchemaChange } from '@nivaro/sdk'
import { z } from 'zod'
import { WRITE } from '../annotations.js'
import { fail, ok } from '../result.js'

const name = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'letters, digits and underscores, starting with a letter')

const fieldType = z
  .enum([
    'string',
    'text',
    'integer',
    'bigInteger',
    'boolean',
    'decimal',
    'float',
    'date',
    'datetime',
    'uuid'
  ])
  .describe('Column type. Default string.')

const choices = z
  .array(
    z.object({
      value: z.union([z.string().max(255), z.number()]),
      text: z.string().max(255).optional().describe('What people see; default the value.')
    })
  )
  .max(200)
  .describe('A dropdown’s choices (string or integer fields).')

const fieldSpec = {
  field: name.describe('The new field’s key, e.g. "priority".'),
  type: fieldType.optional(),
  label: z.string().max(120).optional().describe('What the form calls it, e.g. "Priority".'),
  note: z.string().max(500).optional().describe('Help text under the field.'),
  choices: choices.optional(),
  required: z.boolean().optional(),
  max_length: z.number().int().min(1).max(4000).optional().describe('string fields only')
}

const change = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('add_field'), collection: name, ...fieldSpec }),
  z.object({
    kind: z.literal('update_field'),
    collection: name,
    field: name,
    label: z.string().max(120).optional(),
    note: z.string().max(500).optional(),
    choices: choices.optional().describe('Replaces the field’s whole choice list.'),
    required: z.boolean().optional()
  }),
  z.object({
    kind: z.literal('add_collection'),
    collection: name.describe('The new collection’s table name, e.g. "site_visits".'),
    display_name: z.string().max(120).optional(),
    singular: z.string().max(120).optional(),
    plural: z.string().max(120).optional(),
    icon: z.string().max(60).optional(),
    note: z.string().max(500).optional(),
    fields: z.array(z.object(fieldSpec)).max(50).optional()
  })
])

export function registerSchemaProposalTools(server: McpServer, client: NivaroClient) {
  server.registerTool(
    'propose_schema_change',
    {
      title: 'Propose a data model change',
      description:
        'Draft a change to the data model for an administrator to review: add a field, change a field’s label, help note, choices or required flag, or add a collection with its fields. NOTHING changes: the proposal waits on the Data Model page (Proposals) until an administrator applies or rejects it. Read the collection with describe_collection first and use its field keys. Renames, type changes, deletions and relations are not proposals — say what is needed in the note instead. Changes that would not hold (a field that already exists, an unknown collection) are refused with the reason.',
      inputSchema: {
        changes: z.array(change).min(1).max(50),
        note: z
          .string()
          .max(500)
          .optional()
          .describe('Why: one or two sentences the reviewing administrator reads first.')
      },
      annotations: WRITE
    },
    async ({ changes, note }) => {
      try {
        const res = await client.request(
          proposeSchemaChange({
            changes: changes as ProposedSchemaChange[],
            ...(note ? { note } : {})
          })
        )
        return ok(res.data)
      } catch (err) {
        return fail(err)
      }
    }
  )
}
