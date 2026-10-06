import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import ts from 'typescript'
import {
  accessFromPermissions,
  analyzeSchema,
  generateGraphQLClient,
  gqlTypeRef,
  tsTypeName
} from './graphql-codegen.mjs'

// ── a small introspection result in the shape the core produces ──────────────
const S = (name) => ({ kind: 'SCALAR', name, ofType: null })
const O = (name) => ({ kind: 'OBJECT', name, ofType: null })
const I = (name) => ({ kind: 'INPUT_OBJECT', name, ofType: null })
const E = (name) => ({ kind: 'ENUM', name, ofType: null })
const U = (name) => ({ kind: 'UNION', name, ofType: null })
const NN = (t) => ({ kind: 'NON_NULL', name: null, ofType: t })
const L = (t) => ({ kind: 'LIST', name: null, ofType: t })
const f = (name, type, args = [], extra = {}) => ({
  name,
  type,
  args,
  description: null,
  isDeprecated: false,
  deprecationReason: null,
  ...extra
})
const a = (name, type) => ({ name, type, defaultValue: null })

const listArgs = [
  a('filter', I('articles_filter')),
  a('search', S('String')),
  a('sort', L(NN(S('String')))),
  a('limit', S('Int')),
  a('offset', S('Int'))
]

export const fixture = {
  queryType: { name: 'Query' },
  mutationType: { name: 'Mutation' },
  types: [
    { kind: 'SCALAR', name: 'ID' },
    { kind: 'SCALAR', name: 'String' },
    { kind: 'SCALAR', name: 'Int' },
    { kind: 'SCALAR', name: 'Float' },
    { kind: 'SCALAR', name: 'Boolean' },
    { kind: 'SCALAR', name: 'JSON' },
    { kind: 'SCALAR', name: '__Ignored' },
    {
      kind: 'OBJECT',
      name: 'Query',
      fields: [
        f('articles', NN(L(NN(O('articles')))), listArgs, { description: 'List articles.' }),
        f('articles_by_id', O('articles'), [a('id', NN(S('ID')))]),
        f('articles_metadata', NN(O('articles_metadata')), listArgs),
        f('articles_aggregated', NN(L(NN(O('articles_aggregated')))), [
          a('filter', I('articles_filter')),
          a('groupBy', L(NN(S('String'))))
        ]),
        f('Promise', NN(L(NN(O('Promise')))), []),
        f('Promise_by_id', O('Promise'), [a('id', NN(S('ID')))]),
        f('settings', O('Settings'), [])
      ]
    },
    {
      kind: 'OBJECT',
      name: 'Mutation',
      fields: [
        f('create_articles', O('articles'), [a('data', NN(S('JSON')))]),
        f('create_articles_dry_run', S('JSON'), [a('data', NN(S('JSON')))]),
        f('update_articles_item', O('articles'), [a('id', NN(S('ID'))), a('data', NN(S('JSON')))]),
        f('delete_articles_item', O('DeleteResponse'), [a('id', NN(S('ID')))])
      ]
    },
    {
      kind: 'OBJECT',
      name: 'articles',
      fields: [
        f('id', NN(S('ID'))),
        f('title', S('String')),
        f('views', S('Int')),
        f('status', E('article_status')),
        f('meta', S('JSON')),
        f('old_slug', S('String'), [], { isDeprecated: true, deprecationReason: 'gone since 2026' }),
        f('author', O('authors')),
        f('tags', NN(L(NN(O('tags'))))),
        f('item', U('articles_item_union'))
      ]
    },
    { kind: 'OBJECT', name: 'authors', fields: [f('id', NN(S('ID'))), f('name', S('String'))] },
    { kind: 'OBJECT', name: 'tags', fields: [f('id', NN(S('ID'))), f('label', S('String'))] },
    { kind: 'OBJECT', name: 'Promise', fields: [f('id', NN(S('ID')))] },
    { kind: 'OBJECT', name: 'Settings', fields: [f('id', NN(S('ID')))] },
    {
      kind: 'OBJECT',
      name: 'articles_metadata',
      fields: [f('total', NN(S('Int'))), f('limit', NN(S('Int'))), f('offset', NN(S('Int')))]
    },
    {
      kind: 'OBJECT',
      name: 'articles_aggregated',
      fields: [
        f('group', S('JSON')),
        f('countAll', S('Int')),
        f('sum', O('articles_aggregated_fields'))
      ]
    },
    { kind: 'OBJECT', name: 'articles_aggregated_fields', fields: [f('views', S('Float'))] },
    { kind: 'OBJECT', name: 'DeleteResponse', fields: [f('id', NN(S('ID')))] },
    {
      kind: 'UNION',
      name: 'articles_item_union',
      possibleTypes: [{ name: 'authors' }, { name: 'tags' }]
    },
    {
      kind: 'ENUM',
      name: 'article_status',
      enumValues: [{ name: 'draft' }, { name: 'published' }]
    },
    {
      kind: 'INPUT_OBJECT',
      name: 'articles_filter',
      inputFields: [
        a('title', I('StringFilter')),
        a('_and', L(NN(I('articles_filter')))),
        a('_or', L(NN(I('articles_filter'))))
      ]
    },
    {
      kind: 'INPUT_OBJECT',
      name: 'StringFilter',
      inputFields: [a('_eq', S('String')), a('_in', L(NN(S('String'))))]
    }
  ]
}

