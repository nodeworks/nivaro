/**
 * Around one record — its comments, its change history and its files.
 *
 * File tools return metadata only: they never download a file's content.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import {
  createComment,
  listComments,
  type NivaroClient,
  readCollection,
  readFileMeta,
  readFilesByIds,
  readRevisions
} from '@nivaro/sdk'
import { z } from 'zod'
import { READ, WRITE } from '../annotations.js'
import { clip, clipRow, pageOf, personName } from '../compact.js'
import { fail, ok } from '../result.js'
import { clampTo, collectionName, recordId, uuid } from '../schema.js'
import { readItemFields } from './items.js'

type Row = Record<string, unknown>

const FILE_INTERFACES = new Set(['file', 'file-image'])
const FILES_INTERFACES = new Set(['files-m2m', 'files'])
const FILE_META_KEYS = [
  'id',
  'title',
  'filename_download',
  'type',
  'filesize',
  'width',
  'height',
  'folder',
  'uploaded_on',
  'uploaded_by',
  'uploaded_by_name',
  'tags',
  'expires_at'
] as const

/** A file row cut to its descriptive metadata — never the storage key or a URL. */
export function summarizeFile(f: Row): Row {
  const out: Row = {}
  for (const key of FILE_META_KEYS) {
    if (f[key] !== undefined && f[key] !== null) out[key] = f[key]
  }
  return out
}

export interface FileFieldPlan {
  /** Single-file fields: the column holds the file id. */
  single: string[]
  /** To-many file aliases: `<alias>.<junction field>` reads the file ids. */
  many: Array<{ field: string; path: string }>
}

/** Which of a collection's fields hold files, and how to read their ids. */
export function planFileFields(collection: string, schema: Row): FileFieldPlan {
  const fields = Array.isArray(schema.fields) ? (schema.fields as Row[]) : []
  const relations = Array.isArray(schema.relations) ? (schema.relations as Row[]) : []
  const single: string[] = []
  const many: FileFieldPlan['many'] = []
  for (const f of fields) {
    const name = String(f.field)
    const iface = typeof f.interface === 'string' ? f.interface : ''
    const m2o = relations.find(
      (r) => r.many_collection === collection && r.many_field === name && !r.junction_field
    )
    if (FILE_INTERFACES.has(iface) || m2o?.one_collection === 'nivaro_files') {
      single.push(name)
      continue
    }
    const toMany = relations.find(
      (r) => r.one_collection === collection && r.one_field === name && r.junction_field
    )
    if (!toMany) continue
    const junction = toMany.many_collection
    const leg = String(toMany.junction_field)
    const targetsFiles =
      FILES_INTERFACES.has(iface) ||
      relations.some(
        (r) =>
          r.many_collection === junction &&
          r.many_field === leg &&
          r.one_collection === 'nivaro_files'
      )
    if (targetsFiles) many.push({ field: name, path: `${name}.${leg}` })
  }
  return { single, many }
}

/** The file ids a record read answered (lower-cased), each with the field holding it. */
export function fileIdsOf(record: Row, plan: FileFieldPlan): Map<string, string> {
  const byId = new Map<string, string>()
  const add = (v: unknown, field: string) => {
    const id = v && typeof v === 'object' ? (v as Row).id : v
    if (typeof id !== 'string' || !id.trim()) return
    const key = id.trim().toLowerCase()
    if (!byId.has(key)) byId.set(key, field)
  }
  for (const field of plan.single) add(record[field], field)
  for (const { field, path } of plan.many) {
    const leg = path.slice(field.length + 1)
    const rows = record[field]
    if (!Array.isArray(rows)) continue
    for (const r of rows) add(r && typeof r === 'object' ? (r as Row)[leg] : r, field)
  }
  return byId
}

