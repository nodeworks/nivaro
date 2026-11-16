import { describe, expect, it } from 'vitest'
import { envRefreshSummary, fmtSize, keptWhat } from './env-refresh-card'

const envName = (k: string) => ({ production: 'Production', staging: 'Staging' })[k] ?? k
const base = {
  available: true,
  rollback_runbook: 'env-rollback',
  directions: [
    { key: 'production-to-staging', from: 'production', to: 'staging', fresh_dry_run: null }
  ]
}

describe('environment refresh card', () => {
  it('words what a kept item puts back', () => {
    expect(keptWhat({ kind: 'table', rows: 3, columns: [], table: 't' })).toBe(
      'The whole table — 3 rows'
    )
    expect(
      keptWhat({ kind: 'columns', rows: 1, columns: ['a', 'b'], table: 'nivaro_settings' })
    ).toBe('2 fields of the settings row')
    expect(
      keptWhat({ kind: 'columns', rows: 7, columns: ['a'], table: 'nivaro_external_apis' })
    ).toBe('1 field on 7 rows, matched by name')
    expect(
      keptWhat({ kind: 'delegate', rows: 0, columns: [], table: 't', note: 'kept by x' })
    ).toBe('kept by x')
  })

  it('summarises a running refresh, a failed one, a rollback window, else the directions', () => {
    const running = envRefreshSummary(
      {
        ...base,
        active: {
          id: '1',
          extension: 'e',
          runbook: 'env-refresh',
          mode: 'go',
          target: 'production-to-staging',
          state: 'running',
          host: 'h',
          started_at: ''
        }
      },
      envName
    )
    expect(running).toMatchObject({ text: 'Refreshing Staging — running', attention: true })
    const failed = envRefreshSummary(
      {
        ...base,
        runs: [
          {
            id: '1',
            extension: 'e',
            runbook: 'env-refresh',
            mode: 'go',
            target: 'production-to-staging',
            state: 'failed',
            failed_step: 'keep',
            host: null,
            started_at: ''
          }
        ]
      },
      envName
    )
    expect(failed).toMatchObject({ tone: 'bad', text: 'The last refresh stopped at keep' })
    const now = Date.parse('2026-11-16T12:00:00Z')
    const window = envRefreshSummary(
      {
        ...base,
        rollback: [{ target: 'staging', until: '2026-11-17T09:00:00Z', fresh_dry_run: null }]
      },
      envName,
      now
    )
    expect(window.text).toMatch(/^Staging refreshed — roll back possible until/)
    expect(envRefreshSummary(base, envName).text).toBe('Production → Staging')
  })

  it('sizes', () => {
    expect(fmtSize(512)).toBe('512 MB')
    expect(fmtSize(46_000)).toBe('44.9 GB')
    expect(fmtSize(null)).toBe('')
  })
})
