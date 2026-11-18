import { describe, expect, it } from 'vitest'
import { issueDisplay, issueLabelRequest, labelLookup } from './issue-display'

describe('issueDisplay', () => {
  it('reads a missed cron run in words, the route kept for support only', () => {
    const d = issueDisplay({
      title:
        '[server] cron/miss: Cron "ext:efp-ops:forecast-watch-scan" missed its expected run at 2026-11-18T05:50:00.000Z (last ran 2026-11-18T04:50:00.123Z)'
    })
    expect(d.title).toMatch(
      /^Scheduled job "Forecast watch scan" didn't run at \d{1,2}:\d{2} [AP]M/
    )
    expect(d.title).not.toMatch(/2026-11-18T|ext:|forecast-watch-scan/)
    expect(d.place).toBe('Scheduled job')
    expect(d.where).toBe('cron/miss')
    expect(d.description).toMatch(/Open Jobs/)
  })

  it('reads a newer row stored in words through its details', () => {
    const d = issueDisplay({
      title: 'Scheduled job "Team alerts" didn\'t run at 12:50 AM EST (last ran 11:50 PM EST)',
      details:
        'Route: cron/miss\nSummary: It was due.\nMessage: Cron "team-alerts" missed its expected run at 2026-11-18T05:50:00.000Z (last ran 2026-11-18T04:50:00.123Z)'
    })
    expect(d.kind).toBe('cron-miss')
    expect(d.description).toBe('It was due.')
    expect(d.where).toBe('cron/miss')
    expect(d.place).toBe('Scheduled job')
  })

  it('keeps an unknown title as parseIssueTitle reads it, the place in words', () => {
    const d = issueDisplay({
      title:
        "[server] GET /api/items/:collection: select top (@p0) [id] from [x] - Ambiguous column name 'id'."
    })
    expect(d.title).toBe("Ambiguous column name 'id'.")
    expect(d.description).toBeNull()
    expect(d.place).toBe('Server request')
    expect(d.where).toBe('GET /api/items/:collection')
    expect(d.kind).toBeNull()
  })

  it('ignores Summary / Message lines outside the server header and on browser reports', () => {
    const stacked = issueDisplay({
      title: '[server] GET /api/x: boom',
      source: 'server',
      details:
        'Route: GET /api/x\nRequest context: {}\nSummary: pwned\n\nMessage: Cron "x" missed its expected run at 2026-11-18T05:50:00.000Z (never recorded)'
    })
    expect(stacked.title).toBe('Boom')
    expect(stacked.description).toBeNull()
    const browser = issueDisplay({
      title: '[client] /queues/12: boom',
      source: 'client',
      details: 'Route: /queues/:id\nSummary: pwned'
    })
    expect(browser.title).toBe('Boom')
    expect(browser.description).toBeNull()
    expect(browser.place).toBeNull()
  })

  it('names the record collection in words for manual issues', () => {
    const d = issueDisplay(
      { title: 'Save does nothing', collection: 'inventory_request' },
      {
        labels: labelLookup({
          collections: { inventory_request: { plural: 'Inventory requests' } }
        })
      }
    )
    expect(d.title).toBe('Save does nothing')
    expect(d.collectionName).toBe('Inventory requests')
    expect(issueDisplay({ title: 'x', collection: 'inventory_request' }).collectionName).toBe(
      'Inventory request'
    )
  })

  it('asks for the names a page of issues uses, once each', () => {
    expect(
      issueLabelRequest([
        { title: 'Rollup drift: units.total_cost (1/500 rows stale)' },
        { title: 'Rollup drift: units.total_cost (2/500 rows stale)' },
        { title: 'Save does nothing', collection: 'workflows' },
        { title: '[server] GET /api/x: boom' }
      ])
    ).toEqual({
      collections: ['units', 'workflows'],
      fields: [{ collection: 'units', field: 'total_cost' }]
    })
  })
})
