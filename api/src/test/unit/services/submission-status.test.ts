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
    const a = mintStatusToken('sub-a', '101', 90)
    seed([{ id: 'sub-a', meta: a.meta }])
    const link = await resolveStatusLink(a.token)
    expect(link?.submissionId).toBe('sub-a')
    expect(link?.item).toBe('101')
    expect(link?.formName).toBe('Site access request')
  })

  it('store only a SHA-256 of the token, never the token', () => {
    const a = mintStatusToken('sub-a', '101', 90)
    expect(a.meta.hash).toBe(hashStatusToken(a.token))
    expect(JSON.stringify(a.meta)).not.toContain(a.token)
    expect(a.meta.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuse a tampered body or signature', async () => {
    const a = mintStatusToken('sub-a', '101', 90)
    const b = mintStatusToken('sub-b', '202', 90)
    seed([
      { id: 'sub-a', meta: a.meta },
      { id: 'sub-b', meta: b.meta }
    ])
    const [bodyA, sigA] = a.token.split('.')
    const [bodyB] = b.token.split('.')
    // Another submission's body under A's signature.
    expect(readStatusToken(`${bodyB}.${sigA}`)).toBeNull()
    expect(await resolveStatusLink(`${bodyB}.${sigA}`)).toBeNull()
    // A body edited to name sub-b, re-encoded, A's signature.
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(bodyA, 'base64url').toString()), s: 'sub-b' })
    ).toString('base64url')
    expect(await resolveStatusLink(`${forged}.${sigA}`)).toBeNull()
    // One character off in the signature.
    const flipped = sigA.slice(0, -1) + (sigA.endsWith('A') ? 'B' : 'A')
    expect(await resolveStatusLink(`${bodyA}.${flipped}`)).toBeNull()
    expect(await resolveStatusLink('not-a-token')).toBeNull()
    expect(await resolveStatusLink('')).toBeNull()
  })

  it('refuse an expired token', async () => {
    const past = Date.now() - 3 * 86_400_000
    const a = mintStatusToken('sub-a', '101', 1, past)
    seed([{ id: 'sub-a', meta: a.meta }])
    expect(readStatusToken(a.token)).toBeNull()
    expect(await resolveStatusLink(a.token)).toBeNull()
  })

  it('never open another submission (a valid token is bound to its own)', async () => {
    const a = mintStatusToken('sub-a', '101', 90)
    const b = mintStatusToken('sub-b', '202', 90)
    // sub-b carries a's hash? No — each submission stores its own; a's token against b fails.
    seed([
      { id: 'sub-a', meta: b.meta }, // swapped bindings
      { id: 'sub-b', meta: a.meta }
    ])
    expect(await resolveStatusLink(a.token)).toBeNull()
    expect(await resolveStatusLink(b.token)).toBeNull()
    expect(tokenMatches(a.token, b.meta)).toBe(false)
  })

  it('stop working when the form owner turns the status page off', async () => {
    const a = mintStatusToken('sub-a', '101', 90)
    seed([{ id: 'sub-a', meta: a.meta }], { status_page: { ...CFG.status_page, enabled: false } })
    expect(await resolveStatusLink(a.token)).toBeNull()
  })

  it('stop working for a regenerated binding (the stored hash moved on)', async () => {
    const a = mintStatusToken('sub-a', '101', 90)
    const again = mintStatusToken('sub-a', '101', 90)
    seed([{ id: 'sub-a', meta: again.meta }])
    expect(await resolveStatusLink(a.token)).toBeNull()
    expect((await resolveStatusLink(again.token))?.submissionId).toBe('sub-a')
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
    const a = mintStatusToken('sub-a', '101', 90)
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