export function registerRecordTools(server: McpServer, client: NivaroClient) {
  server.registerTool(
    'list_comments',
    {
      title: "A record's comments",
      description:
        'The comment thread on one record, oldest first, with who wrote each and who was mentioned. Long threads show the newest comments; total says how many there are.',
      inputSchema: {
        collection: collectionName,
        id: recordId,
        limit: z.number().int().optional().describe('Newest comments to show (1–200, default 30).')
      },
      annotations: READ
    },
    async ({ collection, id, limit }) => {
      try {
        const res = await client.request(listComments(collection, id))
        const all = res.data as unknown as Row[]
        const n = clampTo(limit, 30, 200)
        const shown = all.slice(-n)
        const out: Row = {
          comments: shown.map((c) => {
            const user = c.user as Row | null
            const mentions = Array.isArray(c.mentions) ? (c.mentions as Row[]) : []
            const row: Row = {
              id: c.id,
              author: user ? personName(user.first_name, user.last_name, user.email) : null,
              text: clip(c.text, 2000),
              at: c.created_at
            }
            if (c.edited) row.edited = true
            if (c.deleted) row.deleted = true
            if (mentions.length > 0) {
              row.mentions = mentions.map((m) => personName(m.first_name, m.last_name, m.email))
            }
            return row
          }),
          total: all.length,
          truncated: shown.length < all.length
        }
        if (shown.length < all.length) {
          out.note = `${all.length - shown.length} older comment(s) are not shown.`
        }
        return ok(out)
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'add_comment',
    {
      title: 'Comment on a record',
      description:
        'Post a comment on one record. Mention people with @ and the part of their email before the @ (find_people gives emails), @owners for the current pipeline owners, @watchers for everyone watching it, or a role name / group slug with hyphens for spaces. Mentioned people are notified.',
      inputSchema: {
        collection: collectionName,
        id: recordId,
        text: z.string().min(1).max(10000)
      },
      annotations: WRITE
    },
    async ({ collection, id, text }) => {
      try {
        const res = await client.request(createComment({ collection, item: String(id), text }))
        const row = res.data as unknown as Row
        const mentions = Array.isArray(row.mentions) ? (row.mentions as Row[]) : []
        return ok({
          id: row.id,
          at: row.created_at,
          mentioned: mentions.map((m) => personName(m.first_name, m.last_name, m.email) ?? m.id)
        })
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'list_revisions',
    {
      title: "A record's change history",
      description:
        'Who changed what on one record and when, newest first: each entry has the action, the person, the fields that changed (with their new values) and any change reason; pipeline moves appear as events. Use read_item for the current values.',
      inputSchema: {
        collection: collectionName,
        id: recordId,
        limit: z.number().int().optional().describe('Entries per page (1–100, default 20).'),
        offset: z.number().int().min(0).optional()
      },
      annotations: READ
    },
    async ({ collection, id, limit, offset }) => {
      try {
        const res = await client.request(readRevisions(collection, id))
        const page = pageOf(res.data as unknown as Row[], clampTo(limit, 20, 100), offset)
        return ok({
          revisions: page.items.map((r) => {
            const row: Row = {
              id: r.id,
              at: r.timestamp,
              action: r.action,
              by: personName(r.first_name, r.last_name, r.user_email)
            }
            if (r.comment) row.comment = clip(r.comment, 500)
            if (r.delta && typeof r.delta === 'object') {
              row.changes = clipRow(r.delta as Row, 300)
            }
            const event = r.event as Row | undefined
            if (event) {
              row.event = {
                kind: event.kind,
                from: event.from_label ?? null,
                to: event.to_label ?? null,
                transition: event.transition_label ?? null
              }
            }
            return row
          }),
          total: page.total,
          offset: page.offset,
          truncated: page.truncated
        })
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'list_record_files',
    {
      title: "A record's files",
      description:
        "Metadata (name, type, size, uploader, date) of the files held in one record's file fields. Never downloads content.",
      inputSchema: { collection: collectionName, id: recordId },
      annotations: READ
    },
    async ({ collection, id }) => {
      try {
        const schema = await client.request(readCollection(collection))
        const plan = planFileFields(collection, schema.data as Row)
        const fields = [...plan.single, ...plan.many.map((m) => m.path)]
        if (fields.length === 0) {
          return ok({ files: [], note: `${collection} has no file fields.` })
        }
        const record = await client.request(readItemFields(collection, id, fields))
        const ids = fileIdsOf(record.data ?? {}, plan)
        if (ids.size === 0) return ok({ files: [] })
        const list = [...ids.keys()]
        const rows: Row[] = []
        for (let i = 0; i < list.length; i += 100) {
          const res = await client.request(readFilesByIds(list.slice(i, i + 100)))
          rows.push(...(res.data as unknown as Row[]))
        }
        return ok({
          files: rows.map((f) => ({
            field: ids.get(String(f.id).toLowerCase()) ?? null,
            ...summarizeFile(f)
          }))
        })
      } catch (err) {
        return fail(err)
      }
    }
  )

  server.registerTool(
    'read_file',
    {
      title: "A file's metadata",
      description:
        'Name, type, size, dimensions, folder, uploader and date of one file by id. Never downloads content.',
      inputSchema: { file_id: uuid.describe('The file id.') },
      annotations: READ
    },
    async ({ file_id }) => {
      try {
        const res = await client.request(readFileMeta(file_id))
        return ok(summarizeFile(res.data as unknown as Row))
      } catch (err) {
        return fail(err)
      }
    }
  )
}
