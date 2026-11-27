import { describe, expect, it } from 'vitest'
import { whereWords } from './HubSourceFindingsCard'
import { codeWords, untilWords } from './security-parts'
import {
  bySource,
  scanSummary,
  sourceLabel,
  sourceRows,
  statusWords,
  urgentRows
} from './source-findings'

describe('security tab words', () => {
  it('says how long until a grant ends', () => {
    const now = Date.parse('2026-11-25T12:00:00Z')
    expect(untilWords('2026-11-25T12:40:00Z', now)).toBe('in 40 min')
    expect(untilWords('2026-11-25T15:10:00Z', now)).toBe('in 3 h 10 min')
    expect(untilWords('2026-11-25T14:00:00Z', now)).toBe('in 2 h')
    expect(untilWords('2026-11-29T12:00:00Z', now)).toBe('in 4 days')
    expect(untilWords('2026-11-25T11:00:00Z', now)).toBe('now')
  })

  it('turns check and link codes into words, never a raw unknown code', () => {
    expect(codeWords('ENOTFOUND')).toBe('No DNS record')
    expect(codeWords('ERR_TLS_CERT_ALTNAME_INVALID')).toBe('Certificate is for another name')
    expect(codeWords('SOMETHING_ELSE', 'it did not answer')).toBe('it did not answer')
    expect(codeWords(null)).toBe('error')
  })
})

// Task 33b: provider sources in the Security tab — ECR repositories (Task 33's answer) and any
// other source the answer carries (Snyk from Task 43), never hard-coded.

const ecr = {
  source: 'ecr',
  resource_id: 4,
  name: 'shop-api',
  app_id: 2,
  environment_id: 7,
  image: 'shop-api:0.3.215',
  digest: 'sha256:0123456789abcdef0123',
  pushed_at: '2026-11-26T10:00:00Z',
  scan_status: 'COMPLETE',
  counts: { critical: 1, high: 0, medium: 3, low: 2, informational: 5, undefined: 0 }
}

describe('provider source rows', () => {
  it('reads ECR repositories: worst first, zero counts left out', () => {
    const [r] = sourceRows({ repositories: [ecr] })
    expect(r).toMatchObject({
      source: 'ecr',
      name: 'shop-api',
      app_id: 2,
      environment_id: 7,
      detail: 'shop-api:0.3.215@sha256:0123456789ab',
      atWord: 'pushed',
      status: 'COMPLETE'
    })
    expect(r.counts).toEqual([
      { severity: 'critical', n: 1 },
      { severity: 'medium', n: 3 },
      { severity: 'low', n: 2 },
      { severity: 'informational', n: 5 }
    ])
    expect(statusWords(r.status)).toBe('Scanned')
    expect(urgentRows([r])).toHaveLength(1)
  })

  it('a repository it could not read keeps its reason and no counts', () => {
    const [r] = sourceRows({
      repositories: [{ ...ecr, counts: null, scan_status: null, error: 'Access denied' }]
    })
    expect(r.counts).toBeNull()
    expect(r.error).toBe('Access denied')
  })

  it('reads every source in repositories, but leaves Task 43’s snyk list to its own card', () => {
    // The real Task 43 answer: `snyk` per connection (totals + projects). HubSnykFindings
    // renders it; turning it into rows here would show Snyk twice.
    const snyk = [
      {
        connection_id: 9,
        name: 'Acme engineering',
        read_at: '2026-11-27T07:50:00Z',
        ok: true,
        error: null,
        totals: {
          critical: 0,
          high: 3,
          medium: 8,
          low: 12,
          fixable: 6,
          projects: 14,
          unmonitored: 1
        },
        projects: [
          {
            id: 'p1',
            name: 'acme/web',
            project_type: 'npm',
            monitored: true,
            critical: 0,
            high: 3,
            medium: 8,
            low: 12,
            fixable: 6
          }
        ]
      }
    ]
    const rows = sourceRows({
      repositories: [
        ecr,
        { source: 'gcr', name: 'web', counts: { high: 1, exotic: 2 } },
        { name: 'no source' },
        'junk'
      ],
      snyk
    })
    expect(rows.map((r) => r.source)).toEqual(['ecr', 'gcr'])
    // An unknown severity is kept, after the known ones.
    expect(rows[1].counts).toEqual([
      { severity: 'high', n: 1 },
      { severity: 'exotic', n: 2 }
    ])
    expect(sourceRows({ snyk })).toEqual([])
    expect(sourceLabel('ecr')).toBe('Amazon ECR')
    expect(sourceLabel('artifact-registry')).toBe('Artifact registry')
    expect(bySource(rows).map((g) => g.source)).toEqual(['ecr', 'gcr'])
  })

  it('sums up without calling an unread row clean', () => {
    const bad = { ...ecr, counts: null, error: 'Access denied' }
    expect(scanSummary(sourceRows({ repositories: [bad] }))).toBe(
      'None could be read: see why below. Read live from Amazon ECR through their connections.'
    )
    expect(scanSummary(sourceRows({ repositories: [ecr, bad] }))).toBe(
      '1 of 2 with critical or high findings. 1 could not be read. Read live from Amazon ECR through their connections.'
    )
    const clean = { ...ecr, counts: { critical: 0, high: 0, medium: 1 } }
    expect(
      scanSummary(sourceRows({ repositories: [clean, { source: 'gcr', name: 'web', low: 1 }] }))
    ).toBe(
      'Nothing critical or high in the 2 read. Read live from Amazon ECR and Gcr through their connections.'
    )
    // A repository or image name is shown as code; a plain label is not.
    const rows = sourceRows({ repositories: [ecr, { source: 'gcr', name: 'Acme' }] })
    expect(rows.map((r) => r.mono)).toEqual([true, false])
  })

  it('an answer with no sources gives no rows (the card stays hidden)', () => {
    expect(sourceRows({ images: [], findings: [] })).toEqual([])
    expect(sourceRows(undefined)).toEqual([])
  })

  it('names where a row belongs', () => {
    const envs = [
      {
        environment_id: 7,
        env_key: 'staging',
        app_id: 2,
        app_key: 'shop',
        app_name: 'Shop',
        position: 0
      }
    ]
    expect(whereWords({ app_id: 2, environment_id: 7 }, envs)).toBe('Shop · staging')
    expect(whereWords({ app_id: 2, environment_id: null }, envs)).toBe('Shop')
    expect(whereWords({ app_id: null, environment_id: null }, envs)).toBe('Shared')
  })
})
