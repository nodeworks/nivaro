import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: () => ({}) }))

import {
  bannerPhrase,
  dismissedIds,
  firstTemplateField,
  parseBannerIds,
  stillHolds,
  withDismissal,
  withUnit
} from '../../../services/alert-banners.js'
import {
  type ApprovalLinkState,
  linkHeadline,
  linkStateHtml,
  linkStateSignature,
  redactLinkState
} from '../../../services/approval-link-state.js'
import { publicLiveCsp, publicLivePageHtml } from '../../../services/public-live-page.js'
import { maskUrlPath, maskUrlQuery } from '../../../services/secret-mask.js'

const base: ApprovalLinkState = {
  status: 'pending',
  chain_name: 'Capital spend',
  step_label: 'Finance review',
  step_number: 2,
  step_count: 3,
  last: {
    decision: 'approved',
    by: 'Beth Lee',
    at: '2026-11-14T15:42:00.000Z',
    step_label: 'Manager',
    mine: false
  },
  mine: null,
  waiting_on_holder: false
}

describe('decision link headline (rt9 #21)', () => {
  it('says who already decided, and offers nothing to press', () => {
    const h = linkHeadline({ ...base, status: 'approved' }, 'approve')
    expect(h.title).toBe('Already approved')
    expect(h.by).toEqual({ name: 'Beth Lee', at: '2026-11-14T15:42:00.000Z' })
    expect(h.decidable).toBe(false)
    const r = linkHeadline(
      { ...base, status: 'rejected', last: { ...base.last!, decision: 'rejected' } },
      'approve'
    )
    expect(r.title).toBe('Already rejected')
    expect(r.decidable).toBe(false)
  })

  it('asks only while the step is the link holder’s and undecided', () => {
    const h = linkHeadline({ ...base, waiting_on_holder: true }, 'reject')
    expect(h.title).toBe('Reject Finance review?')
    expect(h.decidable).toBe(true)
    expect(h.note).toContain('Manager approved by Beth Lee')
  })

  it('tells the holder their own earlier decision and who is next', () => {
    const mine = { ...base.last!, by: 'Sam', mine: true }
    const h = linkHeadline({ ...base, mine, last: mine }, 'approve')
    expect(h.title).toBe('You approved your step')
    expect(h.note).toBe('Now waiting on Finance review.')
    expect(h.decidable).toBe(false)
  })

  it('redacts names and times for anonymous readers, but still lets the approver decide', () => {
    const a = redactLinkState({ ...base, status: 'approved' })
    const h = linkHeadline(a, 'approve')
    expect(h.title).toBe('This approval has already been decided')
    expect(h.by).toBeNull()
    expect(JSON.stringify(h)).not.toContain('Beth')
    expect(linkHeadline(redactLinkState(base), 'approve').title).toBe('Waiting on Finance review')
    const ask = linkHeadline(redactLinkState({ ...base, waiting_on_holder: true }), 'approve')
    expect(ask.decidable).toBe(true)
    expect(JSON.stringify(ask)).not.toContain('Beth')
  })

  it('handles withdrawn and removed approvals', () => {
    expect(linkHeadline({ ...base, status: 'cancelled' }, 'approve').title).toMatch(/withdrawn/)
    expect(linkHeadline({ ...base, status: 'gone' }, 'approve').decidable).toBe(false)
  })

  it('escapes names in the page and the signature moves only with what shows', () => {
    const evil = {
      ...base,
      status: 'approved' as const,
      last: { ...base.last!, by: '<img src=x>' }
    }
    const html = linkStateHtml(linkHeadline(evil, 'approve'), {})
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
    expect(linkStateSignature(base)).toBe(linkStateSignature({ ...base, chain_name: 'renamed' }))
    expect(linkStateSignature(base)).not.toBe(linkStateSignature({ ...base, status: 'approved' }))
  })
})

describe('public live page shell', () => {
  it('runs only its nonce’d script and never frames', () => {
    const csp = publicLiveCsp('abc')
    expect(csp).toContain("script-src 'nonce-abc'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("form-action 'none'")
    expect(publicLiveCsp('abc', { forms: true })).toContain("form-action 'self'")
    const html = publicLivePageHtml({
      title: '<b>t</b>',
      liveHtml: '<p>x</p>',
      nonce: 'abc',
      streamUrl: null,
      refreshUrl: '/x'
    })
    expect(html).toContain('<script nonce="abc">')
    expect(html).toContain('&lt;b&gt;t&lt;/b&gt;')
    expect(html).toContain('name="referrer" content="no-referrer"')
  })
})

describe('tokens never reach the logs', () => {
  it('masks the status-page path and the decision-link query', () => {
    expect(maskUrlPath('/form-status/eyJzIjoi.abc123')).toBe('/form-status/••••••')
    expect(maskUrlPath('/form-status/eyJzIjoi.abc123/stream')).toBe('/form-status/••••••/stream')
    expect(maskUrlQuery('/api/message-actions/stream?token=abc.def')).not.toContain('abc.def')
  })
})

describe('threshold banners (rt9 #20)', () => {
  it('phrases the crossing by its direction and age', () => {
    const now = Date.parse('2026-11-14T16:00:00Z')
    expect(bannerPhrase('gte', 90, '%', new Date(now - 3_600_000), now)).toBe('just crossed 90%')
    expect(bannerPhrase('gt', 90, '%', new Date(now - 3 * 86_400_000), now)).toBe('crossed 90%')
    expect(bannerPhrase('lt', 10, '%', new Date(now), now)).toBe('just dropped below 10%')
    expect(bannerPhrase('gte', 250000, '$', new Date(now), now)).toBe('just crossed $250,000')
    expect(withUnit(5, 'count')).toBe('5')
  })

  it('shows a banner only while the value still holds', () => {
    expect(stillHolds('gte', 91, 90)).toBe(true)
    expect(stillHolds('gte', 89.9, 90)).toBe(false)
    expect(stillHolds('lt', 5, 10)).toBe(true)
    expect(stillHolds('bogus', 5, 10)).toBe(false)
  })

  it('keeps dismissals per person, newest kept, no duplicates', () => {
    const prefs = { alert_banner_dismissed: [1, 2, 3] }
    expect(withDismissal(prefs, 2)).toEqual([1, 3, 2])
    expect(dismissedIds({ alert_banner_dismissed: withDismissal({}, 7) }).has(7)).toBe(true)
    const many = { alert_banner_dismissed: Array.from({ length: 400 }, (_v, i) => i) }
    expect(withDismissal(many, 999)).toHaveLength(300)
  })

  it('names the record by the first plain field of its display template', () => {
    expect(firstTemplateField('{{project_id}} - {{name}}')).toBe('project_id')
    expect(firstTemplateField('{{ type.name }} {{code}}')).toBe('code')
    expect(firstTemplateField(null)).toBeNull()
  })

  it('reads the banner list as ids only', () => {
    expect([...parseBannerIds('[3,"4",-1,"x",3]')]).toEqual([3, 4])
    expect(parseBannerIds('{bad').size).toBe(0)
  })
})
