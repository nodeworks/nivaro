import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkWords, DB_CODE_COPY, type DbCheck, dbError, probeWords } from './db-api'

// Every code the Hub's database, server and connection routes can answer has plain copy here.

const API = join(import.meta.dirname, '../../../../../api/src')
const files = [
  join(API, 'routes/hub-create.ts'),
  join(API, 'services/hub/secrets.ts'),
  ...readdirSync(join(API, 'services/hub/db'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => join(API, 'services/hub/db', f))
]

const LIST = readFileSync(join(API, 'services/hub/db/codes.ts'), 'utf8')
const HUB_DB_CODES = [...LIST.matchAll(/^ {2}'([A-Z][A-Z_]+)',?$/gm)].map((m) => m[1] as string)

const IN_CALL =
  /(?:dbFail|fail|HubDbError|ProvisionError|failWith|failureCheck|HubSecretError)\(\s*(?:reply,\s*\d+,\s*)?'([A-Z][A-Z_]{3,})'/g
const CODE_KEY = /code: '([A-Z][A-Z_]{3,})'/g
const RETURNED = /return '(DATABASE_[A-Z_]+)'/g
const FAIL_WITH = /failWith\([^)]*?,\s*'([A-Z][A-Z_]{3,})'/g

function codesInSource(): Set<string> {
  const out = new Set<string>()
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    for (const re of [IN_CALL, CODE_KEY, RETURNED, FAIL_WITH])
      for (const m of src.matchAll(re)) out.add(m[1] as string)
  }
  return out
}

describe('refusal copy', () => {
  it('finds the codes the routes answer', () => {
    const codes = codesInSource()
    for (const c of [
      'HOST_NOT_SERVER',
      'TOO_MANY_TRIES',
      'HUB_ERROR',
      'SECRET_REQUIRED',
      'DROP_NOT_ALLOWED'
    ])
      expect(codes.has(c), c).toBe(true)
  })

  it('keeps every literal in the source inside HUB_DB_CODES', () => {
    expect([...codesInSource()].filter((c) => !HUB_DB_CODES.includes(c))).toEqual([])
  })

  it('has plain copy for every HUB_DB_CODES entry, and no stale copy', () => {
    expect(HUB_DB_CODES.length).toBeGreaterThan(40)
    expect(HUB_DB_CODES.filter((c) => !DB_CODE_COPY[c])).toEqual([])
    expect(Object.keys(DB_CODE_COPY).filter((c) => !HUB_DB_CODES.includes(c))).toEqual([])
  })

  it('has plain copy for every code, with no raw text', () => {
    const missing = [...codesInSource()].filter((c) => !DB_CODE_COPY[c])
    expect(missing).toEqual([])
    for (const [code, c] of Object.entries(DB_CODE_COPY)) {
      expect(c.title.length, code).toBeGreaterThan(3)
      expect(`${c.title} ${c.hint ?? ''}`.replace('ENCRYPTION_KEY', ''), code).not.toMatch(
        /\b[A-Z]{3,}_[A-Z_]+\b/
      )
    }
  })

  it('shows the copy through dbError, not the server text', () => {
    const d = dbError(
      { response: { status: 400, data: { code: 'HOST_NOT_SERVER', error: 'Only this' } } },
      'x'
    )
    expect(d.title).toBe("Use this database's own server")
  })

  it('NO_CONNECTION points at the Connection card and offers no Reload (P3-29)', () => {
    const d = dbError(
      { response: { status: 409, data: { code: 'NO_CONNECTION', error: 'x' } } },
      'Could not check the database'
    )
    expect(d.title).toBe('No connection is saved yet')
    expect(d.hint).toMatch(/Connection card/)
    expect(d.action).toBeUndefined()
  })

  it('gives owners a hint that names no server settings', () => {
    const err = { response: { status: 500, data: { code: 'CONNECTION_UNREADABLE' } } }
    expect(dbError(err, 'x').hint).toMatch(/ENCRYPTION_KEY/)
    const o = dbError(err, 'x', { owner: true })
    expect(o.hint).toMatch(/ask whoever runs the Hub/)
    expect(o.hint).not.toMatch(/ENCRYPTION_KEY/)
  })

  it('maps every check state and a recorded refusal to words', () => {
    for (const state of [
      'unreachable',
      'too_old',
      'no_rights',
      'empty',
      'nivaro',
      'foreign'
    ] as const) {
      const w = checkWords({
        state,
        ok: false,
        text: '',
        at: '',
        version: null,
        migrations: null,
        last_migration: null
      })
      expect(w.title).not.toBe('The check gave no clear answer')
    }
    const c: DbCheck = {
      state: 'error',
      code: 'DATABASE_IN_USE',
      ok: false,
      text: '',
      at: '',
      version: null,
      migrations: null,
      last_migration: null
    }
    expect(checkWords(c).title).toBe('Another Hub record uses this database')
  })

  it('says a probe that connects but cannot create in words', () => {
    const w = probeWords({
      ok: true,
      version: '16',
      can_create: false,
      missing: ['CREATE ROLE'],
      text: ''
    })
    expect(w.good).toBe(false)
    expect(w.title).toMatch(/cannot create/)
  })
})
