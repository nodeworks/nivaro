import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// #2379 Draft a broadcast: only someone who may send may draft; the SMS
// draft never passes 160 characters; the provider sees bullets + audience
// roles/counts, never a recipient.

const who = vi.hoisted(() => ({ admin: false }))
const ai = vi.hoisted(() => ({ create: vi.fn(), model: '' }))

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../middleware/authenticate.js', () => {
  const gate = async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: who.admin ? 'ANA' : 'BOB' }
    req.isAdmin = who.admin
  }
  return {
    requireAuth: gate,
    requireAdmin: async (req: { user?: unknown; isAdmin?: boolean }) => {
      await gate(req)
      if (!who.admin)
        throw Object.assign(new Error('Forbidden'), { statusCode: 403, code: 'ADMIN_ONLY' })
    }
  }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => 1) }))
vi.mock('../../../services/ai-client.js', () => ({
  getAiModelSettings: vi.fn(async () => ({ generateModel: 'gen-model', model: 'default' })),
  getAiClient: vi.fn(async (opts?: { model?: string }) => {
    ai.model = opts?.model ?? ''
    return { messages: { create: ai.create } }
  })
}))

import { db } from '../../../db/index.js'
import { announcementRoutes } from '../../../routes/announcements.js'
import {
  cleanBullets,
  cleanDraft,
  describeAudience,
  fitTo,
  SMS_MAX
} from '../../../services/broadcast-draft.js'

const PEOPLE = [
  {
    id: 'U1',
    email: 'beth.ng@example.com',
    phone: '+15550101',
    first_name: 'Beth',
    last_name: 'Ng',
    role: 'R1'
  },
  {
    id: 'U2',
    email: 'kim.o@example.com',
    phone: null,
    first_name: 'Kim',
    last_name: 'Oh',
    role: 'R1'
  }
]

function fakeDb() {
  vi.mocked(db).mockImplementation(((name: string) => {
    const table = String(name).split(' ')[0]
    const b = Object.assign(Promise.resolve([]), {}) as Promise<unknown> & Record<string, unknown>
    for (const m of ['where', 'whereIn', 'orderBy']) b[m] = vi.fn(() => b)
    b.pluck = vi.fn(async () => (table === 'nivaro_roles' ? ['Field Ops'] : []))
    b.select = vi.fn(async () => (table === 'nivaro_users' ? PEOPLE : []))
    b.first = vi.fn(async () => undefined)
    return b
  }) as never)
}

async function draft(body: Record<string, unknown>) {
  const a = Fastify()
  await a.register(announcementRoutes, { prefix: '/api/announcements' })
  return a.inject({ method: 'POST', url: '/api/announcements/draft', payload: body })
}

beforeEach(() => {
  fakeDb()
  ai.create.mockReset()
  ai.create.mockResolvedValue({
    content: [
      {
        type: 'tool_use',
        input: {
          banner: 'Maintenance Saturday 6–8am.',
          email_subject: 'Planned maintenance Saturday',
          email_body: 'The system is down Saturday 6–8am.\n- Save your work Friday',
          sms: `Maintenance Saturday 6-8am. ${'Please save your work before you leave on Friday. '.repeat(6)}`
        }
      }
    ]
  })
})

describe('POST /announcements/draft', () => {
  it('refuses someone who may not send a broadcast, before any AI call', async () => {
    who.admin = false
    const r = await draft({ bullets: '- down Saturday' })
    expect(r.statusCode).toBe(403)
    expect(ai.create).not.toHaveBeenCalled()
  })

  it('drafts for a sender: SMS within 160, the generate model, no recipient sent', async () => {
    who.admin = true
    const r = await draft({
      bullets:
        '- System down Saturday 6–8am\n- token: abcdef123456 do not share\n- Questions: IT desk',
      audience: { roles: ['R1'] },
      channels: ['banner', 'email', 'sms'],
      severity: 'warn'
    })
    expect(r.statusCode).toBe(200)
    const d = r.json().data
    expect(d.sms.length).toBeLessThanOrEqual(SMS_MAX)
    expect(d.email.subject).toBe('Planned maintenance Saturday')
    expect(ai.model).toBe('gen-model')
    const sent = JSON.stringify(ai.create.mock.calls[0][0])
    expect(sent).toContain('Field Ops')
    expect(sent).toContain('about 2 recipients')
    for (const leak of [
      'Beth',
      'Ng',
      'beth.ng@example.com',
      'kim.o@example.com',
      '+15550101',
      'abcdef123456'
    ])
      expect(sent).not.toContain(leak)
  })

  it('needs bullets', async () => {
    who.admin = true
    const r = await draft({ bullets: '   ' })
    expect(r.statusCode).toBe(400)
  })
})

describe('draft shaping', () => {
  it('cuts the SMS to 160 at a word boundary, whatever the model returns', () => {
    const long = 'word '.repeat(100)
    const d = cleanDraft({ banner: 'x', email_subject: 's', email_body: 'b', sms: long })
    expect(d.sms.length).toBeLessThanOrEqual(160)
    expect(d.sms.endsWith('…')).toBe(true)
    expect(fitTo('short text', 160)).toBe('short text')
    expect(cleanDraft({ sms: 'x'.repeat(500) }).sms.length).toBeLessThanOrEqual(160)
    expect(cleanDraft({}).sms).toBe('')
  })
  it('bullets: markers stripped, secrets scrubbed, capped', () => {
    expect(cleanBullets('- one\n* two\n3) three\n\npassword=hunter22')).toEqual([
      'one',
      'two',
      'three',
      expect.not.stringContaining('hunter22')
    ])
    expect(cleanBullets(Array.from({ length: 50 }, (_, i) => `p${i}`))).toHaveLength(20)
  })
  it('the audience is described by names of roles and dimensions and counts only', () => {
    expect(
      describeAudience({
        everyone: false,
        roles: ['Field Ops'],
        dimensions: [{ label: 'Region', values: 2 }],
        explicit_people: 3,
        recipients: 41
      })
    ).toBe(
      'people in the role Field Ops; people scoped to 2 selected Region values; 3 individually chosen people — about 41 recipients in total'
    )
  })
})
