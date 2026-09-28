/**
 * "Copy as …" (#654): the request a list or record view is making, rendered
 * as a curl command, an SDK call and a GraphQL document. Pure — no client,
 * no DOM — so the three renderings can be judged against each other.
 *
 * The token is never the real one: every rendering names `NIVARO_TOKEN`.
 */

export interface ListRequest {
  /** The browser's `conditions` JSON (an array of {path, op, value} and
   *  `{or: [...]}` groups), already serialised. */
  conditions?: string
  search?: string
  /** Comma-joined sort, `-` prefix = descending. */
  sort?: string
  limit?: number
  page?: number
}

export interface CopyAsInput {
  /** The host the API is served from, no trailing slash. */
  origin: string
  collection: string
  /** A record id renders the single-record forms. */
  itemId?: string | null
  list?: ListRequest
  /** Plain or dotted field keys the GraphQL selection lists (`id` is always
   *  first; a key that starts with `__` is a synthetic column and skipped). */
  fields?: string[]
}

export interface CopyAsSnippets {
  curl: string
  sdk: string
  graphql: string
}

type Cond = { path: string[]; op: string; value: unknown }
type CondNode = Cond | { or: CondNode[] }

/** The browser's conditions as the filter object the SDK and GraphQL take:
 *  a dotted path folds into nested objects, an `or` group into `_or`, and
 *  several conditions AND together. */
export function conditionsToFilter(conditions: string | undefined): Record<string, unknown> | null {
  if (!conditions) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(conditions)
  } catch {
    return null
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null
  const one = (node: CondNode): Record<string, unknown> | null => {
    if ('or' in node && Array.isArray(node.or)) {
      const branches = node.or.map(one).filter((b): b is Record<string, unknown> => !!b)
      return branches.length > 0 ? { _or: branches } : null
    }
    const c = node as Cond
    if (!Array.isArray(c.path) || c.path.length === 0 || typeof c.op !== 'string') return null
    let leaf: Record<string, unknown> = { [c.op]: c.value }
    for (let i = c.path.length - 1; i >= 0; i--) leaf = { [c.path[i]]: leaf }
    return leaf
  }
  const parts = (parsed as CondNode[]).map(one).filter((p): p is Record<string, unknown> => !!p)
  if (parts.length === 0) return null
  return parts.length === 1 ? parts[0] : { _and: parts }
}

/** GraphQL spells the virtual filter keys without the dollar sign. */
function graphqlKey(key: string): string {
  return key.startsWith('$') ? `_${key.slice(1)}` : key
}

/** A JSON value as a GraphQL input literal: keys bare, strings quoted. */
export function graphqlLiteral(value: unknown, indent = 0): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'string') return JSON.stringify(value)
  const pad = '  '.repeat(indent + 1)
  const end = '  '.repeat(indent)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return `[${value.map((v) => graphqlLiteral(v, indent)).join(', ')}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return '{}'
  return `{\n${entries
    .map(([k, v]) => `${pad}${graphqlKey(k)}: ${graphqlLiteral(v, indent + 1)}`)
    .join('\n')}\n${end}}`
}

/** Field keys as a GraphQL selection: `project.name` → `project { name }`,
 *  siblings under one parent merged. */
export function graphqlSelection(fields: string[] | undefined, indent = 1): string {
  const tree: Record<string, Record<string, unknown>> = {}
  const keys = ['id', ...(fields ?? []).filter((f) => f && !f.startsWith('__') && f !== 'id')]
  for (const key of keys) {
    let node = tree
    for (const seg of key.split('.')) {
      node[seg] ??= {}
      node = node[seg] as Record<string, Record<string, unknown>>
    }
  }
  const render = (node: Record<string, unknown>, depth: number): string =>
    Object.entries(node)
      .map(([k, sub]) => {
        const inner = sub as Record<string, unknown>
        const p = '  '.repeat(depth)
        return Object.keys(inner).length === 0
          ? `${p}${k}`
          : `${p}${k} {\n${render(inner, depth + 1)}\n${p}}`
      })
      .join('\n')
  return render(tree, indent)
}

const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`
/** Where the document goes and how it authenticates — a GraphQL document
 *  cannot carry either itself. */
const gqlHeader = (origin: string) =>
  `# POST ${origin}/api/graphql\n# Authorization: Bearer $NIVARO_TOKEN\n`

export function buildCopyAs(input: CopyAsInput): CopyAsSnippets {
  const { origin, collection } = input
  const base = `${origin}/api/items/${collection}`
  const auth = `-H "Authorization: Bearer $NIVARO_TOKEN"`

  if (input.itemId) {
    const id = String(input.itemId)
    return {
      curl: `curl "${base}/${encodeURIComponent(id)}" \\\n  ${auth}`,
      sdk: [
        `import { createNivaro, readItem } from '@nivaro/sdk'`,
        '',
        `const nivaro = createNivaro('${origin}', { token: process.env.NIVARO_TOKEN })`,
        `const { data } = await nivaro.request(readItem('${collection}', ${JSON.stringify(id)}))`
      ].join('\n'),
      graphql: `${gqlHeader(origin)}query {\n  ${collection}_by_id(id: ${JSON.stringify(id)}) {\n${graphqlSelection(input.fields, 2)}\n  }\n}`
    }
  }

  const list = input.list ?? {}
  const filter = conditionsToFilter(list.conditions)
  const sort = list.sort ? list.sort.split(',').filter(Boolean) : []
  const limit = list.limit ?? 25
  const page = list.page ?? 1

  const curlParams: string[] = [`limit=${limit}`, `page=${page}`]
  if (list.sort) curlParams.push(`sort=${list.sort}`)
  if (list.search) curlParams.push(`search=${list.search}`)
  if (list.conditions) curlParams.push(`conditions=${list.conditions}`)
  const curl = [
    `curl -G "${base}"`,
    `  ${auth}`,
    ...curlParams.map((p) => `  --data-urlencode ${sh(p)}`)
  ].join(' \\\n')

  const query: Record<string, unknown> = {}
  if (filter) query.filter = filter
  if (list.search) query.search = list.search
  if (sort.length) query.sort = sort
  query.limit = limit
  if (page > 1) query.page = page
  const sdk = [
    `import { createNivaro, readItems } from '@nivaro/sdk'`,
    '',
    `const nivaro = createNivaro('${origin}', { token: process.env.NIVARO_TOKEN })`,
    `const { data, total } = await nivaro.request(`,
    `  readItems('${collection}', ${JSON.stringify(query, null, 2).replace(/\n/g, '\n  ')})`,
    `)`
  ].join('\n')

  const args: string[] = []
  if (filter) args.push(`filter: ${graphqlLiteral(filter, 1)}`)
  if (list.search) args.push(`search: ${JSON.stringify(list.search)}`)
  if (sort.length) args.push(`sort: ${graphqlLiteral(sort)}`)
  args.push(`limit: ${limit}`)
  if (page > 1) args.push(`offset: ${(page - 1) * limit}`)
  const argText = args.length ? `(${args.join(', ')})` : ''
  const graphql = [
    gqlHeader(origin).trimEnd(),
    'query {',
    `  ${collection}${argText} {`,
    graphqlSelection(input.fields, 2),
    '  }',
    `  ${collection}_metadata${argText} {`,
    '    total',
    '  }',
    '}'
  ].join('\n')

  return { curl, sdk, graphql }
}
