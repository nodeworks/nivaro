import { describe, expect, it } from 'vitest'
import { integrationChipSummary } from '../integration-chip'
import type { BannerLine } from '../obligation-banner'

const line = (api: string, outcome: string, tone: BannerLine['tone']): BannerLine => ({
  api,
  outcome,
  tone,
  text: `${outcome} …`,
  obligation_id: 1
})

describe('integrationChipSummary', () => {
  it('counts partners told (green) and partners needing attention (red) from the obligation lines', () => {
    const s = integrationChipSummary(
      [
        line('Fusion IIP', 'sent', 'positive'),
        line('MWF', 'missing', 'danger'),
        line('MDSi', 'pending', 'warning')
      ],
      []
    )
    expect(s.ok).toBe(1)
    expect(s.attention).toBe(1)
    expect(s.pending).toBe(1)
    expect(s.partners.map((p) => `${p.name}:${p.status}`)).toEqual([
      'Fusion IIP:ok',
      'MWF:attention',
      'MDSi:pending'
    ])
  })

  it('a skipped obligation is neither a success nor a problem', () => {
    const s = integrationChipSummary([line('MDSi', 'skipped', 'warning')], [])
    expect(s).toMatchObject({ ok: 0, attention: 0, pending: 0 })
    expect(s.partners[0].status).toBe('neutral')
  })

  it('a partner only the request log knows is added from its newest submission — never twice', () => {
    const s = integrationChipSummary(
      [line('MWF', 'sent', 'positive')],
      [
        { external_api_name: 'MWF', status: 'failed' }, // newest MWF — the obligation line already speaks for MWF
        { external_api_name: 'LinX', status: 'failed', last_error: 'boom' },
        { external_api_name: 'LinX', status: 'accepted' }
      ],
      () => '2m ago'
    )
    expect(s.partners.map((p) => `${p.name}:${p.status}`)).toEqual(['MWF:ok', 'LinX:attention'])
    expect(s.partners[1].tip).toContain('boom')
    expect(s.ok).toBe(1)
    expect(s.attention).toBe(1)
  })

  it('nothing at all → no partners, no badges', () => {
    expect(integrationChipSummary([], [])).toEqual({
      partners: [],
      ok: 0,
      attention: 0,
      pending: 0
    })
  })
})
