#!/usr/bin/env node
/**
 * nivaro — the @nivaro/sdk command line.
 *
 *   nivaro types  [--url <api origin>] [--token <static token>] [--out <file>] [--typed-client]
 *
 * Writes TypeScript definitions generated from the LIVE schema of a Nivaro
 * instance (one interface per collection + a `Collections` name map), or with
 * --typed-client the same file plus a thin typed wrapper over createNivaro().
 *
 * The URL and token also come from NIVARO_URL / NIVARO_TOKEN. An admin static
 * token (or an API key with the dev-tools scope) is required — the endpoint
 * is admin-only because it enumerates every collection and column.
 *
 * Exit codes: 0 written · 1 usage · 2 request failed.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

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
      'Usage: nivaro types [--url <api origin>] [--token <token>] [--out <file>] [--typed-client]',
      '',
      '  --url          API origin, e.g. https://cms.example.com (or NIVARO_URL)',
      '  --token        Admin static token or dev-tools API key (or NIVARO_TOKEN)',
      '  --out          File to write; stdout when omitted',
      '  --typed-client Emit the typed createTypedNivaro() wrapper too',
      ''
    ].join('\n')
  )
  process.exit(code)
}

if (!cmd || cmd === '--help' || cmd === '-h') usage(cmd ? 0 : 1)
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

const path = has('typed-client') ? '/api/dev-tools/typed-client.ts' : '/api/dev-tools/types.ts'
let res
try {
  res = await fetch(`${url}${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'text/plain' }
  })
} catch (err) {
  process.stderr.write(`Request failed: ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(2)
}
const text = await res.text()
if (!res.ok) {
  let msg = text
  try {
    msg = JSON.parse(text)?.error ?? text
  } catch {
    /* plain body */
  }
  process.stderr.write(`HTTP ${res.status}: ${String(msg).slice(0, 300)}\n`)
  process.exit(2)
}

if (out) {
  const file = resolve(out)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text, 'utf8')
  const interfaces = (text.match(/^export interface /gm) ?? []).length
  process.stderr.write(`Wrote ${file} — ${interfaces} interface(s)\n`)
} else {
  process.stdout.write(text)
}
