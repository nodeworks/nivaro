import type { ChatTraceEntry } from './ai-chat-loop.js'

/**
 * "Copy as code" for an Ask AI answer (#2766): the reads a tool made in an
 * answer — its filters, groupings and aggregates, straight from the tool
 * arguments stored on the step — as an SDK call and a REST request, ready for
 * a script, a flow or a custom widget.
 *
 * NEVER MORE THAN THE READER MAY SEE. Every field the snippet names (a filter
 * condition, a grouping, a column, a sort) is checked against the person
 * asking for the code (`access`); a condition on a field they cannot read is
 * left out (and counted), and a read whose aggregate or grouping field they
 * cannot read — or a saved query they may not run, or a collection they
 * cannot read — is skipped whole. Only values written into the stored
 * arguments ever appear, never rows or figures from the answer.
 */

export const CODE_TOOLS = new Set(['query_items', 'aggregate', 'run_custom_query'])

export interface CodeAccess {
  collection(collection: string): Promise<boolean>
  /** A (possibly dotted) field path on `collection`. */
  path(collection: string, path: string[]): Promise<boolean>
  savedQuery(slug: string): Promise<boolean>
}

export interface AnswerSnippet {
  tool: string
  /** One line: what the read does ("Count invoices by vendor"). */
  title: string
  sdk: string
  rest: string
  curl: string
  /** Conditions or columns left out because the reader cannot see them. */
  omitted: number
}

export interface AnswerCode {
  snippets: AnswerSnippet[]
  /** Reads left out whole (a field, collection or query the reader cannot use). */
  skipped: number
}

const NAME_RE = /^[A-Za-z_$][A-Za-z0-9_]*$/
const PATH_RE = /^[A-Za-z_$][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/
const LOGICAL = new Set(['_and', '_or'])

/** A filter with every condition the reader cannot use removed. */
export async function redactFilter(
  filter: unknown,
  collection: string,
  access: CodeAccess,
  counter: { omitted: number }
): Promise<Record<string, unknown> | null> {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return null
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(filter as Record<string, unknown>)) {
    if (LOGICAL.has(key)) {
      if (!Array.isArray(value)) continue
      const parts: Record<string, unknown>[] = []
      for (const part of value) {
        const kept = await redactFilter(part, collection, access, counter)
        if (kept) parts.push(kept)
      }
      if (parts.length) out[key] = parts
      continue
    }
    if (key === '$state') {
      out[key] = value
      continue
    }
    if (!PATH_RE.test(key) || !(await access.path(collection, key.split('.')))) {
      counter.omitted++
      continue
    }
    out[key] = value
  }
  return Object.keys(out).length ? out : null
}

async function keepFields(
  list: unknown,
  collection: string,
  access: CodeAccess,
  counter: { omitted: number },
  strip = (f: string) => f
): Promise<string[]> {
  const out: string[] = []
  for (const raw of Array.isArray(list) ? list : []) {
    const f = String(raw)
    const bare = strip(f)
    if (!PATH_RE.test(bare) || !(await access.path(collection, bare.split('.')))) {
      counter.omitted++
      continue
    }
    out.push(f)
  }
  return out
}

/** JS object literal text, 2-space indent, single quotes (the snippet's house style). */
export function jsLiteral(v: unknown, indent = 0): string {
  const pad = (n: number) => ' '.repeat(n)
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'string') return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) {
    if (!v.length) return '[]'
    const flat = v.every((x) => x === null || typeof x !== 'object')
    if (flat) return `[${v.map((x) => jsLiteral(x)).join(', ')}]`
    return `[\n${v.map((x) => pad(indent + 2) + jsLiteral(x, indent + 2)).join(',\n')}\n${pad(indent)}]`
  }
  const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined)
  if (!entries.length) return '{}'
  return `{\n${entries
    .map(
      ([k, x]) =>
        `${pad(indent + 2)}${NAME_RE.test(k) && !k.startsWith('$') ? k : `'${k}'`}: ${jsLiteral(x, indent + 2)}`
    )
    .join(',\n')}\n${pad(indent)}}`
}

function queryString(params: Record<string, unknown>): string {
  const parts: string[] = []
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue
    parts.push(`${k}=${encodeURIComponent(typeof v === 'string' ? v : String(v))}`)
  }
  return parts.length ? `?${parts.join('&')}` : ''
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

function sdkSnippet(origin: string, importName: string, call: string): string {
  return `import { createNivaro, ${importName} } from '@nivaro/sdk'

const nivaro = createNivaro('${origin}', { token: process.env.NIVARO_TOKEN })
const result = await nivaro.request(${call})`
}

