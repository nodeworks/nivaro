// SDK audit 2026-10-29: request shapes of the added commands, the client's hooks, errors,
// retries and request ids, and the realtime wire parser. Runs against the built dist:
// `pnpm run build && pnpm test`.
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import * as sdk from '../dist/index.js'

const { createNivaro, NivaroError, isNivaroError, parseRealtimeChanges } = sdk

/** A command's wire shape: method, path, params, body. */
const shape = (c) => ({ method: c._method, path: c._path, params: c._params, body: c._body })

describe('added commands — request shape', () => {
  const cases = [
    // records
    [
      sdk.readItem('orders', 5, { fields: ['id', 'owner.email'] }),
      'GET',
      '/items/orders/5',
      { fields: 'id,owner.email' },
      undefined
    ],
    [sdk.readItem('orders', 5), 'GET', '/items/orders/5', undefined, undefined],
    [
      sdk.rehearseUpdateItem('orders', 5, { status: 'x' }),
      'PATCH',
      '/items/orders/5',
      { dry_run: 1 },
      { status: 'x' }
    ],
    [
      sdk.checkItemFilter('orders', { a: { _eq: 1 } }),
      'GET',
      '/items/orders/filter-check',
      { filter: '{"a":{"_eq":1}}' },
      undefined
    ],
    [
      sdk.readItemBySlug('pages', 'about us', { fields: ['id'] }),
      'GET',
      '/items/pages/by-slug/about%20us',
      { fields: 'id' },
      undefined
    ],
    [
      sdk.readItemDistinct('orders', 'status', 50),
      'GET',
      '/items/orders/distinct',
      { field: 'status', limit: 50 },
      undefined
    ],
    [
      sdk.bulkUpdateItems('orders', [1, 2], { status: 'done' }, { by_form: true }),
      'POST',
      '/items/orders/bulk-update',
      undefined,
      { ids: [1, 2], data: { status: 'done' }, by_form: true }
    ],
    [
      sdk.bulkDeleteItems('orders', ['a']),
      'POST',
      '/items/orders/bulk-delete',
      undefined,
      { ids: ['a'] }
    ],
    [
      sdk.bulkTransitionItems('orders', [1], 'tx', 'ok'),
      'POST',
      '/items/orders/bulk-transition',
      undefined,
      { ids: [1], transition_id: 'tx', comment: 'ok' }
    ],
    [
      sdk.batchItems('orders', { create: [{ a: 1 }], update: [{ id: 2, a: 3 }] }),
      'POST',
      '/items/orders/batch',
      undefined,
      { create: [{ a: 1 }], update: [{ id: 2, a: 3 }] }
    ],
    [
      sdk.bulkWriteItems('orders', [{ a: 1 }], { atomic: true, returnIds: true }),
      'POST',
      '/items/orders/bulk',
      { return: 'ids' },
      { rows: [{ a: 1 }], atomic: true }
    ],
    [
      sdk.queueBulkWriteItems('orders', [{ a: 1 }]),
      'POST',
      '/items/orders/bulk',
      { async: 1 },
      { rows: [{ a: 1 }] }
    ],
    [sdk.readBulkRun('orders', 9), 'GET', '/items/orders/bulk/9', undefined, undefined],
    [
      sdk.listTrash({ collection: 'orders', days: 7, search: '' }),
      'GET',
      '/trash',
      { collection: 'orders', days: 7 },
      undefined
    ],
    [
      sdk.readRecordDeletion('orders', 5),
      'GET',
      '/trash/record',
      { collection: 'orders', item: 5 },
      undefined
    ],
    [sdk.restoreTrashItem(3), 'POST', '/trash/3/restore', undefined, undefined],
    [sdk.bulkRestoreTrash([1, 2]), 'POST', '/trash/bulk-restore', undefined, { ids: [1, 2] }],
    [sdk.purgeTrashItem(3), 'DELETE', '/trash/3', undefined, undefined],
    [sdk.readOwnerHistory('orders', 5), 'GET', '/owner-history/orders/5', undefined, undefined],
    [
      sdk.readCommentCounts('orders', [1, 2]),
      'GET',
      '/comments/counts',
      { collection: 'orders', ids: '1,2' },
      undefined
    ],
    [
      sdk.toggleCommentReaction('c1', '👍'),
      'POST',
      '/comments/c1/reactions',
      undefined,
      { emoji: '👍' }
    ],
    [
      sdk.toggleEntryReaction({ collection: 'o', item: 1, entry_key: 'k', emoji: '✅' }),
      'POST',
      '/comments/entry-reactions',
      undefined,
      { collection: 'o', item: 1, entry_key: 'k', emoji: '✅' }
    ],
    [sdk.readPipelineOutline('t1'), 'GET', '/pipelines/t1/outline', undefined, undefined],
    [sdk.readMyOwnerSeats(), 'GET', '/pipelines/my-seats', undefined, undefined],
    [sdk.logout(), 'POST', '/auth/logout', undefined, undefined],
    [sdk.logoutAll(), 'POST', '/auth/logout-all', undefined, undefined],
    [sdk.readWsToken(), 'GET', '/auth/ws-token', undefined, undefined],
    [sdk.readAuthProviders(), 'GET', '/auth/providers', undefined, undefined],
    // observability
    [sdk.readActivityEntry(7), 'GET', '/activity/7', undefined, undefined],
    [sdk.listActivityActions(), 'GET', '/activity/actions', undefined, undefined],
    [
      sdk.logExport({ collection: 'orders', row_count: 3, format: 'csv' }),
      'POST',
      '/activity/export-log',
      undefined,
      { collection: 'orders', row_count: 3, format: 'csv' }
    ],
    [
      sdk.createActivityEntry({ action: 'note', comment: 'x' }),
      'POST',
      '/activity',
      undefined,
      { action: 'note', comment: 'x' }
    ],
    [
      sdk.readChanges({ cursor: 'c1.x', collections: ['a', 'b'], limit: 10 }),
      'GET',
      '/changes',
      { cursor: 'c1.x', collections: 'a,b', limit: 10 },
      undefined
    ],
    [sdk.readJobRunLog(4, 10), 'GET', '/job-runs/4/log', { after: 10 }, undefined],
    [sdk.readJobRunLog(4), 'GET', '/job-runs/4/log', undefined, undefined],
    [sdk.cancelJobRun(4), 'POST', '/job-runs/4/cancel', undefined, undefined],
    [sdk.readBusyJobs(), 'GET', '/job-runs/busy', undefined, undefined],
    [sdk.listMyJobs(), 'GET', '/my-jobs', undefined, undefined],
    [
      sdk.estimateBackgroundRun('POST', '/api/custom-queries/q/execute'),
      'GET',
      '/background-runs/estimate',
      { method: 'POST', url: '/api/custom-queries/q/execute' },
      undefined
    ],
    [
      sdk.startBackgroundRun({ method: 'POST', url: '/api/x', body: { a: 1 } }),
      'POST',
      '/background-runs',
      undefined,
      { method: 'POST', url: '/api/x', body: { a: 1 } }
    ],
    [sdk.listBackgroundRuns(), 'GET', '/background-runs', undefined, undefined],
    [sdk.readBackgroundRun('r1'), 'GET', '/background-runs/r1', undefined, undefined],
    [sdk.readBackgroundRunResult('r1'), 'GET', '/background-runs/r1/result', undefined, undefined],
    [
      sdk.listApiRequests({ status: '5xx', inbound: true, errors: false, all_instances: true }),
      'GET',
      '/api-analytics/requests',
      { status: '5xx', inbound: 1, instances: 'all' },
      undefined
    ],
    [sdk.readApiAnalyticsByKey(48), 'GET', '/api-analytics/by-key', { hours: 48 }, undefined],
    [sdk.readApiKeyUsage(2), 'GET', '/api-keys/2/usage', undefined, undefined],
    [
      sdk.readApiKeyMonthlyUsage(2, '2026-10', 'csv'),
      'GET',
      '/api-keys/2/usage',
      { month: '2026-10', format: 'csv' },
      undefined
    ],
    [
      sdk.listMailLog({ status: 'failed', page: 2 }),
      'GET',
      '/mail-log',
      { status: 'failed', page: 2 },
      undefined
    ],
    [sdk.readMailLogEntry(5), 'GET', '/mail-log/5', undefined, undefined],
    [sdk.resendMail(5), 'POST', '/mail-log/5/resend', undefined, undefined],
    [sdk.readMailStats(7), 'GET', '/mail-log/stats', { days: 7 }, undefined],
    [sdk.listRecordMail('orders', 5), 'GET', '/mail-log/record/orders/5', undefined, undefined],
    [
      sdk.readNotificationHistory(50),
      'GET',
      '/users/me/notification-history',
      { limit: 50 },
      undefined
    ],
    [
      sdk.readLatestRevisionId('orders', 5),
      'GET',
      '/revisions',
      { collection: 'orders', item: 5, latest_only: 1 },
      undefined
    ],
    // inbox
    [
      sdk.snoozeNotification(3, { until: '2030-01-01T00:00:00Z' }),
      'POST',
      '/notifications/3/snooze',
      undefined,
      { until: '2030-01-01T00:00:00Z' }
    ],
    [
      sdk.snoozeNotification(3, { untilChange: true }),
      'POST',
      '/notifications/3/snooze',
      undefined,
      { until_change: true }
    ],
    [sdk.acknowledgeNotification(3), 'POST', '/notifications/3/acknowledge', undefined, undefined],
    [
      sdk.bulkNotificationAction({ action: 'read', filter: { unread: true, lane: 'fyi' } }),
      'POST',
      '/notifications/bulk-action',
      undefined,
      { action: 'read', filter: { unread: 'true', lane: 'fyi' } }
    ],
    [
      sdk.archiveReadNotifications(30),
      'POST',
      '/notifications/archive-read',
      undefined,
      { days: 30 }
    ],
    [
      sdk.listSentNotifications({ lane: 'all' }),
      'GET',
      '/notifications/sent',
      { lane: 'all' },
      undefined
    ],
    [sdk.readRecordMute('orders', 5), 'GET', '/notifications/mutes/orders/5', undefined, undefined],
    [
      sdk.toggleRecordMute('orders', 5),
      'POST',
      '/notifications/mutes/orders/5/toggle',
      undefined,
      undefined
    ],
    [sdk.listReminders(true), 'GET', '/reminders', { include_sent: 'true' }, undefined],
    [
      sdk.createReminder({ note: 'n', remind_at: '2030-01-01T00:00:00Z' }),
      'POST',
      '/reminders',
      undefined,
      { note: 'n', remind_at: '2030-01-01T00:00:00Z' }
    ],
    [sdk.updateReminder(1, { note: 'm' }), 'PATCH', '/reminders/1', undefined, { note: 'm' }],
    [sdk.deleteReminder(1), 'DELETE', '/reminders/1', undefined, undefined],
    [sdk.listSavedSearches(), 'GET', '/global-search/saved', undefined, undefined],
    [
      sdk.createSavedSearch({ name: 'n', q: 'x' }),
      'POST',
      '/global-search/saved',
      undefined,
      { name: 'n', q: 'x' }
    ],
    [sdk.deleteSavedSearch('a b'), 'DELETE', '/global-search/saved/a%20b', undefined, undefined],
    [
      sdk.readSearchCounts('pump', ['orders', 'assets']),
      'GET',
      '/global-search/counts',
      { q: 'pump', collections: 'orders,assets' },
      undefined
    ],
    [
      sdk.readSearchRecords('pump', 'orders', { offset: 25, limit: 25 }),
      'GET',
      '/global-search/records',
      { q: 'pump', collection: 'orders', offset: 25, limit: 25 },
      undefined
    ],
    [sdk.globalSearch('x', { labels: true }), 'GET', '/global-search', { q: 'x', labels: 1 }, undefined],
    // dashboards
    [
      sdk.createDashboard({ name: 'Ops' }),
      'POST',
      '/dashboards',
      undefined,
      { name: 'Ops' }
    ],
    [
      sdk.updateDashboard('d1', { global_filters: [] }),
      'PATCH',
      '/dashboards/d1',
      undefined,
      { global_filters: [] }
    ],
    [sdk.deleteDashboard('d1'), 'DELETE', '/dashboards/d1', undefined, undefined],
    [
      sdk.createDashboardWidget('d1', { type: 'count', title: 'Open', collection: 'orders' }),
      'POST',
      '/dashboards/d1/widgets',
      undefined,
      { type: 'count', title: 'Open', collection: 'orders' }
    ],
    [
      sdk.updateDashboardWidget('w1', { width: 2 }),
      'PATCH',
      '/dashboards/widgets/w1',
      undefined,
      { width: 2 }
    ],
    [sdk.deleteDashboardWidget('w1'), 'DELETE', '/dashboards/widgets/w1', undefined, undefined]
  ]
  for (const [command, method, path, params, body] of cases) {
    it(`${method} ${path}`, () => {
      assert.deepEqual(shape(command), { method, path, params, body })
    })
  }

  it('readItems sends the newer list params', () => {
    const c = sdk.readItems('orders', {
      search: 'x',
      search_fields: ['name', 'code'],
      search_rank: true,
      count: 'approx',
      labels: true
    })
    assert.deepEqual(c._params, {
      search: 'x',
      search_fields: 'name,code',
      search_rank: 1,
      count: 'approx',
      labels: 1
    })
  })

  it('listNotifications sends the filter params the route reads', () => {
    const c = sdk.listNotifications({
      status: 'archived',
      unread: true,
      search: 's',
      collection: 'orders',
      sender: 'u1',
      snoozed: true
    })
    assert.deepEqual(c._params, {
      status: 'archived',
      unread: 'true',
      search: 's',
      collection: 'orders',
      sender: 'u1',
      snoozed: 'true'
    })
  })
})

