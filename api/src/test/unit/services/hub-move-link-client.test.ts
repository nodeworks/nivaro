import { describe, expect, it } from 'vitest'
import { hubLinkClient } from '../../../services/hub/move/link-client.js'

// R2-M-9 (final wave): the move's hub-link client reads the shared-readiness report with the one
// parser the plan uses (parseReadiness): a malformed report is never read as "idle, no files".

const report = (over: Record<string, unknown> = {}) => ({
  codes: [{ code: 'DIRECTORY_SYNC', level: 'warning', detail: 'Directory sync is on' }],
  key_fp: 'a'.repeat(32),
  oidc: null,
  signin_hub: false,
  db_identity: 'pg|db|5432|app',
  busy: { imports: 1, exports: 0, renders: 2 },
  files: { count: 3, bytes: 30, local: 3, objects: { s3: 1 } },
  version: '0.3.210',
  extensions: {},
  ...over
})

function clientAnswering(body: unknown) {
  return hubLinkClient('https://app.example.com', 't'.repeat(40), {
    fetch: (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })) as never
  })
}

describe('move hub-link client: shared readiness (R2-M-9)', () => {
  it('a well-formed report is read', async () => {
    const r = await clientAnswering(report()).sharedReadiness()
    expect(r.busy).toEqual({ imports: 1, exports: 0, renders: 2 })
    expect(r.files).toMatchObject({ count: 3, bytes: 30, local: 3 })
    expect(r.db_identity).toBe('pg|db|5432|app')
    expect(r.version).toBe('0.3.210')
  })

  it('a busy count that is missing is never read as 0 (idle): LINK_BAD_ANSWER', async () => {
    const err = await clientAnswering(report({ busy: { exports: 0, renders: 0 } }))
      .sharedReadiness()
      .catch((e) => e)
    expect(err?.code).toBe('LINK_BAD_ANSWER')
  })

  it('an unknown blocker code fails closed, as the plan reads it', async () => {
    const err = await clientAnswering(
      report({ codes: [{ code: 'SOMETHING_NEW', level: 'blocker', detail: 'x' }] })
    )
      .sharedReadiness()
      .catch((e) => e)
    expect(err?.code).toBe('LINK_BAD_ANSWER')
  })
})

// Hub gap watch (0.3.215): the move asks a source to keep its env mail settings only on the way
// into maintenance, and only when told to.
describe('maintenance: keep_env_mail', () => {
  it('sends keep_env_mail with on=true when asked, never otherwise', async () => {
    const bodies: unknown[] = []
    const client = hubLinkClient('https://app.example.com', 't'.repeat(40), {
      fetch: (async (_url: string, init: { body?: string }) => {
        bodies.push(JSON.parse(String(init.body ?? '{}')))
        return new Response(JSON.stringify({ on: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }) as never
    })
    await client.maintenance(true, 5, undefined, { keepEnvMail: true })
    await client.maintenance(true, 5)
    await client.maintenance(false, 5, undefined, { keepEnvMail: true })
    expect(bodies).toEqual([
      { on: true, move_id: 5, keep_env_mail: true },
      { on: true, move_id: 5 },
      { on: false, move_id: 5 }
    ])
  })
})

// Hub phase 6 untested path 1: the failed rows' plain reasons cross both links (only known
// reasons, only whole counts), so the move can say why a file was not copied.
describe('pull status: failed rows per reason', () => {
  const status = {
    state: 'done',
    total: 4,
    copied: 1,
    skipped: 0,
    failed: 3,
    missing: [],
    bytes: 10,
    error: null,
    failed_ids: ['a', 'b', 'c'],
    failed_reasons: {
      source_read_failed: 2,
      write_failed: 1,
      bad_answer: 0,
      made_up: 9,
      incomplete: '4',
      unreachable: 1.5
    }
  }

  it('hub link: known reasons with whole counts only', async () => {
    const s = await clientAnswering(status).pullStatus('run-1')
    expect(s.failed_reasons).toEqual({ source_read_failed: 2, write_failed: 1 })
  })

  it('an older app without the field reads as no reasons', async () => {
    const { failed_reasons: _r, ...older } = status
    expect((await clientAnswering(older).pullStatus('run-1')).failed_reasons).toEqual({})
  })
})
