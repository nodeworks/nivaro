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

// Hub gap watch (0.3.215): the move asks a source to carry its per-instance row (and its env mail)
// only on the way into maintenance, and reads back what it carried (names only).
describe('maintenance: carry for a move to shared', () => {
  it('sends target_instance / keep_env_mail with on=true only, and returns the answer', async () => {
    const bodies: unknown[] = []
    let answer: Record<string, unknown> = { on: true }
    const client = hubLinkClient('https://app.example.com', 't'.repeat(40), {
      fetch: (async (_url: string, init: { body?: string }) => {
        bodies.push(JSON.parse(String(init.body ?? '{}')))
        return new Response(JSON.stringify(answer), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }) as never
    })
    answer = {
      on: true,
      instance_row: { result: 'created', keys: ['huddle'], differed: [] },
      env_mail: 'kept'
    }
    expect(
      await client.maintenance(true, 5, undefined, { targetInstance: 'pool-a', keepEnvMail: true })
    ).toEqual({
      instance_row: { result: 'created', keys: ['huddle'], differed: [] },
      env_mail: 'kept'
    })
    answer = { on: true }
    expect(await client.maintenance(true, 5)).toEqual({ instance_row: null, env_mail: null })
    await client.maintenance(false, 5, undefined, { targetInstance: 'pool-a', keepEnvMail: true })
    expect(bodies).toEqual([
      { on: true, move_id: 5, target_instance: 'pool-a', keep_env_mail: true },
      { on: true, move_id: 5 },
      { on: false, move_id: 5 }
    ])
  })

  it('0.3.215: server_copied crosses (0 when absent or not a count)', async () => {
    expect(
      (await clientAnswering({ ...status, server_copied: 2 }).pullStatus('r')).server_copied
    ).toBe(2)
    expect((await clientAnswering(status).pullStatus('r')).server_copied).toBe(0)
    expect(
      (await clientAnswering({ ...status, server_copied: 'x' }).pullStatus('r')).server_copied
    ).toBe(0)
  })
})