// ─── Client: hooks, errors, retries ───────────────────────────────────────────

/** A fetch that answers from a queue of { status, body, headers } and records each call. */
function scriptedFetch(answers) {
  const calls = []
  const fetch = async (url, init) => {
    calls.push({ url, init })
    const a = answers[Math.min(calls.length - 1, answers.length - 1)]
    if (a instanceof Error) throw a
    const headers = new Headers({ 'content-type': 'application/json', ...(a.headers ?? {}) })
    return {
      ok: a.status >= 200 && a.status < 300,
      status: a.status,
      statusText: a.statusText ?? '',
      headers,
      body: null,
      json: async () => a.body
    }
  }
  return { fetch, calls }
}

describe('client errors', () => {
  it('throws a NivaroError with status, code, request id and the body', async () => {
    const { fetch } = scriptedFetch([
      {
        status: 403,
        body: { error: 'Quota reached', code: 'QUOTA_EXCEEDED' },
        headers: { 'x-nivaro-request-id': 'req-1' }
      }
    ])
    const c = createNivaro('http://x', { fetch, token: 't' })
    const err = await c.request(sdk.readItem('orders', 1)).catch((e) => e)
    assert.ok(err instanceof NivaroError)
    assert.ok(err instanceof Error)
    assert.ok(isNivaroError(err))
    assert.equal(err.message, 'Quota reached')
    assert.equal(err.status, 403)
    assert.equal(err.code, 'QUOTA_EXCEEDED')
    assert.equal(err.requestId, 'req-1')
    assert.deepEqual(err.response, { error: 'Quota reached', code: 'QUOTA_EXCEEDED' })
    assert.equal(err.method, 'GET')
    assert.equal(err.path, '/items/orders/1')
  })

  it("reads Fastify's own error shape by its message, not its status phrase", async () => {
    const { fetch } = scriptedFetch([
      {
        status: 503,
        body: {
          statusCode: 503,
          error: 'Service Unavailable',
          message: 'The server is busy right now.',
          code: 'SERVER_BUSY'
        },
        headers: { 'retry-after': '5' }
      }
    ])
    const c = createNivaro('http://x', { fetch })
    const err = await c.request(sdk.readItem('orders', 1)).catch((e) => e)
    assert.equal(err.message, 'The server is busy right now.')
    assert.equal(err.code, 'SERVER_BUSY')
    assert.equal(err.retryAfterMs, 5000)
  })
})