async function snippetFor(
  e: ChatTraceEntry,
  origin: string,
  access: CodeAccess
): Promise<AnswerSnippet | null> {
  const input = (e.input ?? {}) as Record<string, unknown>
  const counter = { omitted: 0 }
  const api = `${origin}/api`
  const auth = '-H "Authorization: Bearer $NIVARO_TOKEN"'

  if (e.tool === 'run_custom_query') {
    const slug = String(input.slug ?? '')
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(slug) || !(await access.savedQuery(slug))) return null
    const params =
      input.params && typeof input.params === 'object' && !Array.isArray(input.params)
        ? (input.params as Record<string, unknown>)
        : {}
    const body = JSON.stringify({ params })
    const url = `${api}/custom-queries/${slug}/execute`
    return {
      tool: e.tool,
      title: `Run the saved query ${slug}`,
      sdk: sdkSnippet(
        origin,
        'executeCustomQuery',
        `executeCustomQuery('${slug}', ${jsLiteral(params)})`
      ),
      rest: `POST ${url}\nContent-Type: application/json\n\n${body}`,
      curl: `curl -X POST ${auth} -H "Content-Type: application/json" \\\n  -d ${shellQuote(body)} \\\n  ${shellQuote(url)}`,
      omitted: 0
    }
  }

  const collection = String(input.collection ?? '')
  if (!NAME_RE.test(collection) || !(await access.collection(collection))) return null
  const filter = await redactFilter(input.filter, collection, access, counter)

  if (e.tool === 'aggregate') {
    const op = String(input.op ?? 'count')
    if (!['count', 'sum', 'avg', 'min', 'max'].includes(op)) return null
    const field = typeof input.field === 'string' ? input.field : null
    const groupBy = typeof input.group_by === 'string' ? input.group_by : null
    // The figure itself or its grouping on a hidden field: the read cannot be shown at all.
    if (op !== 'count' && (!field || !(await access.path(collection, [field])))) return null
    if (groupBy && !(await access.path(collection, [groupBy]))) return null
    const query: Record<string, unknown> = {}
    if (filter) query.filter = filter
    if (groupBy) query.groupBy = [groupBy]
    if (op === 'count') query.countAll = true
    else query[op] = [field]
    if (groupBy) {
      query.sort = [op === 'count' ? '-countAll' : `-${op}.${field}`]
      query.limit = 20
    }
    const params: Record<string, unknown> = {
      filter: filter ? JSON.stringify(filter) : undefined,
      groupBy: groupBy ?? undefined,
      countAll: op === 'count' ? 1 : undefined,
      [op]: op === 'count' ? undefined : field,
      sort: groupBy ? (query.sort as string[])[0] : undefined,
      limit: groupBy ? 20 : undefined
    }
    const url = `${api}/items/${collection}/aggregate${queryString(params)}`
    const what = op === 'count' ? 'Count' : `${op[0].toUpperCase()}${op.slice(1)} of ${field} in`
    return {
      tool: e.tool,
      title: `${what} ${collection}${groupBy ? ` by ${groupBy}` : ''}`,
      sdk: sdkSnippet(
        origin,
        'aggregateItems',
        `aggregateItems('${collection}', ${jsLiteral(query)})`
      ),
      rest: `GET ${url}`,
      curl: `curl ${auth} \\\n  ${shellQuote(url)}`,
      omitted: counter.omitted
    }
  }

  if (e.tool === 'query_items') {
    const fields = await keepFields(input.fields, collection, access, counter)
    const sort = await keepFields(input.sort, collection, access, counter, (f) =>
      f.replace(/^-/, '')
    )
    const limit = Math.min(200, Math.max(1, Number(input.limit) || 25))
    const search = typeof input.search === 'string' && input.search ? input.search : undefined
    const query: Record<string, unknown> = {}
    if (filter) query.filter = filter
    if (search) query.search = search
    if (sort.length) query.sort = sort
    if (fields.length) query.fields = fields
    query.limit = limit
    const params: Record<string, unknown> = {
      filter: filter ? JSON.stringify(filter) : undefined,
      search,
      sort: sort.length ? sort.join(',') : undefined,
      fields: fields.length ? fields.join(',') : undefined,
      limit
    }
    const url = `${api}/items/${collection}${queryString(params)}`
    return {
      tool: e.tool,
      title: `Read ${collection}${search ? ` matching “${search.slice(0, 40)}”` : ''}`,
      sdk: sdkSnippet(origin, 'readItems', `readItems('${collection}', ${jsLiteral(query)})`),
      rest: `GET ${url}`,
      curl: `curl ${auth} \\\n  ${shellQuote(url)}`,
      omitted: counter.omitted
    }
  }
  return null
}

/** The code for every read in an answer's trace, as `access` allows. */
export async function answerCode(
  trace: ChatTraceEntry[],
  origin: string,
  access: CodeAccess
): Promise<AnswerCode> {
  const snippets: AnswerSnippet[] = []
  let skipped = 0
  const seen = new Set<string>()
  for (const e of trace) {
    if (!e || !CODE_TOOLS.has(e.tool)) continue
    if (typeof e.summary === 'string' && e.summary.startsWith('error:')) continue
    const s = await snippetFor(e, origin.replace(/\/$/, ''), access)
    if (!s) {
      skipped++
      continue
    }
    // The model often repeats a read; the code needs it once.
    if (seen.has(s.sdk)) continue
    seen.add(s.sdk)
    snippets.push(s)
    if (snippets.length >= 10) break
  }
  return { snippets, skipped }
}
