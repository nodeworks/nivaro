import { describe, expect, it } from 'vitest'
import {
  connectionBody,
  duplicateLabels,
  featureLockReason,
  formOf,
  isNewLabel,
  needsTokenForNewUrl,
  TOKEN_MASK,
  type TrackerConnection,
  trackerKeys,
  WEBHOOK_CHECK_MS,
  webhookCheckVerdict,
  webhookSilent
} from './api'

const conn = (over: Partial<TrackerConnection> = {}): TrackerConnection =>
  ({
    id: 4,
    name: 'GitLab',
    provider: 'gitlab',
    base_url: 'https://gitlab.example.com',
    default_project_id: 12,
    default_project_path: 'team/app',
    is_active: true,
    status: 'ok',
    last_ok_at: null,
    last_error: null,
    last_webhook_at: null,
    last_reconcile_at: null,
    token_set: true,
    sync: {} as TrackerConnection['sync'],
    ...over
  }) as TrackerConnection

describe('featureLockReason', () => {
  it('locks the switch for env and cloud, with the reason', () => {
    expect(featureLockReason({ enabled: true, source: 'env' })).toMatch(/ISSUE_TRACKERS/)
    expect(featureLockReason({ enabled: false, source: 'cloud' })).toMatch(/cloud mode/)
  })
  it('leaves it free for a stored setting or the default', () => {
    expect(featureLockReason({ enabled: true, source: 'setting' })).toBeNull()
    expect(featureLockReason({ enabled: false, source: 'default' })).toBeNull()
    expect(featureLockReason(undefined)).toBeNull()
  })
})

describe('connectionBody — the token', () => {
  it('never re-sends the mask of a saved token', () => {
    const c = conn()
    const form = formOf(c)
    expect(form.token).toBe(TOKEN_MASK)
    expect(connectionBody({ ...form, name: 'Ops GitLab' }, c)).toEqual({ name: 'Ops GitLab' })
  })
  it('never sends an emptied token box', () => {
    const c = conn()
    expect(connectionBody({ ...formOf(c), token: '  ' }, c)).toEqual({})
  })
  it('sends a newly typed token', () => {
    const c = conn()
    expect(connectionBody({ ...formOf(c), token: 'glpat-new' }, c)).toEqual({ token: 'glpat-new' })
  })
  it('creates with the token when one was typed, not the mask', () => {
    const body = connectionBody(
      { ...formOf(null), base_url: 'https://gl.test', token: 'glpat-1' },
      null
    )
    expect(body).toMatchObject({ name: 'GitLab', base_url: 'https://gl.test', token: 'glpat-1' })
    expect(connectionBody({ ...formOf(null), token: TOKEN_MASK }, null)).not.toHaveProperty('token')
  })
  it('sends the project id and path together', () => {
    const c = conn()
    expect(
      connectionBody({ ...formOf(c), default_project_id: 99, default_project_path: 'ops/infra' }, c)
    ).toEqual({ default_project_id: 99, default_project_path: 'ops/infra' })
  })
  it('a trailing slash on the same address is no change', () => {
    const c = conn()
    expect(connectionBody({ ...formOf(c), base_url: 'https://gitlab.example.com/' }, c)).toEqual({})
  })
})

describe('needsTokenForNewUrl', () => {
  it('asks for the token again when the origin changes', () => {
    const c = conn()
    expect(needsTokenForNewUrl({ ...formOf(c), base_url: 'https://other.example.com' }, c)).toBe(
      true
    )
    expect(
      needsTokenForNewUrl(
        { ...formOf(c), base_url: 'https://other.example.com', token: 'glpat-x' },
        c
      )
    ).toBe(false)
    expect(needsTokenForNewUrl({ ...formOf(c), base_url: 'https://gitlab.example.com/x' }, c)).toBe(
      false
    )
  })
})

describe('duplicateLabels', () => {
  it('finds a label used twice across priority and lane maps, case-insensitively', () => {
    expect(
      duplicateLabels(
        { low: 'P4', medium: 'P3', high: 'p3' },
        { open: 'Doing', in_progress: 'doing', resolved: 'Done' }
      )
    ).toEqual(['P3', 'Doing'])
  })
  it('is empty when every label is distinct or blank', () => {
    expect(duplicateLabels({ low: 'P4', high: '' }, { open: undefined, closed: 'Done' })).toEqual(
      []
    )
  })
})

describe('isNewLabel', () => {
  const known = [{ name: 'bug', color: '#f00', description: null }]
  it('marks names GitLab does not have', () => {
    expect(isNewLabel('Bug', known)).toBe(false)
    expect(isNewLabel('needs-triage', known)).toBe(true)
  })
  it('says nothing while the labels are unknown', () => {
    expect(isNewLabel('anything', undefined)).toBe(false)
  })
})

describe('webhookCheckVerdict', () => {
  const click = Date.parse('2026-11-17T15:00:00.000Z')
  const before = '2026-11-17T10:00:00.000Z'
  it('counts only a delivery newer than the one read at the click', () => {
    expect(webhookCheckVerdict(before, before, click, click + 5000)).toBe('waiting')
    expect(webhookCheckVerdict('2026-11-17T09:00:00.000Z', before, click, click + 5000)).toBe(
      'waiting'
    )
    expect(webhookCheckVerdict('2026-11-17T10:00:01.000Z', before, click, click + 5000)).toBe(
      'arrived'
    )
  })
  it('never compares with the browser clock', () => {
    // The server clock runs 5 minutes behind the browser: still a new delivery.
    expect(webhookCheckVerdict('2026-11-17T14:55:00.000Z', before, click, click + 3000)).toBe(
      'arrived'
    )
    // Never seen before the click: the first delivery counts.
    expect(webhookCheckVerdict('2026-11-17T08:00:00.000Z', null, click, click + 3000)).toBe(
      'arrived'
    )
    expect(webhookCheckVerdict(null, null, click, click + 3000)).toBe('waiting')
  })
  it('gives up after 30 s', () => {
    expect(webhookCheckVerdict(before, before, click, click + WEBHOOK_CHECK_MS - 1)).toBe('waiting')
    expect(webhookCheckVerdict(before, before, click, click + WEBHOOK_CHECK_MS)).toBe('timeout')
    // a late arrival still wins
    expect(webhookCheckVerdict('2026-11-17T11:00:00.000Z', before, click, click + 40_000)).toBe(
      'arrived'
    )
  })
})

describe('webhookSilent', () => {
  const now = Date.parse('2026-11-17T15:00:00.000Z')
  it('is silent when never seen or not seen in 24 h', () => {
    expect(webhookSilent(null, now)).toBe(true)
    expect(webhookSilent('2026-11-16T14:59:00.000Z', now)).toBe(true)
    expect(webhookSilent('2026-11-16T15:01:00.000Z', now)).toBe(false)
  })
})

describe('trackerKeys', () => {
  it('namespaces every key under trackers', () => {
    for (const key of [
      trackerKeys.feature(),
      trackerKeys.connections(),
      trackerKeys.health(1),
      trackerKeys.outbox(1, 'dead'),
      trackerKeys.projects(1, 'x'),
      trackerKeys.labels(1, 2),
      trackerKeys.rules(),
      trackerKeys.preview('x', 7),
      trackerKeys.explain(5),
      trackerKeys.templateVars('ticket')
    ])
      expect(key[0]).toBe('trackers')
  })
})