describe('client hooks', () => {
  it('runs onRequest (headers editable), onResponse with the request id, and extra headers', async () => {
    const { fetch, calls } = scriptedFetch([
      { status: 200, body: { data: 1 }, headers: { 'x-nivaro-request-id': 'abc' } }
    ])
    const seen = []
    const c = createNivaro('http://x', {
      fetch,
      token: 't',
      headers: { 'x-nivaro-app': 'my-app' },
      onRequest: (info) => {
        info.headers['x-trace'] = 'tr-1'
        seen.push(['req', info.method, info.path, info.attempt])
      },
      onResponse: (info) => seen.push(['res', info.status, info.requestId, info.willRetry])
    })
    assert.deepEqual(await c.request(sdk.readItem('orders', 1)), { data: 1 })
    assert.deepEqual(seen, [
      ['req', 'GET', '/items/orders/1', 0],
      ['res', 200, 'abc', false]
    ])
    const h = calls[0].init.headers
    assert.equal(h['x-trace'], 'tr-1')
    assert.equal(h['x-nivaro-app'], 'my-app')
    assert.equal(h.Authorization, 'Bearer t')
  })

  it('reports the final failure to onError once, and never a caller abort', async () => {
    const { fetch } = scriptedFetch([{ status: 404, body: { error: 'Not found' } }])
    const errors = []
    const c = createNivaro('http://x', { fetch, onError: (e, info) => errors.push([e.status, info.path]) })
    await assert.rejects(c.request(sdk.readItem('orders', 9)), { status: 404 })
    assert.deepEqual(errors, [[404, '/items/orders/9']])

    const aborting = createNivaro('http://x', {
      fetch: () => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      onError: () => errors.push('abort')
    })
    const ac = new AbortController()
    ac.abort()
    await assert.rejects(aborting.request(sdk.withSignal(sdk.readItem('o', 1), ac.signal)), {
      name: 'AbortError'
    })
    assert.equal(errors.length, 1)
  })

  it('writes one debug line per request through a custom logger', async () => {
    const { fetch } = scriptedFetch([
      { status: 200, body: {}, headers: { 'x-nivaro-request-id': 'r9' } }
    ])
    const lines = []
    const c = createNivaro('http://x', { fetch, debug: (line, d) => lines.push([line, d.requestId]) })
    await c.request(sdk.listMyJobs())
    assert.equal(lines.length, 1)
    assert.match(lines[0][0], /^GET \/my-jobs → 200 in \d+ms \(req r9\)$/)
    assert.equal(lines[0][1], 'r9')
  })
})

