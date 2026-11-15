// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { type RealtimeAdapter, RealtimeContext } from '../../lib/realtime'
import { SessionsCard, sessionEndsIn } from './PersonAccess'

// Person page → Signed-in browsers (realtime round 9 #23): each row names the browser, the
// address and when it signed in — never the session id — and the list re-reads when the
// `sessions` ops topic names THIS person.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const USER = 'aaaaaaaa-1111-4111-8111-111111111111'
type Cmd = { _method: string; _path: string }

let root: Root
let host: HTMLDivElement
let rows: Array<Record<string, unknown>>
let gets = 0

function adapter() {
  const listeners = new Map<string, Set<(p: unknown) => void>>()
  const emitted: Array<[string, unknown]> = []
  const rt: RealtimeAdapter = {
    subscribeCollections: () => () => {},
    on(event, cb) {
      const set = listeners.get(event) ?? new Set()
      set.add(cb)
      listeners.set(event, set)
      return () => set.delete(cb)
    },
    emit: (event, payload) => {
      emitted.push([event, payload])
    }
  }
  const fire = (event: string, payload: unknown) => {
    for (const cb of listeners.get(event) ?? []) cb(payload)
  }
  return { rt, emitted, fire }
}

async function settle(until?: () => boolean) {
  for (let i = 0; i < 300; i++) {
    await act(async () => await new Promise((r) => setTimeout(r, 5)))
    if (until?.()) return
  }
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  gets = 0
  rows = [
    {
      sid_prefix: 'abcdef123456',
      user_id: USER,
      ttl_seconds: 7 * 3600,
      device: 'Chrome on macOS',
      ip: '10.0.0.4',
      signed_in_at: '2026-11-14T15:42:00.000Z'
    }
  ]
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

async function mount() {
  const { rt, emitted, fire } = adapter()
  const client = {
    request: vi.fn(async (cmd: Cmd) => {
      if (cmd._method === 'GET') gets++
      return { data: rows }
    })
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <RealtimeContext.Provider value={rt}>
            <SessionsCard userId={USER} />
          </RealtimeContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
  await settle(() => !!host.querySelector('[data-session-row]'))
  return { emitted, fire }
}

describe('SessionsCard', () => {
  it('names the browser, address and sign-in time — never the session id', async () => {
    await mount()
    expect(host.querySelector('[data-session-device]')?.textContent).toBe('Chrome on macOS')
    const meta = host.querySelector('[data-session-meta]')?.textContent ?? ''
    expect(meta).toContain('10.0.0.4')
    expect(meta).toContain('Signed in')
    expect(meta).toContain('Ends in 7h')
    expect(host.textContent).not.toContain('abcdef')
  })

  it('joins the sessions topic and re-reads only for this person', async () => {
    const { emitted, fire } = await mount()
    expect(emitted).toContainEqual(['ops:join', { topic: 'sessions' }])
    const before = gets
    await act(async () => {
      fire('ops:changed', { topic: 'sessions', user_id: 'SOMEONE-ELSE', at: 1 })
    })
    await settle()
    expect(gets).toBe(before)
    rows = [
      ...rows,
      {
        sid_prefix: 'zzzzzz999999',
        user_id: USER,
        ttl_seconds: 600,
        device: 'Firefox on Windows',
        ip: '10.0.0.9',
        signed_in_at: '2026-11-15T09:00:00.000Z'
      }
    ]
    await act(async () => {
      fire('ops:changed', { topic: 'sessions', user_id: USER.toUpperCase(), at: 2 })
    })
    await settle(() => host.querySelectorAll('[data-session-row]').length === 2)
    expect(gets).toBeGreaterThan(before)
    expect(host.querySelectorAll('[data-session-row]')).toHaveLength(2)
  })

  it('a session from before the stamp still reads plainly', async () => {
    rows = [{ sid_prefix: 'old000000000', user_id: USER, ttl_seconds: 120 }]
    await mount()
    expect(host.querySelector('[data-session-device]')?.textContent).toBe('Browser')
    expect(host.querySelector('[data-session-meta]')?.textContent).toContain(
      'Signed in before this was recorded'
    )
  })
})

describe('sessionEndsIn', () => {
  it('reads in minutes, hours or days', () => {
    expect(sessionEndsIn(0)).toBe('Ending now')
    expect(sessionEndsIn(90)).toBe('Ends in 2 min')
    expect(sessionEndsIn(5 * 3600)).toBe('Ends in 5h')
    expect(sessionEndsIn(72 * 3600)).toBe('Ends in 3 days')
  })
})
