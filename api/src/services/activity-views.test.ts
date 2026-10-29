import { describe, expect, it, vi } from 'vitest'
import type { ActivityExportRow } from './activity-export.js'
import {
  type ActivityView,
  canEditView,
  canSeeView,
  planRecipients,
  type RecipientUser,
  type SendDeps,
  sendActivityView,
  validateViewInput,
  viewSummaryHtml
} from './activity-views.js'

/** #11 saved audit views: share rules, input validation, per-recipient scheduled sends. */

const ME = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const OTHER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const NON_ADMIN = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

const view = (over: Partial<ActivityView> = {}): ActivityView => ({
  id: 1,
  name: 'Deletes',
  owner: ME,
  filters: { actions: ['delete'], range: 'last_7_days' },
  shared: false,
  schedule: '0 8 * * 1',
  recipients: [],
  last_sent_at: null,
  last_send_status: null,
  created_at: null,
  updated_at: null,
  ...over
})

describe('share rules', () => {
  it('a personal view is the owner’s alone', () => {
    const v = view()
    expect(canSeeView(v, ME)).toBe(true)
    expect(canSeeView(v, OTHER)).toBe(false)
    expect(canEditView(v, OTHER)).toBe(false)
  })

  it('a shared view is visible to every admin but editable by its owner only', () => {
    const v = view({ shared: true })
    expect(canSeeView(v, OTHER)).toBe(true)
    expect(canEditView(v, OTHER)).toBe(false)
    expect(canEditView(v, ME.toUpperCase())).toBe(true)
  })

  it('a system view (owner NULL, the seed) is visible to and editable by any admin', () => {
    const v = view({ owner: null, shared: true })
    expect(canSeeView(v, OTHER)).toBe(true)
    expect(canEditView(v, OTHER)).toBe(true)
  })
})

describe('validateViewInput', () => {
  it('needs a name and valid filters on create; PATCH leaves absent keys alone', () => {
    expect(validateViewInput({}, { partial: false })).toEqual({ error: 'name is required' })
    expect(validateViewInput({ name: 'x', filters: { user: 'sam' } }, { partial: false })).toEqual({
      error: '`user` must be a user id'
    })
    expect(validateViewInput({ shared: true }, { partial: true })).toEqual({
      value: { shared: true }
    })
  })

  it('checks the schedule and that recipients are user ids', () => {
    expect(validateViewInput({ schedule: 'weekly' }, { partial: true })).toHaveProperty('error')
    expect(validateViewInput({ recipients: ['a@b.c'] }, { partial: true })).toHaveProperty('error')
    expect(validateViewInput({ schedule: '', recipients: [ME, ME] }, { partial: true })).toEqual({
      value: { schedule: null, recipients: [ME] }
    })
  })
})

const user = (id: string, over: Partial<RecipientUser> = {}): RecipientUser => ({
  id,
  email: `${id.slice(0, 4)}@x.io`,
  first_name: id.slice(0, 1).toUpperCase(),
  status: 'active',
  isAdmin: true,
  ...over
})

describe('planRecipients — rendered as the recipient', () => {
  it('admins get the view; non-admins only their own trail; inactive accounts nothing', () => {
    const plan = planRecipients(view(), [
      user(ME),
      user(NON_ADMIN, { isAdmin: false }),
      user(OTHER, { status: 'suspended' })
    ])
    expect('filters' in plan[0]).toBe(true)
    expect(plan[1]).toMatchObject({ skip: 'audit views go to administrators only' })
    expect(plan[2]).toMatchObject({ skip: 'not an active account' })

    const own = planRecipients(view({ filters: { user: NON_ADMIN } }), [
      user(NON_ADMIN, { isAdmin: false })
    ])
    expect('filters' in own[0]).toBe(true)
  })
})

describe('sendActivityView', () => {
  const rows: ActivityExportRow[] = [
    {
      id: 1,
      action: 'delete',
      user: ME,
      timestamp: '2026-10-28T10:00:00.000Z',
      collection: 'invoices',
      item: '9',
      comment: '=HYPERLINK("x")',
      first_name: 'Ada',
      last_name: 'L',
      user_email: 'ada@x.io'
    }
  ]

  function deps(users: RecipientUser[]): SendDeps & { sent: Array<Record<string, unknown>> } {
    const sent: Array<Record<string, unknown>> = []
    return {
      sent,
      loadRecipients: vi.fn().mockResolvedValue(users),
      fetchRows: vi.fn().mockResolvedValue({ rows, truncated: false }),
      send: vi.fn(async (m) => {
        sent.push(m)
      }),
      markSent: vi.fn().mockResolvedValue(undefined),
      now: () => new Date('2026-10-29T08:00:00.000Z')
    }
  }

  it('mails each admin a CSV + summary, skips the rest and records why', async () => {
    const d = deps([user(ME), user(OTHER), user(NON_ADMIN, { isAdmin: false })])
    const missing = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
    const r = await sendActivityView(view({ recipients: [ME, OTHER, NON_ADMIN, missing] }), d)
    expect(r.sent).toBe(2)
    expect(r.skipped.map((s) => s.reason).sort()).toEqual([
      'audit views go to administrators only',
      'no such user'
    ])
    expect(d.sent.map((m) => m.to)).toEqual(['aaaa@x.io', 'bbbb@x.io'])
    // Admins share one read of the same filters.
    expect(d.fetchRows).toHaveBeenCalledTimes(1)
    const mail = d.sent[0] as {
      html: string
      attachments: Array<{ filename: string; content: Buffer }>
    }
    expect(mail.html).toContain('<strong>1</strong> entries matched')
    expect(mail.attachments[0].filename).toBe('Deletes-2026-10-29.csv')
    const csv = mail.attachments[0].content.toString('utf8')
    expect(csv.split('\r\n')[0]).toBe('Time (UTC),Person,Email,Action,Collection,Item,Detail')
    // A formula in a comment is neutralised for spreadsheets.
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`)
    expect(d.markSent).toHaveBeenCalledWith(1, expect.stringContaining('sent to 2 recipient(s)'))
  })

  it('says so when nothing matched', () => {
    const html = viewSummaryHtml(view(), [], false, 'Ada', new Date('2026-10-29T00:00:00Z'))
    expect(html).toContain('No entries matched')
    expect(html).toContain('Hi Ada')
  })
})
