import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

import {
  evaluateReplayHealth,
  type ReplayHealthFigures
} from '../../../services/session-replay-health.js'

/** The session-replay readiness check (#1412): thresholds and causes. */

const NOW = new Date('2026-10-10T12:00:00Z')

function figures(over: Partial<ReplayHealthFigures> = {}): ReplayHealthFigures {
  return {
    recording_enabled: true,
    clips_enabled: false,
    uploads: {
      accepted: 1000,
      duplicates: 10,
      rejected_closed: 0,
      rejected_size_cap: 0,
      rejected_too_large: 0,
      rejected_daily_cap: 0,
      client_failures: 0
    },
    recordings_24h: 40,
    active_people_24h: 25,
    sampling_default: 1,
    cap_mb: null,
    cap_hit_at: null,
    cap_top_route: null,
    retention_days: 7,
    oldest_started_at: new Date(NOW.getTime() - 6 * 86_400_000),
    ...over
  }
}

const uploads = (u: Partial<ReplayHealthFigures['uploads']>) => ({
  ...figures().uploads,
  ...u
})

describe('evaluateReplayHealth', () => {
  it('skips while recording and clips are off', () => {
    expect(
      evaluateReplayHealth(figures({ recording_enabled: false, clips_enabled: false }), NOW).status
    ).toBe('skip')
  })

  it('passes a healthy day with the figures', () => {
    const r = evaluateReplayHealth(figures(), NOW)
    expect(r.status).toBe('pass')
    expect(r.detail).toBe(
      '1010 chunk upload(s) since yesterday, 0% failed; 40 recording(s) in the last 24 hours.'
    )
  })

  it('stays quiet at 5% failures and warns above it, naming the biggest cause', () => {
    // 50 / 1000 attempts = 5.0% → no warning
    expect(
      evaluateReplayHealth(
        figures({ uploads: uploads({ accepted: 940, duplicates: 10, client_failures: 50 }) }),
        NOW
      ).status
    ).toBe('pass')
    const r = evaluateReplayHealth(
      figures({
        uploads: uploads({
          accepted: 900,
          duplicates: 0,
          rejected_too_large: 60,
          client_failures: 20
        })
      }),
      NOW
    )
    expect(r.status).toBe('warn')
    expect(r.detail).toMatch(/^8\.2% of chunk uploads failed since yesterday \(80 of 980\)/)
    expect(r.detail).toMatch(/Likely cause: 60 chunk\(s\) over 8 MB were refused \(413\)/)
    expect(r.detail).toMatch(/Also: 20 attempt\(s\) failed before reaching the server/)
  })

  it('does not judge a failure rate on a handful of uploads', () => {
    const r = evaluateReplayHealth(
      figures({ uploads: uploads({ accepted: 5, duplicates: 0, client_failures: 5 }) }),
      NOW
    )
    expect(r.status).toBe('pass')
  })

  it('warns when nothing was recorded while people were active', () => {
    const r = evaluateReplayHealth(figures({ recordings_24h: 0, active_people_24h: 12 }), NOW)
    expect(r.status).toBe('warn')
    expect(r.detail).toMatch(/No recording started in the last 24 hours while 12 people/)
    expect(r.detail).toMatch(/rrweb failed to load/)
    const sampled = evaluateReplayHealth(
      figures({ recordings_24h: 0, active_people_24h: 12, sampling_default: 0 }),
      NOW
    )
    expect(sampled.detail).toMatch(/sampling records 0% of sessions/)
    // nobody active, or clips only: nothing to say
    expect(
      evaluateReplayHealth(figures({ recordings_24h: 0, active_people_24h: 0 }), NOW).status
    ).toBe('pass')
    expect(
      evaluateReplayHealth(
        figures({ recording_enabled: false, clips_enabled: true, recordings_24h: 0 }),
        NOW
      ).status
    ).toBe('pass')
  })

  it('warns when the daily cap was hit, with the heaviest page', () => {
    const r = evaluateReplayHealth(
      figures({
        cap_mb: 500,
        cap_hit_at: new Date('2026-10-10T09:14:00Z'),
        cap_top_route: { route: '/content/orders/:id', bytes: 300 * 1_048_576 },
        recordings_24h: 0
      }),
      NOW
    )
    expect(r.status).toBe('warn')
    expect(r.blockers).toHaveLength(1) // the cap explains the quiet day — no second warning
    expect(r.detail).toMatch(/cap of 500 MB was reached at 09:14 UTC on 2026-10-10/)
    expect(r.detail).toMatch(/\/content\/orders\/:id \(300 MB\)/)
  })

  it('warns when the oldest recording is past retention plus a day', () => {
    expect(
      evaluateReplayHealth(
        figures({ oldest_started_at: new Date(NOW.getTime() - 7.5 * 86_400_000) }),
        NOW
      ).status
    ).toBe('pass')
    const r = evaluateReplayHealth(
      figures({ oldest_started_at: new Date(NOW.getTime() - 12 * 86_400_000) }),
      NOW
    )
    expect(r.status).toBe('warn')
    expect(r.detail).toMatch(/oldest recording is 12 days old; retention is 7 days/)
    expect(r.detail).toMatch(/retention purge is not running/)
  })

  it('lists every warning and leads with the first', () => {
    const r = evaluateReplayHealth(
      figures({
        uploads: uploads({ rejected_closed: 200 }),
        oldest_started_at: new Date(NOW.getTime() - 30 * 86_400_000)
      }),
      NOW
    )
    expect(r.blockers).toHaveLength(2)
    expect(r.detail).toMatch(/\(\+1 more\)$/)
    expect(r.blockers?.[0]).toMatch(/posted to a recording already ended \(409\)/)
  })
})
