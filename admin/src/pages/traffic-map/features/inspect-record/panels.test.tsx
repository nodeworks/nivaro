import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InspectPanelProps } from '../../registry/inspectables'
import ChainPanel from './ChainPanel'
import IssuePanel from './IssuePanel'
import RecordingPanel from './RecordingPanel'
import RecordPanel from './RecordPanel'
import WritePanel from './WritePanel'

const details: Record<string, unknown> = {}
let recordingFor: unknown = { found: false, none: true, reason: 'No recording.' }

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(async (url: string) => {
      const m = /\/traffic-map\/inspect\/([a-z-]+)\/([^/?]+)/.exec(url)
      const key = m ? `${m[1]}:${decodeURIComponent(m[2])}` : url
      if (url.includes('recording-for')) return { data: { data: recordingFor } }
      const d = details[key]
      if (d === undefined) {
        throw Object.assign(new Error('not found'), {
          response: { status: 404, data: { code: 'INSPECT_NOT_FOUND', error: 'No such thing' } }
        })
      }
      return { data: { data: d } }
    }),
    post: vi.fn(async () => ({ data: {} }))
  }
}))
// The shared-component context needs the SDK client and auth; the panels under test do not.
vi.mock('./providers', () => ({
  SharedProviders: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))
vi.mock('@/components/replay-player', () => ({
  ReplayPlayer: (p: { recordingId: string; startAt: number | null; live: boolean }) => (
    <div data-test-player={`${p.recordingId}:${p.startAt ?? 'none'}:${p.live ? 'live' : 'rec'}`} />
  )
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const RID = '8ba289a0-81fd-4d13-b56f-567cdb2d2a56'
const U = '7A0411F3-C687-40E5-ADF5-614157CF88EC'
const REC = '264bee7b-87d3-4452-81c9-ce6fbf672de5'
const CHAIN = '0f8fad5b-d9cb-469f-a165-70867728950e'

function props(kind: string, id: string, open = vi.fn()): InspectPanelProps {
  return { inspectRef: { kind, id }, open, anchor: null, windowSec: 300 }
}

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  )
}

const issueBase = {
  id: 7,
  title: '[client] /environments: Invalid time value',
  severity: 'high',
  status: 'open',
  source: 'client',
  occurrence_count: 6,
  created_at: '2026-10-01T12:00:00Z',
  last_seen_at: '2026-10-01T12:01:00Z',
  collection: null,
  item: null,
  raised_by: U,
  raised_by_name: 'Robert Lee',
  assigned_to_name: null,
  resolution_notes: null,
  route: '/environments',
  request_context: null,
  stack: 'RangeError: Invalid time value\n    at formatDate (utils.ts:15:6)',
  details_other: null,
  recording: null,
  recording_note: null,
  screenshot: null,
  screenshot_note: null,
  matched_request: null
}

afterEach(() => {
  for (const k of Object.keys(details)) delete details[k]
  recordingFor = { found: false, none: true, reason: 'No recording.' }
})

describe('WritePanel', () => {
  it('shows who, the field changes and why the request is missing', async () => {
    details['write:5'] = {
      id: 5,
      action: 'update',
      at: '2026-10-01T12:00:00Z',
      collection: 'workflows',
      item: '12',
      record_label: 'CM26-1',
      user: U,
      who: 'Robert Lee',
      origin: 'person',
      auth_method: 'session',
      api_key: null,
      ip: null,
      user_agent: null,
      comment: null,
      chain_id: null,
      revision_id: 9,
      changes: [{ field: 'amount', label: 'Amount', old: '$3.00', new: '$5.00' }],
      changes_note: null,
      request: null,
      request_note: 'This write was not made inside a recorded request (no chain id).'
    }
    render(wrap(<WritePanel {...props('write', '5')} />))
    expect(await screen.findByText('Robert Lee updated CM26-1')).toBeTruthy()
    expect(screen.getByText('Amount')).toBeTruthy()
    expect(screen.getByText('$3.00')).toBeTruthy()
    expect(screen.getByText(/no chain id/)).toBeTruthy()
    expect(screen.getByText('Signed-in session')).toBeTruthy()
  })
  it('404 → the not-found wording', async () => {
    render(wrap(<WritePanel {...props('write', '99')} />))
    expect(await screen.findByText(/There is no write to show/)).toBeTruthy()
    expect(document.querySelector('[data-tm-inspect-error="INSPECT_NOT_FOUND"]')).toBeTruthy()
  })
})

describe('IssuePanel', () => {
  it('says plainly when a request raised no open issue', async () => {
    details[`issue:rid:${RID}`] = {
      none: true,
      reason: 'Only server errors (5xx) raise issues; this request did not.',
      request_id: RID
    }
    render(wrap(<IssuePanel {...props('issue', `rid:${RID}`)} />))
    expect(await screen.findByText('No open issue for this request')).toBeTruthy()
    expect(screen.getByText(/Only server errors/)).toBeTruthy()
  })

  it('waits for the API log when the row is not flushed yet', async () => {
    details[`issue:rid:${RID}`] = {
      none: true,
      pending: true,
      reason: 'This request is not in the API log yet — checking again shortly.',
      request_id: RID
    }
    render(wrap(<IssuePanel {...props('issue', `rid:${RID}`)} />))
    expect(await screen.findByText('Waiting for the API log')).toBeTruthy()
    expect(document.querySelector('[data-tm-inspect-issue="pending"]')).toBeTruthy()
  })

  it('offers the replay, or explains it is missing', async () => {
    details['issue:7'] = {
      ...issueBase,
      recording: {
        id: REC,
        user_name: 'Robert Lee',
        clip: true,
        offset_ms: 226,
        at: 1790000000226
      }
    }
    render(wrap(<IssuePanel {...props('issue', '7')} />))
    expect(await screen.findByText(/Watch the moment it failed/)).toBeTruthy()
    expect(screen.getByText(/6 times/)).toBeTruthy()
    expect(screen.getByText(/RangeError/)).toBeTruthy()
  })

  it('says how a request was matched, and anchors "what they saw" on that request', async () => {
    const at = Date.parse('2026-10-01T12:00:30Z')
    const other = '11111111-2222-4333-8444-555555555555'
    details[`issue:rid:${RID}`] = {
      ...issueBase,
      source: 'server',
      recording_note: 'Server errors carry no replay.',
      matched_request: { id: RID, user: other, at, matched_by: 'fingerprint' }
    }
    recordingFor = { found: true, recording_id: REC, offset_ms: 5_000, clip: false, distance_ms: 0 }
    const { api } = await import('@/lib/api')
    render(wrap(<IssuePanel {...props('issue', `rid:${RID}`)} />))
    expect(await screen.findByText(/This request raised this issue/)).toBeTruthy()
    expect(await screen.findByText('Watch what they saw')).toBeTruthy()
    // The request's own person + time, not the first raiser at last_seen_at.
    const call = vi
      .mocked(api.get)
      .mock.calls.find((c) => String(c[0]).includes('recording-for')) as unknown as [
      string,
      { params: { user: string; at: number } }
    ]
    expect(call[1].params).toEqual({ user: other, at })
  })

  it('a route-only match says the message did not match; the raiser anchors at created_at', async () => {
    details[`issue:rid:${RID}`] = {
      ...issueBase,
      matched_request: { id: RID, user: null, at: null, matched_by: 'route' }
    }
    const { api } = await import('@/lib/api')
    vi.mocked(api.get).mockClear()
    render(wrap(<IssuePanel {...props('issue', `rid:${RID}`)} />))
    expect(await screen.findByText(/Matched by route only/)).toBeTruthy()
    expect(await screen.findByText(/Follow Robert Lee from now on/)).toBeTruthy()
    const call = vi
      .mocked(api.get)
      .mock.calls.find((c) => String(c[0]).includes('recording-for')) as unknown as [
      string,
      { params: { user: string; at: number } }
    ]
    expect(call[1].params).toEqual({ user: U, at: Date.parse(issueBase.created_at) })
  })
})

describe('ChainPanel', () => {
  it('draws the path with a drill link per step and names the starting request', async () => {
    const at = '2026-10-01T12:00:00.000Z'
    details[`chain:${CHAIN}`] = {
      chain_id: CHAIN,
      path: {
        root: {
          key: `request:${CHAIN}`,
          parent: null,
          kind: 'request',
          at,
          offset_ms: 0,
          summary: 'PATCH /api/items/workflows/12 · 200',
          children: [
            {
              key: 'activity:11',
              parent: `request:${CHAIN}`,
              kind: 'write',
              at,
              offset_ms: 12,
              record: { collection: 'workflows', item: '12', label: 'CM26-1' },
              summary: 'updated CM26-1',
              children: []
            }
          ]
        },
        mode: 'exact',
        truncated: false,
        step_count: 2,
        first_failure: null,
        replay_of: null,
        replayed_as: [],
        warnings: []
      },
      request: { log_id: '31', request_id: RID, at },
      request_note: null
    }
    render(wrap(<ChainPanel {...props('chain', CHAIN)} />))
    expect(await screen.findByText(/Started by request 8ba289a0/)).toBeTruthy()
    expect(document.querySelector(`[data-tm-inspect-chain="${CHAIN}"]`)).toBeTruthy()
    expect(document.querySelector('[data-tm-inspect-link="write:11"]')).toBeTruthy()
    expect(document.querySelector(`[data-tm-inspect-link="request:${RID}"]`)).toBeTruthy()
  })
  it('explains a chain with no logged request', async () => {
    details[`chain:${CHAIN}`] = {
      chain_id: CHAIN,
      path: {
        root: {
          key: 'cron:x',
          parent: null,
          kind: 'request',
          at: '2026-10-01T12:00:00.000Z',
          offset_ms: 0,
          summary: 'cron x',
          children: []
        },
        mode: 'exact',
        truncated: false,
        step_count: 1,
        first_failure: null,
        replay_of: null,
        replayed_as: [],
        warnings: []
      },
      request: null,
      request_note: 'No inbound request started this chain (a schedule, an import or a feed did).'
    }
    render(wrap(<ChainPanel {...props('chain', CHAIN)} />))
    expect(await screen.findByText(/No inbound request started this chain/)).toBeTruthy()
    expect(document.querySelector('[data-tm-inspect-link^="request:"]')).toBeNull()
  })
})

describe('RecordPanel', () => {
  it('lists the fields as stored when there is no read layout, and the writes near the moment', async () => {
    details['record:workflows:12'] = {
      collection: 'workflows',
      item: '12',
      label: 'CM26-1',
      exists: true,
      reason: null,
      values: { id: 12, title: 'Hello', done: false },
      touches: [
        {
          id: 5,
          action: 'update',
          at: '2026-10-01T12:00:00Z',
          who: 'Robert Lee',
          origin: 'person',
          comment: null,
          chain_id: null
        }
      ],
      touches_in_window: 1,
      touches_total: 3,
      touches_note: null,
      window_sec: 300
    }
    render(wrap(<RecordPanel {...props('record', 'workflows:12')} />))
    expect(await screen.findByText('CM26-1')).toBeTruthy()
    expect(await screen.findByText(/no read layout/)).toBeTruthy()
    expect(screen.getByText('Hello')).toBeTruthy()
    expect(screen.getByText('No')).toBeTruthy()
    expect(document.querySelector('[data-tm-inspect-link="write:5"]')).toBeTruthy()
    expect(screen.getByText(/3 writes recorded on this record in all/)).toBeTruthy()
    expect(document.querySelector('[data-tm-inspect-record-page]')).toBeTruthy()
  })
  it('a refused or missing record keeps its writes and says why', async () => {
    details['record:workflows:12'] = {
      collection: 'workflows',
      item: '12',
      label: null,
      exists: false,
      reason: 'This record was deleted — it is in the trash.',
      values: null,
      touches: [],
      touches_in_window: 0,
      touches_total: 0,
      touches_note: 'Nobody has written to this record that Nivaro recorded.',
      window_sec: 300
    }
    render(wrap(<RecordPanel {...props('record', 'workflows:12')} />))
    expect(await screen.findByText(/in the trash/)).toBeTruthy()
    expect(screen.getByText(/Nobody has written/)).toBeTruthy()
    expect(document.querySelector('[data-tm-inspect-record-page]')).toBeNull()
  })
})

describe('RecordingPanel', () => {
  it('embeds the player seeked to the moment', async () => {
    details[`recording:${REC}`] = {
      none: false,
      recording: {
        id: REC,
        user: U,
        user_name: 'Beth Ng',
        app: 'admin',
        clip: false,
        origin: null,
        started_at: '2026-10-01T11:59:00Z',
        ended_at: null,
        last_event_at: '2026-10-01T12:03:00Z',
        event_count: 120,
        byte_size: 4096,
        truncated: false,
        live: false
      },
      offset_ms: 60_000,
      recording_on: true
    }
    render(wrap(<RecordingPanel {...props('recording', REC)} />))
    expect(await screen.findByText('Recording of Beth Ng')).toBeTruthy()
    expect(screen.getByText(/1 min in · opens 5 s before/)).toBeTruthy()
    expect(document.querySelector(`[data-test-player="${REC}:60000:rec"]`)).toBeTruthy()
  })
  it('with none: the reason, follow buttons and the recording-off hint', async () => {
    details[`recording:for:${U}`] = {
      none: true,
      reason: 'No recording of this person covers that moment.',
      user: U,
      user_name: 'Beth Ng',
      at: '2026-10-01T12:00:00Z',
      recording_on: false
    }
    render(wrap(<RecordingPanel {...props('recording', `for:${U}`)} />))
    expect(await screen.findByText(/No recording of Beth Ng/)).toBeTruthy()
    expect(document.querySelector('[data-tm-inspect-recording-follow]')).toBeTruthy()
    expect(document.querySelector('[data-tm-inspect-note="recording-off"]')).toBeTruthy()
  })
  it('a purged recording is a 404 with the retention sentence', async () => {
    render(wrap(<RecordingPanel {...props('recording', REC)} />))
    expect(await screen.findByText(/There is no recording to show/)).toBeTruthy()
    expect(screen.getByText(/kept for 7 days/)).toBeTruthy()
  })
})
