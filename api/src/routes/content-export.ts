import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { csvFormulaSafe } from '../lib/csv-formula.js'
import { authenticate } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  assertExportDiskRoom,
  ExportAborted,
  ExportTextWriter,
  exportErrorAnswer,
  NdjsonSpool,
  sendExportFile
} from '../services/export-files.js'
import { readExportLimit } from '../services/export-limits.js'
import { ExportPager } from '../services/export-paging.js'
import { isFilesCollection } from '../services/help-video-files.js'
import {
  CollectionNotFoundError,
  ForbiddenError,
  getActualColumns,
  LIST_READ_MAX,
  readItems
} from '../services/items.js'
import { can } from '../services/permissions.js'
import { clientGoneSignal, withReadGate } from '../services/read-gate.js'
import type { ItemsQuery } from '../types.js'

/**
 * Every matching row the caller may read, page by page through readItems — each page handed to
 * `onPage` as it arrives (the export streams it to a temp file), never collected. Answers the
 * row count and whether more rows matched than one export holds. Content export always answers
 * in the request, so it holds at most `request_rows`; each page read takes a heavy-read slot,
 * pages by keyset on id (services/export-paging.ts), and it stops when the caller leaves.
 */
export async function forEachPageAsCaller(
  req: FastifyRequest,
  collection: string,
  base: Pick<ItemsQuery, 'fields' | 'filter'>,
  onPage: (rows: Record<string, unknown>[]) => Promise<void>,
  opts: { signal?: AbortSignal } = {}
): Promise<{ rows: number; truncated: boolean; limit: number }> {
  const hasId = [...(await getActualColumns(collection))].some((c) => c.toLowerCase() === 'id')
  const query: ItemsQuery = {
    ...base,
    sort: hasId ? ['id'] : [],
    limit: LIST_READ_MAX,
    count: false
  }
  const ws = req.workspaceId ?? undefined
  const who = req.user?.id ? String(req.user.id) : null
  const gate = <T>(fn: () => Promise<T>) =>
    withReadGate(who, fn, { signal: opts.signal, label: `content-export:${collection}` })
  const pager = new ExportPager(query.sort, base.fields, base.filter)
  // Answered in the request: the request cap (Settings → Export limits).
  const maxRows = await readExportLimit('request_rows')
  let rows = 0
  for (let offset = 0; ; offset += LIST_READ_MAX) {
    if (opts.signal?.aborted) throw new ExportAborted()
    if (rows >= maxRows) {
      const next = pager.page(maxRows)
      const more = await gate(() =>
        readItems(req.user!, collection, { ...query, ...next, fields: ['id'], limit: 1 }, req, ws)
      )
      return { rows, truncated: more.data.length > 0, limit: maxRows }
    }
    const next = pager.page(offset)
    const page = await gate(() => readItems(req.user!, collection, { ...query, ...next }, req, ws))
    const data = page.data as Record<string, unknown>[]
    pager.saw(data)
    await onPage(data)
    rows += data.length
    if (data.length < LIST_READ_MAX) return { rows, truncated: false, limit: maxRows }
  }
}

