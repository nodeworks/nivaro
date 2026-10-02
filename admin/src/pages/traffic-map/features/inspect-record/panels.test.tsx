import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { describe, expect, it, vi } from 'vitest'
import type { InspectPanelProps } from '../../registry/inspectables'
import IssuePanel from './IssuePanel'
import WritePanel from './WritePanel'

const details: Record<string, unknown> = {}

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(async (url: string) => {
      const m = /\/traffic-map\/inspect\/([a-z-]+)\/([^/?]+)/.exec(url)
      const key = m ? `${m[1]}:${decodeURIComponent(m[2])}` : url
      if (url.includes('recording-for'))
        return { data: { data: { found: false, none: true, reason: 'No recording.' } } }
      return { data: { data: details[key] ?? null } }
    })
  }
}))

function props(kind: string, id: string): InspectPanelProps {
  return { inspectRef: { kind, id }, open: vi.fn(), anchor: null, windowSec: 300 }
}

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  )
}

describe('WritePanel', () => {
  it('shows who, the field changes and why the request is missing', async () => {
    details['write:5'] = {
      id: 5,
      action: 'update',
      at: '2026-10-01T12:00:00Z',
      collection: 'workflows',
      item: '12',
      record_label: 'CM26-1',
      user: '7A0411F3-C687-40E5-ADF5-614157CF88EC',
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
})

describe('IssuePanel', () => {
  it('says plainly when a request raised no open issue', async () => {
    const rid = '8ba289a0-81fd-4d13-b56f-567cdb2d2a56'
    details[`issue:rid:${rid}`] = {
      none: true,
      reason: 'Only server errors (5xx) raise issues; this request did not.',
      request_id: rid
    }
    render(wrap(<IssuePanel {...props('issue', `rid:${rid}`)} />))
    expect(await screen.findByText('No open issue for this request')).toBeTruthy()
    expect(screen.getByText(/Only server errors/)).toBeTruthy()
  })

  it('offers the replay, or explains it is missing', async () => {
    details['issue:7'] = {
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
      raised_by: '7A0411F3-C687-40E5-ADF5-614157CF88EC',
      raised_by_name: 'Robert Lee',
      assigned_to_name: null,
      resolution_notes: null,
      route: '/environments',
      request_context: null,
      stack: 'RangeError: Invalid time value\n    at formatDate (utils.ts:15:6)',
      details_other: null,
      recording: {
        id: '264bee7b-87d3-4452-81c9-ce6fbf672de5',
        user_name: 'Robert Lee',
        clip: true,
        offset_ms: 226,
        at: 1790000000226
      },
      recording_note: null,
      screenshot: null,
      screenshot_note: null,
      matched_request: null
    }
    render(wrap(<IssuePanel {...props('issue', '7')} />))
    expect(await screen.findByText(/Watch the moment it failed/)).toBeTruthy()
    expect(screen.getByText(/6 times/)).toBeTruthy()
    expect(screen.getByText(/RangeError/)).toBeTruthy()
  })
})
