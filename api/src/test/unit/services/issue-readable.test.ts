import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  humanizeName,
  placeOf,
  readableIssue,
  readableTime
} from '../../../services/issue-readable.js'

const API_TWIN = path.join(import.meta.dirname, '../../../services/issue-readable.ts')
const ADMIN_TWIN = path.join(
  import.meta.dirname,
  '../../../../../admin/src/pages/issues/issue-readable.ts'
)

// 2026-11-18 10:00 Eastern
const NOW = Date.parse('2026-11-18T15:00:00Z')
const ET = { timeZone: 'America/New_York', now: NOW }

describe('issue-readable', () => {
  it('is byte-identical to the admin twin', () => {
    expect(readFileSync(API_TWIN, 'utf8')).toBe(readFileSync(ADMIN_TWIN, 'utf8'))
  })

  it('says a missed cron run with the job in words and local 12-hour times', () => {
    const r = readableIssue(
      {
        title:
          '[server] cron/miss: Cron "team-alerts" missed its expected run at 2026-11-18T05:50:00.000Z (last ran 2026-11-18T04:50:00.123Z)'
      },
      ET
    )
    expect(r?.kind).toBe('cron-miss')
    expect(r?.title).toBe(
      'Scheduled job "Team alerts" didn\'t run at 12:50 AM (last ran 11:50 PM yesterday)'
    )
    expect(r?.place).toBe('Scheduled job')
    expect(r?.description).toMatch(/Open Jobs/)
  })

  it('strips the extension prefix from a job id', () => {
    const r = readableIssue(
      {
        title:
          '[server] cron/miss: Cron "ext:efp-ops:forecast-watch-scan" missed its expected run at 2026-11-18T14:30:00.000Z (never recorded)'
      },
      ET
    )
    expect(r?.title).toBe(
      'Scheduled job "Forecast watch scan" didn\'t run at 9:30 AM (no earlier run recorded)'
    )
    expect(humanizeName('ext:efp-ops:forecast-watch-scan')).toBe('Forecast watch scan')
  })

  it('names the zone for text read outside the app', () => {
    expect(readableTime('2026-11-18T05:50:00Z', { ...ET, zoneName: true })).toBe('12:50 AM EST')
    expect(readableTime('2026-11-10T05:50:00Z', ET)).toBe('12:50 AM on Nov 10')
    expect(readableTime('2025-11-10T05:50:00Z', ET)).toBe('12:50 AM on Nov 10, 2025')
  })

  it('reads rollup drift with metadata labels, falling back to the ids in words', () => {
    const title = 'Rollup drift: inventory_request.mdsi_units_shipped (35/500 rows stale)'
    const labelled = readableIssue(
      { title },
      {
        labels: {
          collection: (c) => (c === 'inventory_request' ? 'Inventory requests' : null),
          field: (_c, f) => (f === 'mdsi_units_shipped' ? 'MDSi units shipped' : null)
        }
      }
    )
    expect(labelled?.title).toBe(
      'Stored total "MDSi units shipped" on Inventory requests is out of date for 35 of 500 sampled records'
    )
    expect(labelled?.names).toEqual({
      collections: ['inventory_request'],
      fields: [{ collection: 'inventory_request', field: 'mdsi_units_shipped' }]
    })
    expect(readableIssue({ title })?.title).toBe(
      'Stored total "Mdsi units shipped" on Inventory request is out of date for 35 of 500 sampled records'
    )
  })

  it('re-reads a newer row from its details Message line, keeping the stored summary', () => {
    const r = readableIssue(
      {
        title: 'Scheduled job "Team alerts" didn\'t run at 12:50 AM EST (last ran 11:50 PM EST)',
        details: [
          'Route: cron/miss',
          'Summary: Stored words.',
          'Message: Cron "team-alerts" missed its expected run at 2026-11-18T05:50:00.000Z (last ran 2026-11-18T04:50:00.123Z)'
        ].join('\n')
      },
      { timeZone: 'America/Los_Angeles', now: NOW }
    )
    expect(r?.title).toBe(
      'Scheduled job "Team alerts" didn\'t run at 9:50 PM yesterday (last ran 8:50 PM yesterday)'
    )
    expect(r?.description).toBe('Stored words.')
  })

  it('covers the other server shapes', () => {
    const t = (title: string) => readableIssue({ title }, ET)?.title
    expect(
      t(
        '[server] cron/watchdog: Cron "outside-write-watch" tick skipped — the previous tick has been running for 1 minute(s)'
      )
    ).toBe(
      'Scheduled job "Outside write watch" skipped a run: the last one was still going after 1 minute'
    )
    expect(
      t(
        '[server] cron/watchdog: Cron "nightly" has been running for over 15 minutes — likely hung (its work has stopped happening)'
      )
    ).toBe('Scheduled job "Nightly" has been running for over 15 minutes and may be stuck')
    expect(
      t(
        '[server] deadlock-sweep: SQL deadlock at 2026-11-18T12:39:15.000Z — victim statement: Proc [Database Id = 5]'
      )
    ).toBe('Two database updates blocked each other at 7:39 AM')
    expect(
      t(
        '[server] pool-monitor: DB connection pool under pressure: p95 acquire wait 1200ms, every connection busy 40% of the last 300s (peak 60/60 in use, 12 waiting)'
      )
    ).toBe('The app ran short of database connections: all were busy 40% of the time')
    expect(
      t(
        '[server] restart-impact: Restart interrupted 2 running job(s): team-alerts, ext:efp-ops:fusion-pull — re-run the ones that matter from /background-jobs'
      )
    ).toBe('A restart stopped 2 scheduled jobs part-way: Team alerts, Fusion pull')
    expect(
      t(
        '[server] dead-link-sweep: 3 record link(s) point at deleted records and could not be removed (ids: 1, 2, 3)'
      )
    ).toBe('3 record links still point at deleted records')
    expect(t('[server] oidc-callback: OIDC callback failed: invalid_grant')).toBe(
      'Microsoft sign-in failed'
    )
  })

  it('leaves unknown titles alone', () => {
    expect(readableIssue({ title: '[server] GET /api/items/:collection: boom' })).toBeNull()
    expect(readableIssue({ title: 'The save button does nothing' })).toBeNull()
    // a route that is not the shape's own does not match it
    expect(
      readableIssue({ title: '[server] GET /api/x: SQL deadlock at 2026-11-18T12:39:15.000Z' })
    ).toBeNull()
  })

  it('words a route', () => {
    expect(placeOf('cron/miss')).toBe('Scheduled job')
    expect(placeOf('GET /api/items/:collection')).toBe('Server request')
    expect(placeOf('/collections/x/5')).toBe('Screen')
    expect(placeOf('something-else')).toBeNull()
  })
})
