import { beforeEach, describe, expect, it, vi } from 'vitest'

// A knex-shaped fake over three tables: the chain records where()/whereRaw()
// arguments and `first()` answers the first row whose columns match them.
type Row = Record<string, unknown>
const tables: Record<string, Row[]> = {}

function fakeTable(name: string) {
  const conds: Array<(r: Row) => boolean> = []
  const rows = () => (tables[name] ?? []).filter((r) => conds.every((c) => c(r)))
  const chain = {
    select: () => chain,
    orderBy: () => chain,
    where: (arg: Row) => {
      conds.push((r) => Object.entries(arg).every(([k, v]) => r[k] === v))
      return chain
    },
    whereRaw: (_sql: string, binds: unknown[]) => {
      conds.push((r) => String(r.email ?? '').toLowerCase() === String(binds[0]))
      return chain
    },
    first: async () => {
      if (name === '__throw__') throw new Error('boom')
      return rows()[0]
    },
    // biome-ignore lint/suspicious/noThenProperty: a knex-shaped fake must be awaitable
    then: (res: (v: Row[]) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(rows()).then(res, rej)
  }
  return chain
}

vi.mock('../../../db/index.js', () => ({
  db: vi.fn((name: string) => fakeTable(name))
}))

import {
  applySenderName,
  bustMailBrandingCache,
  normalizeMailColor,
  normalizeMailLogo,
  resolveMailBranding,
  runWithMailBranding
} from '../../../services/mail-branding.js'

const WS_A = 'AAAAAAAA-0000-4000-8000-000000000001'
const WS_B = 'BBBBBBBB-0000-4000-8000-000000000002'

beforeEach(() => {
  bustMailBrandingCache()
  for (const k of Object.keys(tables)) delete tables[k]
  tables.nivaro_settings = [
    { id: 1, project_name: 'Instance Co', project_color: '#123456', brand_logo: 'file-id' }
  ]
  tables.nivaro_workspaces = [
    {
      id: WS_A,
      mail_logo: 'https://cdn.example.com/a.png',
      mail_color: '#ff0000',
      mail_sender_name: 'Workspace A',
      mail_footer: 'A footer'
    },
    // only a colour: every other field falls back to the instance
    { id: WS_B, mail_logo: null, mail_color: '#00ff00', mail_sender_name: null, mail_footer: null }
  ]
  tables.nivaro_collections = [
    { collection: 'orders', workspace: WS_A },
    { collection: 'notes', workspace: null }
  ]
  tables.nivaro_users = [
    { id: 'U1', email: 'b@example.com', current_workspace: WS_B },
    { id: 'U2', email: 'nobody@example.com', current_workspace: null }
  ]
})

describe('resolveMailBranding — fallback order (#1463)', () => {
  it('nothing named → the instance branding (a file-id logo never becomes a broken image)', async () => {
    expect(await resolveMailBranding({})).toEqual({
      logo: null,
      color: '#123456',
      sender_name: 'Instance Co',
      from_name: null,
      footer: null,
      workspace_id: null
    })
  })

  it('an explicit workspace id wins over the record and the recipient', async () => {
    const b = await resolveMailBranding({
      workspaceId: WS_B,
      recordCollection: 'orders',
      recordId: 7,
      recipientUserId: 'U1'
    })
    expect(b.workspace_id).toBe(WS_B)
    expect(b.color).toBe('#00ff00')
    // per-field fallback: B sets only a colour
    expect(b.logo).toBeNull()
    expect(b.sender_name).toBe('Instance Co')
    expect(b.from_name).toBeNull()
  })

  it("the record's collection decides before the recipient", async () => {
    const b = await resolveMailBranding({
      recordCollection: 'orders',
      recordId: 7,
      recipientUserId: 'U1'
    })
    expect(b.workspace_id).toBe(WS_A)
    expect(b).toMatchObject({
      logo: 'https://cdn.example.com/a.png',
      color: '#ff0000',
      sender_name: 'Workspace A',
      from_name: 'Workspace A',
      footer: 'A footer'
    })
  })

  it("a collection with no workspace falls through to the recipient's current workspace", async () => {
    const byId = await resolveMailBranding({ recordCollection: 'notes', recipientUserId: 'U1' })
    expect(byId.workspace_id).toBe(WS_B)
    const byEmail = await resolveMailBranding({ recipientEmail: 'B@Example.com' })
    expect(byEmail.workspace_id).toBe(WS_B)
    const none = await resolveMailBranding({ recipientUserId: 'U2' })
    expect(none.workspace_id).toBeNull()
    expect(none.sender_name).toBe('Instance Co')
  })

  it('a system collection never routes through nivaro_collections', async () => {
    const b = await resolveMailBranding({ recordCollection: 'nivaro_tasks', recipientUserId: 'U1' })
    expect(b.workspace_id).toBe(WS_B)
  })

  it('the harness render scope stands in when the lookup names no workspace', async () => {
    const b = await runWithMailBranding({ workspaceId: WS_A }, () =>
      resolveMailBranding({ recipientUserId: 'U1' })
    )
    expect(b.workspace_id).toBe(WS_A)
    const outside = await resolveMailBranding({ recipientUserId: 'U1' })
    expect(outside.workspace_id).toBe(WS_B)
  })

  it('a DB failure answers the stock chrome rather than throwing', async () => {
    delete tables.nivaro_settings
    delete tables.nivaro_workspaces
    const b = await resolveMailBranding({ workspaceId: WS_A })
    expect(b.sender_name).toBe('Nivaro')
    expect(b.color).toBe('#00ceff')
  })
})

describe('mail branding helpers', () => {
  it('applySenderName keeps the configured ADDRESS and only swaps the display name', () => {
    expect(applySenderName('noreply@example.com', 'Acme')).toBe('"Acme" <noreply@example.com>')
    expect(applySenderName('"Old Name" <noreply@example.com>', 'Acme "Co"')).toBe(
      '"Acme Co" <noreply@example.com>'
    )
    expect(applySenderName('noreply@example.com', null)).toBe('noreply@example.com')
    expect(applySenderName('not-an-address', 'Acme')).toBe('not-an-address')
  })

  it('colour and logo only accept attribute-safe shapes', () => {
    expect(normalizeMailColor('FF6600')).toBe('#ff6600')
    expect(normalizeMailColor('#abc')).toBeNull()
    expect(normalizeMailColor('red;background:url(x)')).toBeNull()
    expect(normalizeMailLogo('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png')
    expect(normalizeMailLogo('javascript:alert(1)')).toBeNull()
    expect(normalizeMailLogo('data:image/png;base64,iVBORw0KGgo=')).toContain('data:image/png')
    expect(normalizeMailLogo('data:text/html;base64,PHA+')).toBeNull()
  })
})
