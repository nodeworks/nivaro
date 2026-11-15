import { beforeEach, describe, expect, it, vi } from 'vitest'

// Realtime round 9 (#22): the public submission status link. Signed, expiring, bound to ONE
// submission (only its SHA-256 is stored); only the stages the form owner mapped leave the server.

vi.mock('../../../config.js', () => ({
  config: {
    SESSION_SECRET: 'submission-status-test-secret-0123456789abcdef',
    PUBLIC_URL: 'https://nivaro.test'
  }
}))

const tables: Record<string, Array<Record<string, unknown>>> = {}
vi.mock('../../../db/index.js', () => ({
  db: (table: string) => {
    let rows = tables[table] ?? []
    const q = {
      where(cond: Record<string, unknown>) {
        rows = rows.filter((r) => Object.entries(cond).every(([k, v]) => r[k] === v))
        return q
      },
      first: async () => rows[0]
    }
    return q
  }
}))

import {
  hashStatusToken,
  mintStatusToken,
  parseStatusPageConfig,
  publicStatusOf,
  readStatusToken,
  resolveStatusLink,
  STATUS_META_KEY,
  statusMetaOf,
  submitterEmail,
  tokenMatches,
  withoutStatusMeta
} from '../../../services/submission-status.js'

const SUB_A = '0f6e2c4a-1b2d-4e5f-8a9b-0c1d2e3f4a5b'
const SUB_B = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d'

const CFG = {
  status_page: {
    enabled: true,
    source: 'pipeline',
    map: [
      { value: 'new', stage: 'received' },
      { value: 'triage', stage: 'in_review', label: 'Being looked at' },
      { value: 'approved', stage: 'decided', label: 'Approved' }
    ],
    email_field: 'email'
  }
}

function seed(submissions: Array<{ id: string; meta: unknown }>, formConfig: unknown = CFG) {
  tables.nivaro_submissions = submissions.map((s) => ({
    id: s.id,
    form: 'form-1',
    data: JSON.stringify({ title: 'x', [STATUS_META_KEY]: s.meta }),
    created_at: new Date('2026-11-14T15:00:00Z')
  }))
  tables.nivaro_submission_forms = [
    {
      id: 'form-1',
      name: 'Site access request',
      collection: 'requests',
      form_config: JSON.stringify(formConfig),
      is_active: 1,
      created_by: 'creator-1'
    }
  ]
}

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k]
})