function escapeCsv(v: unknown): string {
  if (v == null) return ''
  // A leading = + - @ (or tab/CR) would run as a formula when the file opens in Excel.
  const s = csvFormulaSafe(v)
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

const XLSX_NOTE = 'XLSX export requires exceljs; JSON returned instead'

export async function contentExportRoutes(app: FastifyInstance) {
  app.post('/:collection', { preHandler: authenticate }, async (req, reply) => {
    const { collection } = req.params as { collection: string }

    if (/^nivaro_/i.test(collection) || isFilesCollection(collection)) {
      return reply.code(403).send({ error: 'Cannot export system tables' })
    }

    const body = req.body as {
      format?: 'csv' | 'json' | 'xlsx'
      filters?: Record<string, unknown>
      fields?: string[]
    }

    const format = body.format ?? 'json'
    const filterMap = body.filters ?? {}
    const requestedFields = body.fields

    if (!(await can(req.user!, 'read', collection))) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    // Verify collection is registered
    const colMeta = await db('nivaro_collections').where({ collection }).first()
    if (!colMeta) {
      return reply.code(404).send({ error: 'Collection not found' })
    }

    // Rows come from the items service AS THE CALLER (H16): field policy,
    // row filter, User Scopes, workspace scope and system-column rules all
    // apply — never a raw table read. Equality filters become `_eq` filters,
    // so a filter on a field the caller may not read is refused there too.
    const filter: Record<string, unknown> = {}
    for (const [key, val] of Object.entries(filterMap)) {
      if (val !== undefined && val !== null) filter[key] = { _eq: val }
    }
    const fieldList =
      requestedFields && requestedFields.length > 0 ? requestedFields.map(String) : ['*']

    // Streamed (services/export-files.ts): every page goes to a temp file as it is read. The
    // CSV's columns are only known at the end (the keys the caller's reads returned), so its
    // rows go through a spool of finished cells first.
    const csv = format === 'csv'
    let out: ExportTextWriter | null = null
    let spool: NdjsonSpool | null = null
    try {
      await assertExportDiskRoom()
      out = await ExportTextWriter.open(csv ? '.csv' : '.json')
      const writer = out
      if (csv) spool = await NdjsonSpool.open()
      const sp = spool
      const seen = new Set<string>()
      let written = 0
      if (!csv) await out.write('{"data":[')
      let result: { rows: number; truncated: boolean; limit: number }
      try {
        result = await forEachPageAsCaller(
          req,
          collection,
          { fields: fieldList, filter },
          async (rows) => {
            if (!sp) {
              let text = ''
              for (const r of rows) text += `${written++ > 0 ? ',' : ''}${JSON.stringify(r)}`
              await writer.write(text)
              return
            }
            for (const r of rows) {
              const cells: Record<string, string> = {}
              for (const k of Object.keys(r)) {
                seen.add(k)
                cells[k] = escapeCsv(r[k])
              }
              await sp.write(cells)
            }
          },
          { signal: clientGoneSignal(reply.raw) }
        )
      } catch (err) {
        if (err instanceof ForbiddenError) {
          await out.discard()
          return reply.code(403).send({ error: 'Forbidden' })
        }
        if (err instanceof CollectionNotFoundError) {
          await out.discard()
          return reply.code(404).send({ error: 'Collection not found' })
        }
        throw err
      }
      if (result.truncated) reply.header('x-nivaro-export-truncated', String(result.limit))

      // Determine field list
      // Only columns the caller's read actually returned (a field the policy
      // hides is never echoed back as an empty column).
      const fields =
        requestedFields && requestedFields.length > 0
          ? requestedFields.map(String).filter((f) => f !== '*' && seen.has(f))
          : [...seen]

      await logActivity({
        action: 'export',
        user: req.user?.id,
        collection,
        comment: `${format} (${result.rows} rows)`,
        req
      })

      if (spool) {
        await spool.finish()
        await out.write(fields.map(escapeCsv).join(','))
        let text = ''
        for await (const cells of spool.read<Record<string, string>>()) {
          text += `\r\n${fields.map((f) => cells[f] ?? '').join(',')}`
          if (text.length >= 256 * 1024) {
            await out.write(text)
            text = ''
          }
        }
        await out.write(text)
      } else {
        // XLSX requires exceljs — return JSON with note for now
        await out.write(format === 'xlsx' ? `],"_note":${JSON.stringify(XLSX_NOTE)}}` : ']}')
      }
      await out.close()
      return sendExportFile(reply, {
        path: out.path,
        filename: `${collection}-export.${csv ? 'csv' : 'json'}`,
        contentType: csv ? 'text/csv' : 'application/json'
      })
    } catch (err) {
      await out?.discard()
      const known = exportErrorAnswer(err)
      if (known) return reply.code(known.status).send(known.body)
      throw err
    } finally {
      await spool?.discard()
    }
  })
}
