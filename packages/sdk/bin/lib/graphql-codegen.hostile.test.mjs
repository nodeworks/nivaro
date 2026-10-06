import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import ts from 'typescript'
import {
  analyzeSchema,
  commentText,
  generateGraphQLClient,
  sanitizeSchema,
  tsTypeName
} from './graphql-codegen.mjs'

// The introspection answer comes from a server: everything in it is untrusted.
// Every hostile string sets globalThis.__pwned if it ever reaches code.
const EVIL = 'a"}); globalThis.__pwned = 1; ({"'
const EVIL_Q = "a'); globalThis.__pwned = 1; ('"
const EVIL_DESC = '*/ globalThis.__pwned = 1; /* */ globalThis.__pwned = 2 /*'

const S = (name) => ({ kind: 'SCALAR', name, ofType: null })
const O = (name) => ({ kind: 'OBJECT', name, ofType: null })
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

const hostile = {
  queryType: { name: 'Query' },
  mutationType: { name: 'Mutation' },
  types: [
    { kind: 'SCALAR', name: 'ID' },
    { kind: 'SCALAR', name: 'String' },
    { kind: 'SCALAR', name: 'Int' },
    { kind: 'SCALAR', name: 'Boolean' },
    {
      kind: 'OBJECT',
      name: 'Query',
      fields: [
        f('posts', NN(L(NN(O('posts')))), [a('limit', S('Int')), a(EVIL, S('Int'))], {
          description: EVIL_DESC
        }),
        f('posts_by_id', O('posts'), [a('id', NN(S('ID')))]),
        // a collection whose name is the payload
        f(EVIL, NN(L(NN(O('posts')))), []),
        f(`${EVIL}_by_id`, O('posts'), [a('id', NN(S('ID')))]),
        // a collection whose ITEM TYPE name is the payload
        f('x', NN(L(NN(O(EVIL)))), []),
        f('x_by_id', O(EVIL), [a('id', NN(S('ID')))]),
        // a field whose required argument has a hostile type: dropped
        f('y', NN(L(NN(O('posts')))), [a('f', NN(S(EVIL_Q)))]),
        f('y_by_id', O('posts'), [a('id', NN(S('ID')))]),
        f('constructor', NN(L(NN(O('constructor')))), []),
        f('constructor_by_id', O('constructor'), [a('id', NN(S('ID')))])
      ]
    },
    {
      kind: 'OBJECT',
      name: 'Mutation',
      fields: [f('create_posts', O('posts'), [a('data', NN(S('JSON')))])]
    },
    {
      kind: 'OBJECT',
      name: 'posts',
      description: EVIL_DESC,
      fields: [
        f('id', NN(S('ID'))),
        f('title', S('String'), [], { description: EVIL_DESC }),
        f('old', S('String'), [], { isDeprecated: true, deprecationReason: EVIL_DESC }),
        f(EVIL, S('String')),
        f(EVIL_Q, S('String')),
        f('evil_ref', O(EVIL)),
        f('mood', { kind: 'ENUM', name: 'mood', ofType: null })
      ]
    },
    { kind: 'OBJECT', name: EVIL, fields: [f('id', NN(S('ID')))] },
    { kind: 'OBJECT', name: 'constructor', fields: [f('id', NN(S('ID')))] },
    {
      kind: 'ENUM',
      name: 'mood',
      enumValues: [{ name: 'happy' }, { name: EVIL }, { name: EVIL_Q }]
    },
    {
      kind: 'INPUT_OBJECT',
      name: EVIL_Q,
      inputFields: [a('x', S('String'))]
    },
    { kind: 'UNION', name: 'u', possibleTypes: [{ name: 'posts' }, { name: EVIL }] }
  ]
}

/** The file reprinted from its AST with every comment removed. */
function codeOnly(src) {
  const file = ts.createSourceFile('client.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  return ts.createPrinter({ removeComments: true }).printFile(file)
}

describe('graphql codegen against a hostile schema (#1282 review)', () => {
  it('drops every name that is not a plain identifier', () => {
    const clean = sanitizeSchema(hostile)
    const names = clean.types.map((t) => t.name)
    assert.ok(!names.includes(EVIL))
    assert.ok(!names.includes(EVIL_Q))
    const posts = clean.types.find((t) => t.name === 'posts')
    assert.deepEqual(
      posts.fields.map((x) => x.name),
      ['id', 'title', 'old', 'mood']
    )
    assert.deepEqual(
      clean.types.find((t) => t.name === 'mood').enumValues.map((v) => v.name),
      ['happy']
    )
    const q = clean.types.find((t) => t.name === 'Query')
    assert.deepEqual(
      q.fields.find((x) => x.name === 'posts').args.map((x) => x.name),
      ['limit']
    )
    assert.ok(!q.fields.some((x) => x.name === 'y'), 'required hostile arg drops the field')
    assert.deepEqual(
      analyzeSchema(hostile).collections.map((c) => c.name),
      ['constructor', 'posts']
    )
  })

  it('refuses to write an invalid type name', () => {
    assert.throws(() => tsTypeName(EVIL), /Refusing/)
  })

  it('keeps descriptions inside their comments', () => {
    const t = commentText(EVIL_DESC)
    assert.ok(!t.includes('*/'))
    assert.ok(!t.includes('/*'))
    assert.ok(!t.includes(' '))
  })

  it('writes no hostile text outside comments, type-checks, and runs inert', async () => {
    const src = generateGraphQLClient(hostile, { source: `https://x/*/ ${EVIL}` })
    assert.ok(src.includes('__pwned'), 'the payload is in the file — inside comments')
    assert.ok(!codeOnly(src).includes('__pwned'), 'no payload outside comments')

    const dir = mkdtempSync(join(tmpdir(), 'nivaro-gql-hostile-'))
    try {
      writeFileSync(join(dir, 'client.ts'), src)
      const program = ts.createProgram([join(dir, 'client.ts')], {
        strict: true,
        noEmit: true,
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ESNext,
        lib: ['lib.es2020.d.ts'],
        types: [],
        skipLibCheck: true
      })
      const errors = ts
        .getPreEmitDiagnostics(program)
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
      assert.deepEqual(errors, [])

      const js = ts.transpileModule(src, {
        compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }
      }).outputText
      writeFileSync(join(dir, 'client.mjs'), js)
      const mod = await import(join(dir, 'client.mjs'))
      const sent = []
      const cms = mod.createGraphQLClient({
        url: 'https://x',
        fetch: async (_url, init) => {
          sent.push(JSON.parse(init.body))
          return { ok: true, status: 200, text: async () => '{"data":{"posts":[]}}' }
        }
      })
      await cms.posts.list({ limit: 1 })
      assert.equal(globalThis.__pwned, undefined)
      assert.equal(sent[0].query, 'query($limit: Int) { posts(limit: $limit) { id title old mood } }')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
