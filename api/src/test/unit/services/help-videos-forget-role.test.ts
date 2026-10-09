import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// M2: deleting a role used by help videos failed on the requirement rows'
// foreign key, and a visibility list emptied by it would have opened the
// video to everyone. The role is now forgotten first, and an emptied list
// stays limited (authors and admins only).

const ROLE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

type Row = Record<string, unknown>
const t = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  log: [] as string[]
}))

vi.mock('../../../db/index.js', () => {
  const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase()
  // SQL Server compares a string with a uniqueidentifier after parsing it: braces
  // are accepted, case is ignored and anything past 36 characters is dropped.
  const sameUuid = (a: unknown, b: unknown) =>
    String(a).toLowerCase() === String(b).replace(/^\{/, '').slice(0, 36).toLowerCase()
  const db = (table: string) => {
    if (!t.tables[table]) t.tables[table] = []
    const rows = t.tables[table]
    const tests: Array<(r: Row) => boolean> = []
    const sel = () => rows.filter((r) => tests.every((f) => f(r)))
    const q: Record<string, unknown> = {
      where(c: Row | string, op?: unknown, v?: unknown) {
        if (typeof c === 'string') {
          const needle = String(v).replace(/%/g, '').toLowerCase()
          tests.push(
            (r) =>
              op === 'like' &&
              String(r[c] ?? '')
                .toLowerCase()
                .includes(needle)
          )
        } else
          for (const [k, val] of Object.entries(c))
            tests.push((r) =>
              table === 'nivaro_roles' && k === 'id' ? sameUuid(r[k], val) : same(r[k], val)
            )
        return q
      },
      first: async () => sel()[0],
      select: async () => sel(),
      count: () => q,
      update: async (patch: Row) => {
        t.log.push(`update ${table}`)
        for (const r of sel()) Object.assign(r, patch)
        return sel().length
      },
      delete: async () => {
        t.log.push(`delete ${table}`)
        const hit = new Set(sel())
        t.tables[table] = rows.filter((r) => !hit.has(r))
        return hit.size
      }
    }
    return q
  }
  return { db }
})
vi.mock('../../../services/help-video-render.js', () => ({ queueRender: vi.fn() }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn() }))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async () => {},
  requireAdmin: async () => {}
}))

import { rolesRoutes } from '../../../routes/roles.js'
import { forgetHelpVideoRole, parseVisibility } from '../../../services/help-videos.js'

beforeEach(() => {
  t.log = []
  t.tables = {
    nivaro_roles: [{ id: ROLE }, { id: OTHER }],
    nivaro_users: [],
    nivaro_policies: [],
    nivaro_help_video_requirements: [
      { video_id: 'V1', role_id: ROLE },
      { video_id: 'V1', role_id: OTHER }
    ],
    nivaro_settings: [
      { id: 1, help_video_author_roles: JSON.stringify([ROLE.toUpperCase(), OTHER]) }
    ],
    nivaro_help_videos: [
      { id: 'V1', visibility: JSON.stringify({ mode: 'roles', role_ids: [ROLE.toUpperCase()] }) },
      {
        id: 'V2',
        visibility: JSON.stringify({ mode: 'roles', role_ids: [ROLE.toUpperCase(), OTHER] })
      },
      { id: 'V3', visibility: JSON.stringify({ mode: 'everyone', role_ids: [] }) }
    ]
  }
})

const vis = (id: string) =>
  parseVisibility(t.tables.nivaro_help_videos.find((v) => v.id === id)?.visibility)

describe('forgetHelpVideoRole', () => {
  it('drops its requirements, its author-role entry and its visibility entries', async () => {
    await forgetHelpVideoRole(ROLE)
    expect(t.tables.nivaro_help_video_requirements).toEqual([{ video_id: 'V1', role_id: OTHER }])
    expect(JSON.parse(String(t.tables.nivaro_settings[0].help_video_author_roles))).toEqual([
      OTHER.toUpperCase()
    ])
    expect(vis('V2')).toEqual({ mode: 'roles', role_ids: [OTHER.toUpperCase()] })
    expect(vis('V3')).toEqual({ mode: 'everyone', role_ids: [] })
  })

  it('a visibility list it empties stays limited: never everyone', async () => {
    await forgetHelpVideoRole(ROLE)
    expect(vis('V1')).toEqual({ mode: 'roles', role_ids: [] })
  })

  it('the last author role going leaves no author roles (admins still author)', async () => {
    t.tables.nivaro_settings[0].help_video_author_roles = JSON.stringify([ROLE])
    await forgetHelpVideoRole(ROLE)
    expect(t.tables.nivaro_settings[0].help_video_author_roles).toBeNull()
  })

  it('ignores an id that names no role', async () => {
    await forgetHelpVideoRole('not-a-role')
    await forgetHelpVideoRole('cccccccc-cccc-4ccc-8ccc-cccccccccccc')
    expect(t.log).toEqual([])
  })

  // The database accepts these for the role delete, so the cleanup must follow
  // the role row's own id or the delete still fails on the requirement rows.
  for (const [label, spelled] of [
    ['braces', `{${ROLE}}`],
    ['upper case', ROLE.toUpperCase()],
    ['trailing characters', `${ROLE}xyz`]
  ] as const) {
    it(`forgets the role when it is named with ${label}`, async () => {
      await forgetHelpVideoRole(spelled)
      expect(t.tables.nivaro_help_video_requirements).toEqual([{ video_id: 'V1', role_id: OTHER }])
      expect(vis('V1')).toEqual({ mode: 'roles', role_ids: [] })
      expect(vis('V2')).toEqual({ mode: 'roles', role_ids: [OTHER.toUpperCase()] })
    })
  }
})

describe('DELETE /roles/:id', () => {
  it('a braced role id still clears the requirement rows before the role goes', async () => {
    const a = Fastify()
    await a.register(rolesRoutes, { prefix: '/api/roles' })
    const res = await a.inject({
      method: 'DELETE',
      url: `/api/roles/${encodeURIComponent(`{${ROLE}}`)}`
    })
    expect(res.statusCode).toBe(204)
    expect(t.tables.nivaro_help_video_requirements).toEqual([{ video_id: 'V1', role_id: OTHER }])
    expect(t.tables.nivaro_roles).toEqual([{ id: OTHER }])
  })

  it('forgets the role in help videos before deleting it', async () => {
    const a = Fastify()
    await a.register(rolesRoutes, { prefix: '/api/roles' })
    const res = await a.inject({ method: 'DELETE', url: `/api/roles/${ROLE}` })
    expect(res.statusCode).toBe(204)
    expect(t.log.indexOf('delete nivaro_help_video_requirements')).toBeGreaterThanOrEqual(0)
    expect(t.log.indexOf('delete nivaro_help_video_requirements')).toBeLessThan(
      t.log.indexOf('delete nivaro_roles')
    )
    expect(t.tables.nivaro_roles).toEqual([{ id: OTHER }])
    expect(vis('V1')).toEqual({ mode: 'roles', role_ids: [] })
  })
})