describe('status tokens', () => {
  it('resolve to the submission that minted them', async () => {
    const a = mintStatusToken(SUB_A, '101', 90)
    seed([{ id: SUB_A, meta: a.meta }])
    const link = await resolveStatusLink(a.token)
    expect(link?.submissionId).toBe(SUB_A)
    expect(link?.item).toBe('101')
    expect(link?.formName).toBe('Site access request')
  })

  it('fit a URL path segment (Fastify answers 414 past 100 characters)', () => {
    const a = mintStatusToken(SUB_A, '101', 365)
    expect(a.token.length).toBeLessThan(100)
    expect(a.token).toMatch(/^[A-Za-z0-9_.-]+$/)
    expect(readStatusToken(a.token)?.s).toBe(SUB_A)
    expect(() => mintStatusToken('not-a-uuid', '1', 1)).toThrow()
  })

  it('store only a SHA-256 of the token, never the token', () => {
    const a = mintStatusToken(SUB_A, '101', 90)
    expect(a.meta.hash).toBe(hashStatusToken(a.token))
    expect(JSON.stringify(a.meta)).not.toContain(a.token)
    expect(a.meta.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuse a tampered body or signature', async () => {
    const a = mintStatusToken(SUB_A, '101', 90)
    const b = mintStatusToken(SUB_B, '202', 90)
    seed([
      { id: SUB_A, meta: a.meta },
      { id: SUB_B, meta: b.meta }
    ])
    const [bodyA, sigA] = a.token.split('.')
    const [bodyB] = b.token.split('.')
    // Another submission's body under A's signature.
    expect(readStatusToken(`${bodyB}.${sigA}`)).toBeNull()
    expect(await resolveStatusLink(`${bodyB}.${sigA}`)).toBeNull()
    // A's body edited to name B, A's signature.
    const forged = SUB_B.replace(/-/g, '') + bodyA.slice(32)
    expect(await resolveStatusLink(`${forged}.${sigA}`)).toBeNull()
    // A's expiry pushed out, A's signature.
    const later = bodyA.slice(0, 32) + 'ffffffff' + bodyA.slice(40)
    expect(readStatusToken(`${later}.${sigA}`)).toBeNull()
    // One character off in the signature.
    const flipped = sigA.slice(0, -1) + (sigA.endsWith('A') ? 'B' : 'A')
    expect(await resolveStatusLink(`${bodyA}.${flipped}`)).toBeNull()
    expect(await resolveStatusLink('not-a-token')).toBeNull()
    expect(await resolveStatusLink('')).toBeNull()
  })

  it('refuse an expired token', async () => {
    const past = Date.now() - 3 * 86_400_000
    const a = mintStatusToken(SUB_A, '101', 1, past)
    seed([{ id: SUB_A, meta: a.meta }])
    expect(readStatusToken(a.token)).toBeNull()
    expect(await resolveStatusLink(a.token)).toBeNull()
  })

  it('never open another submission (a valid token is bound to its own)', async () => {
    const a = mintStatusToken(SUB_A, '101', 90)
    const b = mintStatusToken(SUB_B, '202', 90)
    // sub-b carries a's hash? No — each submission stores its own; a's token against b fails.
    seed([
      { id: SUB_A, meta: b.meta }, // swapped bindings
      { id: SUB_B, meta: a.meta }
    ])
    expect(await resolveStatusLink(a.token)).toBeNull()
    expect(await resolveStatusLink(b.token)).toBeNull()
    expect(tokenMatches(a.token, b.meta)).toBe(false)
  })

  it('stop working when the form owner turns the status page off', async () => {
    const a = mintStatusToken(SUB_A, '101', 90)
    seed([{ id: SUB_A, meta: a.meta }], { status_page: { ...CFG.status_page, enabled: false } })
    expect(await resolveStatusLink(a.token)).toBeNull()
  })

  it('stop working for a regenerated binding (the stored hash moved on)', async () => {
    const a = mintStatusToken(SUB_A, '101', 90)
    const again = mintStatusToken(SUB_A, '101', 90)
    seed([{ id: SUB_A, meta: again.meta }])
    expect(await resolveStatusLink(a.token)).toBeNull()
    expect((await resolveStatusLink(again.token))?.submissionId).toBe(SUB_A)
  })
})

describe('what the submitter may read', () => {
  const cfg = parseStatusPageConfig(CFG)

  it('maps only the listed values; anything else is a plain "In review"', () => {
    expect(publicStatusOf(cfg, 'new')).toEqual({
      stage: 'received',
      label: 'Received',
      gone: false
    })
    expect(publicStatusOf(cfg, 'triage')).toMatchObject({
      stage: 'in_review',
      label: 'Being looked at'
    })
    expect(publicStatusOf(cfg, 'APPROVED')).toMatchObject({ stage: 'decided', label: 'Approved' })
    // An internal step name never leaks.
    expect(publicStatusOf(cfg, 'legal_hold_secret')).toEqual({
      stage: 'in_review',
      label: 'In review',
      gone: false
    })
    expect(publicStatusOf(cfg, null).stage).toBe('received')
  })

  it("uses the step's outside label for a mapped step with no label of its own", () => {
    expect(publicStatusOf(cfg, 'new', 'We have it').label).toBe('We have it')
    // …never for an unmapped one.
    expect(publicStatusOf(cfg, 'other', 'Internal label').label).toBe('In review')
  })

  it('reads junk config as off', () => {
    expect(parseStatusPageConfig(null).enabled).toBe(false)
    expect(parseStatusPageConfig('{bad').enabled).toBe(false)
    expect(parseStatusPageConfig({ status_page: { enabled: true, source: 'field' } }).enabled).toBe(
      false
    ) // a field source needs a field
    expect(
      parseStatusPageConfig({ status_page: { enabled: true, field: 'x; DROP', source: 'field' } })
        .field
    ).toBeNull()
  })

  it('hides the binding from admin reads', () => {
    const a = mintStatusToken(SUB_A, '101', 90)
    const data = { title: 'x', [STATUS_META_KEY]: a.meta }
    expect(withoutStatusMeta(data)).toEqual({ title: 'x' })
    expect(statusMetaOf(JSON.stringify(data))?.hash).toBe(a.meta.hash)
  })

  it('emails only a plausible address from the configured field', () => {
    expect(submitterEmail(cfg, { email: ' pat@example.com ' })).toBe('pat@example.com')
    expect(submitterEmail(cfg, { email: 'not an email' })).toBeNull()
    expect(submitterEmail(cfg, { email: 'a@b.c<script>' })).toBeNull()
    expect(submitterEmail(cfg, { other: 'pat@example.com' })).toBeNull()
  })
})

describe('receipt email caps (security review M2)', () => {
  it('folds case, spaces and +tags into one mailbox key; never the address itself', async () => {
    const { receiptAddressKey } = await import('../../../services/submission-status.js')
    const k = receiptAddressKey('pat@example.com')
    expect(receiptAddressKey(' PAT+news@Example.COM ')).toBe(k)
    expect(receiptAddressKey('sam@example.com')).not.toBe(k)
    expect(k).not.toContain('pat')
  })

  it('3 a day per mailbox, 60 an hour per form, independent of who submits', async () => {
    const { mayMailReceipt, RECEIPT_MAILS_PER_ADDRESS_DAY, RECEIPT_MAILS_PER_FORM_HOUR } =
      await import('../../../services/submission-status.js')
    const { resetWindowedMemory } = await import('../../../services/windowed-limit.js')
    resetWindowedMemory()
    const got: boolean[] = []
    for (let i = 0; i <= RECEIPT_MAILS_PER_ADDRESS_DAY; i++)
      got.push(await mayMailReceipt(null, 'f-1', 'pat@example.com'))
    expect(got).toEqual([true, true, true, false])
    // The same mailbox through another form: still capped (the cap is per mailbox).
    expect(await mayMailReceipt(null, 'f-2', 'pat@example.com')).toBe(false)

    resetWindowedMemory()
    let sent = 0
    for (let i = 0; i < RECEIPT_MAILS_PER_FORM_HOUR + 5; i++)
      if (await mayMailReceipt(null, 'f-3', `p@d${i}.example`)) sent++
    expect(sent).toBe(RECEIPT_MAILS_PER_FORM_HOUR)
    // Another form is not held back by this one.
    expect(await mayMailReceipt(null, 'f-4', 'fresh@example.com')).toBe(true)
  })

  it('the status link names the tenant origin in cloud mode (security review L4)', async () => {
    const { statusPageUrl } = await import('../../../services/submission-status.js')
    const { runWithTenantDb } = await import('../../../db/tenant-context.js')
    expect(statusPageUrl('abc')).toBe('https://nivaro.test/form-status/abc')
    const url = await new Promise<string>((resolve) =>
      runWithTenantDb(
        {} as never,
        'acme',
        () => resolve(statusPageUrl('abc')),
        'tid',
        'https://acme.nivaro.dev'
      )
    )
    expect(url).toBe('https://acme.nivaro.dev/form-status/abc')
  })
})

describe('receipt mailbox normalization + domain / instance caps (review follow-up)', () => {
  it('dot, +tag, quote, case and googlemail variants of one Gmail box share one bucket', async () => {
    const { receiptAddressKey } = await import('../../../services/submission-status.js')
    const k = receiptAddressKey('johnsmith@gmail.com')
    for (const v of [
      'John.Smith@gmail.com',
      'j.o.h.n.smith+promo@googlemail.com',
      '"johnsmith"@GMAIL.COM',
      ' johnsmith+a+b@gmail.com. '
    ])
      expect(receiptAddressKey(v)).toBe(k)
    // Dots matter outside Gmail.
    expect(receiptAddressKey('john.smith@example.com')).not.toBe(
      receiptAddressKey('johnsmith@example.com')
    )
  })

  it('the Gmail variants are capped together', async () => {
    const { mayMailReceipt } = await import('../../../services/submission-status.js')
    const { resetWindowedMemory } = await import('../../../services/windowed-limit.js')
    resetWindowedMemory()
    const got: boolean[] = []
    for (const v of [
      'jo.smith@gmail.com',
      'josmith+1@googlemail.com',
      'JOSMITH@gmail.com',
      'j.o.smith@googlemail.com'
    ])
      got.push(await mayMailReceipt(null, 'f-g', v, { ownDomains: new Set() }))
    expect(got).toEqual([true, true, true, false])
  })

  it('30 an hour per recipient domain PER FORM; our own sending domain is exempt', async () => {
    const { mayMailReceipt, RECEIPT_MAILS_PER_DOMAIN_HOUR } = await import(
      '../../../services/submission-status.js'
    )
    const { resetWindowedMemory } = await import('../../../services/windowed-limit.js')
    resetWindowedMemory()
    const own = new Set(['ourco.example'])
    let sent = 0
    for (let i = 0; i < RECEIPT_MAILS_PER_DOMAIN_HOUR + 5; i++)
      if (await mayMailReceipt(null, 'f-a', `v${i}@victim.example`, { ownDomains: own })) sent++
    expect(sent).toBe(RECEIPT_MAILS_PER_DOMAIN_HOUR)
    // Another form still reaches that domain; another domain is unaffected.
    expect(await mayMailReceipt(null, 'f-b', 'w@victim.example', { ownDomains: own })).toBe(true)
    expect(await mayMailReceipt(null, 'f-a', 'x@other.example', { ownDomains: own })).toBe(true)
    let ours = 0
    for (let i = 0; i < 40; i++)
      if (await mayMailReceipt(null, 'f-own', `staff${i}@ourco.example`, { ownDomains: own }))
        ours++
    expect(ours).toBe(40)
  })

  it('a Gmail flood on form A never blocks Gmail receipts on form B (no free-mail domain cap)', async () => {
    const { mayMailReceipt, RECEIPT_MAILS_PER_FORM_HOUR } = await import(
      '../../../services/submission-status.js'
    )
    const { resetWindowedMemory } = await import('../../../services/windowed-limit.js')
    resetWindowedMemory()
    let a = 0
    for (let i = 0; i < RECEIPT_MAILS_PER_FORM_HOUR + 5; i++)
      if (await mayMailReceipt(null, 'form-a', `flood${i}@gmail.com`, { ownDomains: new Set() }))
        a++
    // Only the form's own cap stopped it (no 30-a-domain cap on gmail.com).
    expect(a).toBe(RECEIPT_MAILS_PER_FORM_HOUR)
    expect(await mayMailReceipt(null, 'form-b', 'pat@gmail.com', { ownDomains: new Set() })).toBe(
      true
    )
    expect(
      await mayMailReceipt(null, 'form-b', 'sam@googlemail.com', { ownDomains: new Set() })
    ).toBe(true)
  })

  it('many forms together cannot push one domain past 100 an hour', async () => {
    const { mayMailReceipt, RECEIPT_MAILS_PER_DOMAIN_ALL_FORMS_HOUR } = await import(
      '../../../services/submission-status.js'
    )
    const { resetWindowedMemory } = await import('../../../services/windowed-limit.js')
    resetWindowedMemory()
    const own = new Set<string>()
    let sent = 0
    // 10 forms × 20 sends each: every form stays under its own 30, together they would be 200.
    for (let f = 0; f < 10; f++)
      for (let i = 0; i < 20; i++)
        if (
          await mayMailReceipt(null, `form-${f}`, `u${f}-${i}@target.example`, { ownDomains: own })
        )
          sent++
    expect(sent).toBe(RECEIPT_MAILS_PER_DOMAIN_ALL_FORMS_HOUR)
    // Another domain and free-mail are untouched by it.
    expect(await mayMailReceipt(null, 'form-0', 'a@else.example', { ownDomains: own })).toBe(true)
    expect(await mayMailReceipt(null, 'form-0', 'a@gmail.com', { ownDomains: own })).toBe(true)
  })

  it('a send refused by an earlier cap spends no domain unit', async () => {
    const { mayMailReceipt, RECEIPT_MAILS_PER_ADDRESS_DAY, RECEIPT_MAILS_PER_DOMAIN_HOUR } =
      await import('../../../services/submission-status.js')
    const { resetWindowedMemory } = await import('../../../services/windowed-limit.js')
    resetWindowedMemory()
    const own = new Set<string>()
    // One mailbox: its 3 sends take 3 domain units; the 20 refused ones take none.
    for (let i = 0; i < RECEIPT_MAILS_PER_ADDRESS_DAY + 20; i++)
      await mayMailReceipt(null, 'f-d', 'same@corp.example', { ownDomains: own })
    let more = 0
    for (let i = 0; i < RECEIPT_MAILS_PER_DOMAIN_HOUR; i++)
      if (await mayMailReceipt(null, 'f-d', `p${i}@corp.example`, { ownDomains: own })) more++
    expect(more).toBe(RECEIPT_MAILS_PER_DOMAIN_HOUR - RECEIPT_MAILS_PER_ADDRESS_DAY)
  })

  it('own sending domains are cached per tenant and never a free-mail provider', async () => {
    const { ownMailDomains } = await import('../../../services/submission-status.js')
    const { runWithTenantDb } = await import('../../../db/tenant-context.js')
    const inTenant = <T>(id: string, fn: () => Promise<T>) =>
      new Promise<T>((resolve, reject) =>
        runWithTenantDb({} as never, id, () => void fn().then(resolve, reject), id)
      )
    tables.nivaro_settings = [{ id: 1, smtp_from: 'Ops <ops@alpha.example>' }]
    expect([...(await inTenant('t-alpha', ownMailDomains))]).toEqual(['alpha.example'])
    tables.nivaro_settings = [{ id: 1, smtp_from: 'help@beta.example' }]
    expect([...(await inTenant('t-beta', ownMailDomains))]).toEqual(['beta.example'])
    // Tenant alpha keeps its own (cached) answer; beta's never leaks into it.
    expect([...(await inTenant('t-alpha', ownMailDomains))]).toEqual(['alpha.example'])
    tables.nivaro_settings = [{ id: 1, smtp_from: 'us@gmail.com' }]
    expect((await inTenant('t-gmail', ownMailDomains)).has('gmail.com')).toBe(false)
    tables.nivaro_settings = []
  })

  it('300 an hour for the whole instance', async () => {
    const { mayMailReceipt, RECEIPT_MAILS_PER_INSTANCE_HOUR } = await import(
      '../../../services/submission-status.js'
    )
    const { resetWindowedMemory } = await import('../../../services/windowed-limit.js')
    resetWindowedMemory()
    let sent = 0
    for (let i = 0; i < RECEIPT_MAILS_PER_INSTANCE_HOUR + 10; i++)
      if (await mayMailReceipt(null, `f-${i}`, `p@d${i}.example`, { ownDomains: new Set() })) sent++
    expect(sent).toBe(RECEIPT_MAILS_PER_INSTANCE_HOUR)
  })
})