describe('client retries (opt-in)', () => {
  it('does not retry without the option', async () => {
    const { fetch, calls } = scriptedFetch([{ status: 503, body: { error: 'busy' } }])
    const c = createNivaro('http://x', { fetch })
    await assert.rejects(c.request(sdk.listMyJobs()), { status: 503 })
    assert.equal(calls.length, 1)
  })

  it('retries a GET on 503, honouring Retry-After', async () => {
    const { fetch, calls } = scriptedFetch([
      { status: 503, body: { error: 'busy' }, headers: { 'retry-after': '0' } },
      { status: 200, body: { data: [] } }
    ])
    const attempts = []
    const c = createNivaro('http://x', {
      fetch,
      retry: { retries: 2, baseDelayMs: 1 },
      onResponse: (i) => attempts.push([i.attempt, i.status, i.willRetry])
    })
    assert.deepEqual(await c.request(sdk.listMyJobs()), { data: [] })
    assert.equal(calls.length, 2)
    assert.deepEqual(attempts, [
      [0, 503, true],
      [1, 200, false]
    ])
  })

  it('retries a network error on a GET, never a POST', async () => {
    const net = new TypeError('fetch failed')
    const get = scriptedFetch([net, { status: 200, body: { ok: 1 } }])
    const c = createNivaro('http://x', { fetch: get.fetch, retry: { retries: 1, baseDelayMs: 1 } })
    assert.deepEqual(await c.request(sdk.listMyJobs()), { ok: 1 })
    assert.equal(get.calls.length, 2)

    const post = scriptedFetch([net, { status: 200, body: { ok: 1 } }])
    const p = createNivaro('http://x', { fetch: post.fetch, retry: { retries: 1, baseDelayMs: 1 } })
    await assert.rejects(p.request(sdk.logout()), /fetch failed/)
    assert.equal(post.calls.length, 1)
  })

  it('gives up after the retries and throws the last answer', async () => {
    const { fetch, calls } = scriptedFetch([{ status: 502, body: { error: 'bad gateway' } }])
    const c = createNivaro('http://x', { fetch, retry: { retries: 2, baseDelayMs: 1 } })
    await assert.rejects(c.request(sdk.listMyJobs()), { status: 502, message: 'bad gateway' })
    assert.equal(calls.length, 3)
  })
})

describe('realtime wire parser', () => {
  it('reads a single collection:update', () => {
    assert.deepEqual(
      parseRealtimeChanges({ collection: 'orders', item: 5, action: 'update', changed_fields: ['a'] }),
      [{ collection: 'orders', item: 5, action: 'update', changed_fields: ['a'] }]
    )
  })

  it('reads a payload without an action as an update', () => {
    assert.deepEqual(parseRealtimeChanges({ collection: 'o', item: 1 }), [
      { collection: 'o', item: 1, action: 'update' }
    ])
  })

  it('splits a coalesced burst into one change per id', () => {
    assert.deepEqual(
      parseRealtimeChanges({
        collection: 'o',
        item: null,
        items: [1, 2],
        many: false,
        count: 2,
        action: 'create',
        coalesced: true
      }),
      [
        { collection: 'o', item: 1, action: 'create', coalesced: true },
        { collection: 'o', item: 2, action: 'create', coalesced: true }
      ]
    )
  })

  it('marks a burst too large to list', () => {
    assert.deepEqual(
      parseRealtimeChanges({ collection: 'o', item: null, items: null, many: true, coalesced: true }),
      [{ collection: 'o', item: null, action: 'update', coalesced: true, many: true }]
    )
  })
})
