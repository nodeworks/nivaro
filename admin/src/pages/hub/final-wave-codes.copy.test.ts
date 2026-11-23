import { describe, expect, it, vi } from 'vitest'

// Final fix wave: the refusal and blocker codes FW-1 adds on the server have plain words here,
// so the copy guards (move-api place refusals, shared copy) stay green once both land. The page
// shows these titles and hints; the server's sentence only as the detail.

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }
}))

const { BLOCKER_COPY, hubError } = await import('./hub-api')
const { SHARED_COPY } = await import('./shared/shared-api')
const { UPGRADE_COPY } = await import('./shared/shared-upgrade-api')

const plain = (c: { title: string; hint?: string } | undefined, code: string) => {
  expect(c?.title, code).toBeTruthy()
  expect(c?.hint, code).toBeTruthy()
  expect(`${c?.title} ${c?.hint}`, code).not.toMatch(/\b[A-Z]{3,}_[A-Z_]+\b/)
}

describe('final wave codes have plain words', () => {
  it('place on a shared deployment, promote, stack and environment refusals', () => {
    for (const code of ['NAME_NOT_ROUTED', 'SERVING_UNKNOWN', 'MOVE_OPEN'])
      plain(BLOCKER_COPY[code], code)
    const d = hubError(
      {
        response: { status: 409, data: { code: 'MOVE_OPEN', error: 'The move of a/b (move 3)…' } }
      },
      'Could not promote'
    )
    expect(d.title).toBe(BLOCKER_COPY.MOVE_OPEN.title)
  })

  it('shared upgrade blockers and the extension list edit', () => {
    plain(UPGRADE_COPY.MOVE_OPEN, 'MOVE_OPEN')
    plain(UPGRADE_COPY.EXTENSION_MISSING, 'EXTENSION_MISSING')
    plain(SHARED_COPY.EXTENSION_IN_USE, 'EXTENSION_IN_USE')
  })
})

describe('hubError names the open move and the refused spec field', () => {
  it('MOVE_OPEN says which move, then where to follow it', () => {
    const d = hubError(
      {
        response: {
          status: 409,
          data: {
            code: 'MOVE_OPEN',
            error:
              'The move of shop/production (move 12) is interrupted: resume it or roll it back first.',
            move_id: 12
          }
        }
      },
      'Could not promote'
    )
    expect(d.title).toBe(BLOCKER_COPY.MOVE_OPEN.title)
    expect(d.hint).toMatch(/^The move of shop\/production \(move 12\) is interrupted/)
    expect(d.hint).toMatch(/Open Move… on that environment/)
  })

  it('SPEC_INVALID with ROLE_NEEDS_TRAEFIK_V3 says what to change, never the code', () => {
    const d = hubError(
      {
        response: {
          status: 400,
          data: {
            code: 'SPEC_INVALID',
            error: 'the agent refused the stack spec: roles.realtime (ROLE_NEEDS_TRAEFIK_V3)',
            fields: [{ field: 'roles.realtime', code: 'ROLE_NEEDS_TRAEFIK_V3' }]
          }
        }
      },
      'Could not apply the stack'
    )
    expect(d.title).toBe('The Hub agent refused the stack spec')
    expect(d.hint).toMatch(/Traefik v3/)
    expect(`${d.title} ${d.hint}`).not.toContain('ROLE_NEEDS_TRAEFIK_V3')
  })
})