/** Type-checks `files` together in a temp dir with a minimal, DOM-free config. */
function typecheck(files) {
  const dir = mkdtempSync(join(tmpdir(), 'nivaro-gql-'))
  try {
    const names = []
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(dir, name), text)
      names.push(join(dir, name))
    }
    const program = ts.createProgram(names, {
      strict: true,
      noEmit: true,
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ['lib.es2020.d.ts'],
      types: [],
      skipLibCheck: true
    })
    return ts
      .getPreEmitDiagnostics(program)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('graphql codegen (#1282)', () => {
  it('finds collections by their _by_id field and the operations the core gives them', () => {
    const { collections } = analyzeSchema(fixture)
    assert.deepEqual(
      collections.map((c) => c.name),
      ['articles', 'Promise']
    )
    assert.deepEqual(
      collections[1 - 1].ops.map((o) => o.method),
      ['list', 'byId', 'metadata', 'aggregated', 'create', 'update', 'delete']
    )
  })

  it("keeps only the helpers the caller's role allows", () => {
    assert.equal(accessFromPermissions({ is_admin: true, collections: [] }), null)
    const reader = accessFromPermissions({
      is_admin: false,
      collections: [{ collection: 'articles', actions: ['read', 'update'] }]
    })
    const { collections } = analyzeSchema(fixture, reader)
    assert.deepEqual(
      collections.map((c) => [c.name, c.ops.map((o) => o.method)]),
      [['articles', ['list', 'byId', 'metadata', 'aggregated', 'update']]]
    )
    const all = accessFromPermissions({
      is_admin: false,
      collections: [{ collection: '*', actions: ['read'] }]
    })
    assert.deepEqual(
      analyzeSchema(fixture, all).collections.map((c) => c.name),
      ['articles', 'Promise']
    )
    const src = generateGraphQLClient(fixture, { access: reader })
    assert.doesNotMatch(src, /create<S/)
    assert.doesNotMatch(src, / {4}Promise: \{/)
  })

  it('renames a type that would shadow a global or a helper', () => {
    assert.equal(tsTypeName('Promise'), 'Promise_')
    assert.equal(tsTypeName('Selection'), 'Selection_')
    assert.equal(tsTypeName('articles'), 'articles')
  })

  it('renders variable type references', () => {
    assert.equal(gqlTypeRef(NN(L(NN(S('String'))))), '[String!]!')
  })

  it('emits types, defaults and helpers', () => {
    const src = generateGraphQLClient(fixture, { source: 'fixture' })
    assert.match(src, /export interface articles \{/)
    assert.match(src, /export type article_status = "draft" \| "published"/)
    assert.match(src, /export interface Promise_ \{/)
    assert.match(src, /@deprecated gone since 2026/)
    assert.match(src, /articles: \{ id: true, title: true, views: true, status: true, meta: true, old_slug: true \}/)
    assert.match(src, /delete<S extends Selection<DeleteResponse> = \(typeof DEFAULT_SELECTIONS\)\["DeleteResponse"\]>\(id: string, select\?: S\)/)
    assert.match(src, /update<S extends Selection<articles>/)
    assert.doesNotMatch(src, /__Ignored/)
  })

  it('produces a file that type-checks standalone and types results from the selection', () => {
    const src = generateGraphQLClient(fixture)
    const usage = `
import { createGraphQLClient, type GqlFetch } from './client'
const fake: GqlFetch = async () => ({ ok: true, status: 200, text: async () => '{"data":{}}' })
const cms = createGraphQLClient({ url: 'https://x', token: 't', fetch: fake })
export async function demo() {
  const rows = await cms.articles.list({ limit: 5, filter: { title: { _eq: 'a' } } }, {
    id: true,
    author: { name: true },
    tags: { label: true },
    item: '... on authors { name }'
  })
  const id: string = rows[0].id
  const name: string | null | undefined = rows[0].author?.name
  const label: string | null = rows[0].tags[0].label
  // @ts-expect-error title was not selected
  rows[0].title
  const one = await cms.articles.byId('7')
  const views: number | null | undefined = one?.views
  const status: 'draft' | 'published' | null | undefined = one?.status
  const made = await cms.articles.create({ title: 'x', _change_reason: 'why' }, { id: true })
  const updated = await cms.articles.update('7', { views: 2 })
  const gone = await cms.articles.delete('7')
  const goneId: string | undefined = gone?.id
  const agg = await cms.articles.aggregated({ groupBy: ['status'] }, { countAll: true, sum: { views: true } })
  const total: number | null = agg[0].countAll
  const meta = await cms.articles.metadata()
  const n: number = meta.total
  const p = await cms.Promise.list()
  const pid: string = p[0].id
  const raw = await cms.graphql<{ settings: { id: string } }>('{ settings { id } }')
  // @ts-expect-error unknown collection
  cms.nothing
  return [id, name, label, views, status, made, updated, goneId, total, n, pid, raw]
}
`
    const errors = typecheck({ 'client.ts': src, 'usage.ts': usage })
    assert.deepEqual(errors, [])
  })

  it('builds the request from only the variables given and the selection', async () => {
    const src = generateGraphQLClient(fixture)
    // Run the generated client: strip its types with the compiler, then import it.
    const js = ts.transpileModule(src, {
      compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }
    }).outputText
    const dir = mkdtempSync(join(tmpdir(), 'nivaro-gql-run-'))
    try {
      writeFileSync(join(dir, 'client.mjs'), js)
      const mod = await import(join(dir, 'client.mjs'))
      const sent = []
      const cms = mod.createGraphQLClient({
        url: 'https://cms.example.com/',
        token: 'tok',
        fetch: async (url, init) => {
          sent.push({ url, init })
          return { ok: true, status: 200, text: async () => '{"data":{"articles":[{"id":"1"}]}}' }
        }
      })
      const rows = await cms.articles.list({ limit: 2 }, { id: true, author: { name: true } })
      assert.deepEqual(rows, [{ id: '1' }])
      assert.equal(sent[0].url, 'https://cms.example.com/api/graphql')
      assert.equal(sent[0].init.headers.authorization, 'Bearer tok')
      const body = JSON.parse(sent[0].init.body)
      assert.equal(body.query, 'query($limit: Int) { articles(limit: $limit) { id author { name } } }')
      assert.deepEqual(body.variables, { limit: 2 })

      const failing = mod.createGraphQLClient({
        url: 'https://x',
        fetch: async () => ({
          ok: true,
          status: 200,
          text: async () => '{"errors":[{"message":"Forbidden"}]}'
        })
      })
      await assert.rejects(failing.articles.byId('9'), (err) => {
        assert.equal(err.name, 'GraphQLRequestError')
        assert.equal(err.message, 'Forbidden')
        return true
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
