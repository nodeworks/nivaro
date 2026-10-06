#!/usr/bin/env node
/**
 * nivaro — the @nivaro/sdk command line.
 *
 *   nivaro types  [--url <api origin>] [--token <token>] [--out <file>] [--typed-client | --graphql]
 *   nivaro ext init <id> [--dir <extensions dir>]
 *
 * `types` writes TypeScript generated from the LIVE schema of a Nivaro
 * instance: one interface per collection + a `Collections` name map, or with
 * --typed-client the same file plus a thin typed wrapper over createNivaro().
 * Those two read admin-only dev-tools endpoints (an admin static token, or an
 * API key with the dev-tools scope).
 *
 * `types --graphql` introspects the GraphQL schema AS THE TOKEN'S USER and
 * writes a standalone typed GraphQL client: list / byId / create / update /
 * delete / aggregated / metadata per collection the user may see, with filter
 * and selection types, plus a graphql(doc, variables) escape hatch.
 *
 * `ext init` scaffolds an extension written against @nivaro/extension-kit.
 *
 * The URL and token also come from NIVARO_URL / NIVARO_TOKEN.
 *
 * Exit codes: 0 written · 1 usage · 2 request failed.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { defaultExtensionsDir, validateExtensionId, writeScaffold } from './lib/ext-scaffold.mjs'
import {
  accessFromPermissions,
  generateGraphQLClient,
  INTROSPECTION_QUERY
} from './lib/graphql-codegen.mjs'

const argv = process.argv.slice(2)
const cmd = argv[0]

function flag(name, short) {
  const i = argv.findIndex((a) => a === `--${name}` || (short && a === `-${short}`))
  if (i === -1) return undefined
  return argv[i + 1]
}
const has = (name) => argv.includes(`--${name}`)

function usage(code = 1) {
  process.stderr.write(
    [
      'Usage:',
      '  nivaro types [--url <api origin>] [--token <token>] [--out <file>] [--typed-client | --graphql]',
      '  nivaro ext init <id> [--dir <extensions dir>]',
      '',
      '  --url          API origin, e.g. https://cms.example.com (or NIVARO_URL)',
      '  --token        Static token or API key (or NIVARO_TOKEN); admin / dev-tools scope',
      '                 for the REST types, any user for --graphql',
      '  --out          File to write; stdout when omitted',
      '  --typed-client Emit the typed createTypedNivaro() wrapper too',
      "  --graphql      Emit a typed GraphQL client for the token's user",
      '  --dir          Where `ext init` creates <id>/ (default api/extensions)',
      ''
    ].join('\n')
  )
  process.exit(code)
}

function fail(msg, code) {
  process.stderr.write(`${msg}\n`)
  process.exit(code)
}

if (!cmd || cmd === '--help' || cmd === '-h') usage(cmd ? 0 : 1)

if (cmd === 'ext') {
  const sub = argv[1]
  const id = argv[2]
  if (sub !== 'init') {
    process.stderr.write(sub ? `Unknown ext command "${sub}"\n\n` : '')
    usage(1)
  }
  const bad = validateExtensionId(id)
  if (bad) fail(bad, 1)
  if (has('dir') && (!flag('dir') || flag('dir').startsWith('--')))
    fail('--dir needs a directory path', 1)
  const dir = has('dir') ? resolve(flag('dir')) : defaultExtensionsDir()
  let result
  try {
    result = writeScaffold(id, dir)
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err), 1)
  }
  const rel = (p) => relative(process.cwd(), p) || '.'
  process.stderr.write(
    [
      `Created ${rel(result.target)}/`,
      ...result.written.map((f) => `  ${rel(f)}`),
      result.hasTsconfig
        ? ''
        : `\nNo tsconfig.json in ${rel(dir)} — type-check it from a project that includes the folder (api/extensions/tsconfig.json does).`,
      'Next: restart the API so the loader picks it up, then run its test:',
      `  (cd api && npx vitest run extensions/${id})`,
      ''
    ]
      .filter((l) => l !== '')
      .join('\n') + '\n'
  )
  process.exit(0)
}

if (cmd !== 'types') {
  process.stderr.write(`Unknown command "${cmd}"\n\n`)
  usage(1)
}

const url = (flag('url', 'u') ?? process.env.NIVARO_URL ?? '').replace(/\/+$/, '')
const token = flag('token', 't') ?? process.env.NIVARO_TOKEN ?? ''
const out = flag('out', 'o')
if (!url) {
  process.stderr.write('Missing --url (or NIVARO_URL)\n')
  usage(1)
}
if (!token) {
  process.stderr.write('Missing --token (or NIVARO_TOKEN)\n')
  usage(1)
}
if (has('graphql') && has('typed-client')) {
  process.stderr.write('--graphql and --typed-client are separate outputs — pick one\n')
  usage(1)
}

function write(text, summary) {
  if (out) {
    const file = resolve(out)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text, 'utf8')
    process.stderr.write(`Wrote ${file} — ${summary}\n`)
  } else {
    process.stdout.write(text)
  }
}

async function request(path, init) {
  try {
    return await fetch(`${url}${path}`, init)
  } catch (err) {
    fail(`Request failed: ${err instanceof Error ? err.message : String(err)}`, 2)
  }
}

if (has('graphql')) {
  // The schema is the same for everyone and introspection needs no sign-in, so
  // the token is checked here: a refused token fails the command, and the
  // caller's role decides which helpers are written.
  const permsRes = await request('/api/security/my/permissions', {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' }
  })
  const permsText = await permsRes.text()
  let access = null
  if (permsRes.status === 401 || permsRes.status === 403) {
    let msg = permsText
    try {
      msg = JSON.parse(permsText)?.error ?? permsText
    } catch {
      /* plain body */
    }
    fail(`Token refused (HTTP ${permsRes.status}): ${String(msg).slice(0, 300)}`, 2)
  } else if (permsRes.ok) {
    try {
      access = accessFromPermissions(JSON.parse(permsText)?.data ?? null)
    } catch {
      access = null
    }
  } else {
    process.stderr.write(
      `Could not read the token's permissions (HTTP ${permsRes.status}) — writing helpers for every collection\n`
    )
  }
  const res = await request('/api/graphql', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json'
    },
    body: JSON.stringify({ query: INTROSPECTION_QUERY, operationName: 'NivaroIntrospection' })
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  if (json?.errors?.length) fail(`GraphQL error: ${String(json.errors[0].message).slice(0, 300)}`, 2)
  if (!res.ok || !json?.data?.__schema)
    fail(`HTTP ${res.status}: ${String(json?.error ?? text).slice(0, 300)}`, 2)
  const src = generateGraphQLClient(json.data.__schema, { source: url, access })
  const collections = (src.match(/^ {4}[A-Za-z_$][\w$]*: \{$/gm) ?? []).length
  write(src, `${collections} collection(s)`)
  process.exit(0)
}

const path = has('typed-client') ? '/api/dev-tools/typed-client.ts' : '/api/dev-tools/types.ts'
const res = await request(path, {
  headers: { authorization: `Bearer ${token}`, accept: 'text/plain' }
})
const text = await res.text()
if (!res.ok) {
  let msg = text
  try {
    msg = JSON.parse(text)?.error ?? text
  } catch {
    /* plain body */
  }
  fail(`HTTP ${res.status}: ${String(msg).slice(0, 300)}`, 2)
}
write(text, `${(text.match(/^export interface /gm) ?? []).length} interface(s)`)
