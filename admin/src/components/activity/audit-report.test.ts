import { describe, expect, it } from 'vitest'
import {
  actionBreakdown,
  actionsPhrase,
  activePreset,
  burstKind,
  describeFilters,
  effectiveFilters,
  PERMISSION_COLLECTIONS,
  presetFilters,
  splitReads,
  summaryPhrases
} from './audit-report'

const names: Record<string, string> = { workflows: 'Workflows', invoices: 'Invoices' }
const ctx = {
  collectionName: (c: string) => names[c] ?? c,
  showReads: false,
  formatDay: (d: string) => d.slice(0, 10)
}

describe('reads are hidden by default', () => {
  it('adds read to the excluded actions unless shown or asked for', () => {
    expect(effectiveFilters({ range: 'last_7_days' }, false)).toEqual({
      range: 'last_7_days',
      exclude_actions: ['read']
    })
    expect(effectiveFilters({ range: 'last_7_days' }, true)).toEqual({ range: 'last_7_days' })
    expect(effectiveFilters({ actions: ['read'] }, false)).toEqual({ actions: ['read'] })
    expect(effectiveFilters({ exclude_actions: ['login', 'read'] }, false)).toEqual({
      exclude_actions: ['login', 'read']
    })
  })

  it('splits a stored filter set back into filters + the switch', () => {
    expect(splitReads({ exclude_actions: ['read'], range: 'today' })).toEqual({
      filters: { range: 'today' },
      showReads: false
    })
    expect(splitReads({ exclude_actions: ['login', 'read'] })).toEqual({
      filters: { exclude_actions: ['login'] },
      showReads: false
    })
    expect(splitReads({ range: 'today' })).toEqual({ filters: { range: 'today' }, showReads: true })
  })
})

describe('quick views → filters', () => {
  const pctx = { me: 'me-1', actions: ['create', 'import-complete', 'import_failed', 'update'] }

  it('maps every quick view to plain filters', () => {
    expect(presetFilters('last_7_days', pctx)).toEqual({ range: 'last_7_days' })
    expect(presetFilters('permissions', pctx)).toEqual({
      collections: PERMISSION_COLLECTIONS,
      range: 'last_30_days'
    })
    expect(presetFilters('deletes', pctx)).toEqual({ actions: ['delete'], range: 'last_30_days' })
    expect(presetFilters('imports', pctx)).toEqual({
      actions: ['import-complete', 'import_failed'],
      range: 'last_30_days'
    })
    expect(presetFilters('mine', pctx)).toEqual({ user: 'me-1', range: 'last_7_days' })
  })

  it('falls back to known import actions and skips By me when signed out', () => {
    expect(presetFilters('imports', { me: null })?.actions).toContain('import-complete')
    expect(presetFilters('mine', { me: null })).toBeNull()
  })

  it('recognises the active quick view', () => {
    expect(activePreset({ range: 'last_7_days', user: 'me-1' }, pctx)).toBe('mine')
    expect(activePreset({ actions: ['delete'], range: 'last_30_days' }, pctx)).toBe('deletes')
    expect(activePreset({ actions: ['delete'], range: 'today' }, pctx)).toBeNull()
  })
})

describe('the one-line summary of what is shown', () => {
  it('reads the example sentence', () => {
    expect(
      describeFilters(
        {
          actions: ['update', 'delete'],
          collections: ['workflows'],
          user: 'u1',
          range: 'last_7_days'
        },
        { ...ctx, personName: 'Pat' },
        128
      )
    ).toBe('Updates and deletes in Workflows by Pat, last 7 days — 128 entries')
  })

  it('says reads are left out, and names you, dates and words', () => {
    expect(describeFilters({ range: 'today' }, ctx, 1)).toBe(
      'All activity except reads, today — 1 entry'
    )
    expect(
      describeFilters({ user: 'me', q: 'refund' }, { ...ctx, isMe: true, showReads: true })
    ).toBe('All activity by you mentioning “refund”, any time')
    expect(
      describeFilters(
        { from: '2026-10-01', to: '2026-10-07', collections: ['a', 'b', 'c', 'd'] },
        { ...ctx, showReads: true }
      )
    ).toBe('All activity in 4 collections, 2026-10-01 to 2026-10-07')
    expect(describeFilters({ actions: ['transition'], from: '2026-10-01' }, ctx)).toBe(
      'Moves, since 2026-10-01'
    )
  })

  it('folds many kinds of action into a count', () => {
    expect(actionsPhrase(['create', 'update', 'delete', 'login', 'export'])).toBe(
      '5 kinds of activity'
    )
    expect(actionsPhrase(['import-complete'])).toBe('Import complete')
  })
})

describe('the totals in words', () => {
  const summary = {
    total_events: 128,
    by_action: [
      { action: 'update', count: 80 },
      { action: 'delete', count: 1 },
      { action: 'create', count: 30 },
      { action: 'login', count: 10 },
      { action: 'export', count: 4 },
      { action: 'comment', count: 3 }
    ],
    by_collection: [
      { collection: 'workflows', count: 90 },
      { collection: 'invoices', count: 38 }
    ],
    by_user: [
      { user_id: 'u1', first_name: 'Pat', last_name: 'Lee', email: null, count: 70 },
      ...['u2', 'u3', 'u4', 'u5', 'u6'].map((id) => ({
        user_id: id,
        first_name: null,
        last_name: null,
        email: null,
        count: 10
      })),
      { user_id: null, first_name: null, last_name: null, email: null, count: 8 }
    ],
    largest_burst: { group_key: 'import_run:7', count: 40, action: 'update', collection: null }
  }

  it('reads as phrases', () => {
    expect(summaryPhrases(summary, { collectionName: ctx.collectionName })).toEqual([
      '128 entries by 6 people and automations',
      '40 updates in one import',
      'most active: Workflows',
      'Pat Lee did the most (70)'
    ])
  })

  it('says nothing for an empty window and handles one collection', () => {
    expect(summaryPhrases({ ...summary, total_events: 0 }, { collectionName: String })).toEqual([])
    const one = summaryPhrases(
      {
        ...summary,
        by_collection: [{ collection: 'invoices', count: 128 }],
        by_user: [summary.by_user[0]],
        largest_burst: null
      },
      { collectionName: ctx.collectionName }
    )
    expect(one).toEqual(['128 entries by 1 person', 'all in Invoices'])
  })

  it('breaks down the top kinds of action', () => {
    expect(actionBreakdown(summary)).toBe(
      '80 updates · 1 delete · 30 creates · 10 sign-ins · 7 other'
    )
  })

  it('names what wrote a burst', () => {
    expect(burstKind('import_job:9')).toBe('import')
    expect(burstKind('flow_run:3')).toBe('automation run')
    expect(burstKind('cron:x')).toBe('scheduled job')
    expect(burstKind('mcp:abc')).toBe('assistant request')
    expect(burstKind('bulk:1')).toBe('bulk change')
  })
})
