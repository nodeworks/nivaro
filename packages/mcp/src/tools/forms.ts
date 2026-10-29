/**
 * Form tools (#3216 render_form, #3218 form_state): what a record's form
 * shows, requires and locks for the key's user — and a picture of it. Both
 * answer from the API's form state (the live layout resolver with the
 * caller's role, screen and A/B half; the field rows /field-config answers;
 * the form's section, field and value rules), computed AS THE CALLER.
 * Looking as another role is for administrators only (the API answers 403
 * to anyone else). Nothing here changes a record.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { type NivaroClient, readFormState, renderFormImage } from '@nivaro/sdk'
import { z } from 'zod'
import { READ } from '../annotations.js'
import { fail, ok, refuse } from '../result.js'
import { collectionName, jsonObject, recordId, toObject } from '../schema.js'

const layoutId = z
  .number()
  .int()
  .positive()
  .describe('Judge this form (layout id) instead of the one the record opens with.')
const roleName = z
  .string()
  .max(80)
  .optional()
  .describe('Administrators only: look as this role (name or id). Omitted = as the key’s user.')
const values = jsonObject
  .optional()
  .describe(
    'Field values to lay over the record (or a new record when no item): {field: value}. Rules run on them; nothing is saved.'
  )

/** The form state, trimmed for a model: names in lists, a reason per hidden or locked field. */
export function compactFormState(data: Record<string, unknown>): Record<string, unknown> {
  const fields = (data.fields ?? []) as Array<Record<string, unknown>>
  const groups = (data.groups ?? []) as Array<Record<string, unknown>>
  const label = (f: Record<string, unknown>) =>
    f.label && f.label !== f.field ? `${f.field} (${String(f.label)})` : String(f.field)
  const out: Record<string, unknown> = {
    collection: data.collection,
    record: data.record ?? null,
    as: data.as,
    form: data.layout ?? null,
    can_update: data.can_update,
    visible: fields
      .filter((f) => f.visible)
      .map((f) => ({
        field: f.field,
        label: f.label,
        ...(f.section ? { section: f.section } : {}),
        ...(f.required ? { required: true } : {}),
        ...(f.locked ? { locked: true, why: f.why } : {}),
        ...(f.missing ? { missing: true } : {})
      })),
    hidden: fields
      .filter((f) => !f.visible)
      .map((f) => ({ field: label(f), by: f.hidden_by, why: f.why })),
    summary: data.summary
  }
  const hiddenSections = groups.filter((g) => !g.visible)
  if (hiddenSections.length)
    out.hidden_sections = hiddenSections.map((g) => ({ section: g.label, why: g.why }))
  const lockedSections = groups.filter((g) => g.visible && g.locked)
  if (lockedSections.length) out.read_only_sections = lockedSections.map((g) => g.label)
  const derived = data.derived as Record<string, unknown> | undefined
  if (derived && Object.keys(derived).length) out.rules_would_fill = derived
  if (data.note) out.note = data.note
  return out
}

function parseValues(raw: unknown): Record<string, unknown> | undefined {
  return toObject(raw as Record<string, unknown> | string | undefined)
}

export function registerFormTools(server: McpServer, client: NivaroClient) {
  server.registerTool(
    'form_state',
    {
      title: 'Form state for some values',
      description:
        "Which fields a record's form shows, requires and locks for the key's user — given an optional record, an optional form and field values (nothing is saved). Answers the form the record opens with and why, the visible fields (required, read-only with the reason, required-but-empty as missing), the hidden ones with the rule that hides them, sections hidden or read-only, and the values the form's rules would fill in from yours. Use it before create_item / update_item to know what a save needs.",
      inputSchema: {
        collection: collectionName,
        item: recordId.optional().describe('The record. Omitted = a new record.'),
        layout_id: layoutId.optional(),
        values,
        role: roleName,
        viewport: z.enum(['desktop', 'phone']).optional().describe('phone = the phone version.')
      },
      annotations: READ
    },
    async ({ collection, item, layout_id, values: raw, role, viewport }) => {
      let vals: Record<string, unknown> | undefined
      try {
        vals = parseValues(raw)
      } catch (err) {
        return refuse((err as Error).message, 'BAD_VALUES')
      }
      try {
        const res = await client.request(
          readFormState({
            collection,
            ...(item !== undefined ? { item: String(item) } : {}),
            ...(layout_id ? { layout_id } : {}),
            ...(vals ? { values: vals } : {}),
            ...(role ? { role } : {}),
            ...(viewport === 'phone' ? { viewport: 'phone' as const } : {})
          })
        )
        return ok(compactFormState(res.data as unknown as Record<string, unknown>))
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'render_form',
    {
      title: 'Picture of a form',
      description:
        "A PNG image of how a record's form looks for the key's user (administrators: for a role): its sections and fields at their widths, required marks, read-only locks, and the record's values — only values the key's user may read, and with a role, only fields that role may read too. Without item: a new record's form. values fills in unsaved values; show_hidden draws what rules hide, dashed, with the reason.",
      inputSchema: {
        collection: collectionName,
        item: recordId.optional().describe('The record. Omitted = a new record.'),
        layout_id: layoutId.optional(),
        values,
        role: roleName,
        viewport: z.enum(['desktop', 'phone']).optional().describe('phone = drawn at phone width.'),
        theme: z.enum(['light', 'dark']).optional().describe('Default light.'),
        show_hidden: z.boolean().optional().describe('Also draw hidden fields and sections.')
      },
      annotations: READ
    },
    async ({ collection, item, layout_id, values: raw, role, viewport, theme, show_hidden }) => {
      let vals: Record<string, unknown> | undefined
      try {
        vals = parseValues(raw)
      } catch (err) {
        return refuse((err as Error).message, 'BAD_VALUES')
      }
      try {
        const res = await client.request(
          renderFormImage({
            collection,
            ...(item !== undefined ? { item: String(item) } : {}),
            ...(layout_id ? { layout_id } : {}),
            ...(vals ? { values: vals } : {}),
            ...(role ? { role } : {}),
            ...(viewport === 'phone' ? { viewport: 'phone' as const } : {}),
            ...(theme ? { theme } : {}),
            ...(show_hidden ? { show_hidden: true } : {})
          })
        )
        const d = res.data
        if (!d?.base64) return refuse('The instance sent no image', 'NO_IMAGE')
        const result: CallToolResult = {
          content: [
            { type: 'image', data: d.base64, mimeType: d.mime || 'image/png' },
            {
              type: 'text',
              text: JSON.stringify({
                collection: d.collection,
                record: d.record,
                as: d.as,
                form: d.layout,
                can_update: d.can_update,
                summary: d.summary,
                width: d.width,
                bytes: d.bytes
              })
            }
          ]
        }
        return result
      } catch (err) {
        return fail(err)
      }
    }
  )
}
