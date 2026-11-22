import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  appBlockers,
  automaticHostname,
  blockersForEnv,
  CREATE_COPY,
  copyFor,
  createError,
  syncSummary
} from './create-api'

// Every refusal the creation, target and database routes (and the services behind them) can
// answer has plain-words copy here. The codes are read from the API sources, so a new code
// fails this test until it gets copy.

const API = join(import.meta.dirname, '../../../../../api/src')
const SOURCES = [
  'routes/hub-create.ts',
  'services/hub/create/plan.ts',
  'services/hub/create/run.ts',
  'services/hub/create/steps.ts',
  'services/hub/create/store.ts',
  'services/hub/create/targets.ts',
  'services/hub/create/gitlab-provision.ts',
  'services/hub/create/link-client.ts',
  'services/hub/create/app-config.ts',
  'services/hub/secrets.ts',
  'services/hub/gitlab-write.ts',
  'services/hub/db/databases.ts',
  'services/hub/db/connection.ts'
]

/** A code in a refusal position: fail/block/refused/bad(…, 'CODE'), new XError('CODE'), code: 'CODE'. */
const CODE_RE =
  /(?:\b(?:fail|block|refused|bad)\(\s*(?:reply,\s*\d+,\s*)?|(?:Error|Failure)\(\s*|\b(?:code|sync_error)\s*[:=]\s*\(?\s*)'([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)'/g

function answeredCodes(): Map<string, string> {
  const out = new Map<string, string>()
  for (const f of SOURCES) {
    const src = readFileSync(join(API, f), 'utf8')
    for (const m of src.matchAll(CODE_RE)) if (!out.has(m[1])) out.set(m[1], f)
  }
  return out
}

describe('creation refusal copy', () => {
  it('finds the codes in the API sources', () => {
    const codes = answeredCodes()
    // A broken pattern would pass the next test with nothing to check.
    for (const known of [
      'KEY_TAKEN',
      'NOT_WAITING_FOR_OPERATOR',
      'SECRET_REQUIRED',
      'HOST_NOT_SERVER'
    ])
      expect(codes.has(known)).toBe(true)
    expect(codes.size).toBeGreaterThan(60)
  })

  it('has plain words for every code the routes and services answer', () => {
    const missing = [...answeredCodes()]
      .filter(([code]) => !copyFor(code))
      .map(([code, file]) => `${code} (${file})`)
    expect(missing).toEqual([])
  })

  it('every copy entry has a title and no raw code in it', () => {
    for (const [code, c] of Object.entries(CREATE_COPY)) {
      expect(c.title.trim(), code).not.toBe('')
      expect(c.title, code).not.toMatch(/[A-Z]{2,}_[A-Z]/)
    }
  })

  it('a detail code keeps the server sentence as the hint', () => {
    const err = {
      response: {
        status: 400,
        data: { code: 'BAD_CONFIG', error: 'Config namespace must be a GitLab group or user path.' }
      }
    }
    const d = createError(err, 'Could not save the target')
    expect(d.title).toBe('A target setting is not valid')
    expect(d.hint).toBe('Config namespace must be a GitLab group or user path.')
  })

  it('NOT_WAITING_FOR_OPERATOR reads in plain words', () => {
    const d = createError(
      { response: { status: 409, data: { code: 'NOT_WAITING_FOR_OPERATOR', error: 'x' } } },
      'Could not record'
    )
    expect(d.title).toBe('This creation is not waiting for the deploy key')
  })
})

describe('blockers by environment', () => {
  const blockers = [
    { code: 'BAD_EMAIL', text: 'First name must be one line.' },
    { code: 'DATABASE_RECORDED', text: 'demo_production repeated.', env: 'production' },
    { code: 'BAD_ENV_KEY', text: '"Bad" is not a key.', env: 'environment 1' }
  ]
  it('matches by env label, never by code', () => {
    expect(blockersForEnv(blockers, 'Bad', 0).map((b) => b.text)).toEqual(['"Bad" is not a key.'])
    expect(blockersForEnv(blockers, 'production', 1).map((b) => b.text)).toEqual([
      'demo_production repeated.'
    ])
    expect(appBlockers(blockers, ['Bad', 'production']).map((b) => b.text)).toEqual([
      'First name must be one line.'
    ])
  })
})

describe('helpers', () => {
  it('automatic hostnames follow the server rule', () => {
    expect(automaticHostname('apps.example.com', 'demo', 'production')).toBe(
      'demo.apps.example.com'
    )
    expect(automaticHostname('apps.example.com', 'demo', 'staging')).toBe(
      'demo--staging.apps.example.com'
    )
    expect(automaticHostname(null, 'demo', 'staging')).toBeNull()
  })

  it('syncSummary names failures in words', () => {
    const s = syncSummary({ sync: [{ app_id: 1, ok: false, code: 'GITLAB_UNREACHABLE' }] })
    expect(s?.tone).toBe('warn')
    expect(s?.text).toContain('GitLab did not answer')
  })
})
