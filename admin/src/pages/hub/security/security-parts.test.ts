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

  it('takes any other source, with counts at the top level (Snyk)', () => {
    const rows = sourceRows({
      repositories: [ecr],
      sources: [
        {
          source: 'snyk',
          connection_id: 9,
          name: 'Acme org',
          critical: 0,
          high: 2,
          medium: 0,
          low: 4,
          fixable: 3,
          projects: 12,
          unmonitored: 1
        },
        { source: 'trivy-cloud', name: 'Nightly', counts: { high: 1, exotic: 2 } },
        { name: 'no source' },
        'junk'
      ]
    })
    expect(rows.map((r) => r.source)).toEqual(['ecr', 'snyk', 'trivy-cloud'])
    const snyk = rows[1]
    expect(snyk.counts).toEqual([
      { severity: 'high', n: 2 },
      { severity: 'low', n: 4 }
    ])
    expect(snyk.fixable).toBe(3)
    expect(snyk.detail).toBe('12 projects')
    // An unknown severity is kept, after the known ones.
    expect(rows[2].counts).toEqual([
      { severity: 'high', n: 1 },
      { severity: 'exotic', n: 2 }
    ])
    expect(sourceLabel('ecr')).toBe('Amazon ECR')
    expect(sourceLabel('snyk')).toBe('Snyk')
    expect(sourceLabel('trivy-cloud')).toBe('Trivy cloud')
    expect(bySource(rows).map((g) => g.source)).toEqual(['ecr', 'snyk', 'trivy-cloud'])
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
      scanSummary(sourceRows({ repositories: [clean], sources: [{ source: 'snyk', low: 1 }] }))
    ).toBe(
      'Nothing critical or high in the 2 read. Read live from Amazon ECR and Snyk through their connections.'
    )
    // A repository name is shown as code; an organisation name is not.
    const rows = sourceRows({ repositories: [ecr], sources: [{ source: 'snyk', name: 'Acme' }] })
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
