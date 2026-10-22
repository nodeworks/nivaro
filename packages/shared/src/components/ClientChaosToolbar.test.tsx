// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getClientChaos,
  getPretendDown,
  resetClientChaosForTests,
  startClientChaos
} from '../lib/client-chaos'
import { ClientChaosToolbar, openClientChaosToolbar } from './ClientChaosToolbar'
import {
  dashboardPretendDownOptions,
  layoutPretendDownOptions,
  PretendDownList,
  usePretendDownScope
} from './PretendDown'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root
const realFetch = globalThis.fetch

function status(body: unknown, code = 200) {
  globalThis.fetch = vi.fn(async () =>
    code === 404
      ? new Response('{"error":"Not Found"}', { status: 404 })
      : new Response(JSON.stringify(body), { status: code })
  ) as unknown as typeof fetch
}

async function render(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>)
  })
  // Let the status query settle.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

beforeEach(() => {
  resetClientChaosForTests()
  sessionStorage.clear()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  globalThis.fetch = realFetch
  resetClientChaosForTests()
})

const admin = { is_admin: true }
const pill = () => document.querySelector('[data-client-chaos-pill]')
const panel = () => document.querySelector('[data-client-chaos-panel]')

describe('ClientChaosToolbar (#2856)', () => {
  it('renders nothing where the server has no chaos route, and ends a restored window', async () => {
    startClientChaos({ preset: 'api-down', durationMs: 60_000 })
    status(null, 404)
    await render(<ClientChaosToolbar user={admin} />)
    act(() => openClientChaosToolbar())
    expect(panel()).toBeNull()
    expect(pill()).toBeNull()
    expect(getClientChaos()).toBeNull()
  })

  it('never shows for someone who may not use it', async () => {
    status({ data: { allowed: true, reason: null, armed: [], nodes: [] } })
    await render(<ClientChaosToolbar user={{ is_admin: false }} />)
    act(() => openClientChaosToolbar())
    expect(panel()).toBeNull()
  })

  it('says why when the gate refuses', async () => {
    status({
      data: { allowed: false, reason: 'Chaos is off on production.', armed: [], nodes: [] }
    })
    await render(<ClientChaosToolbar user={admin} />)
    act(() => openClientChaosToolbar())
    expect(panel()?.textContent).toContain('Chaos is off on production.')
  })

  it('starts a preset, keeps a pill while on, and Stop ends it', async () => {
    status({ data: { allowed: true, reason: null, armed: [], nodes: [] } })
    await render(<ClientChaosToolbar user={admin} />)
    act(() => openClientChaosToolbar())
    const apiDown = [...(panel()?.querySelectorAll('button') ?? [])].find((b) =>
      b.textContent?.includes('API down')
    ) as HTMLButtonElement
    act(() => apiDown.click())
    expect(apiDown.getAttribute('aria-pressed')).toBe('true')
    const start = [...(panel()?.querySelectorAll('button') ?? [])].find((b) =>
      b.textContent?.startsWith('Start for')
    ) as HTMLButtonElement
    act(() => start.click())
    expect(getClientChaos()?.preset).toBe('api-down')
    expect(panel()?.textContent).toContain('Stop now')
    // Close the panel: the pill stays.
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(panel()).toBeNull()
    expect(pill()?.textContent).toContain('API down')
    const stop = pill()?.querySelector('[aria-label="Stop browser chaos"]') as HTMLButtonElement
    act(() => stop.click())
    expect(getClientChaos()).toBeNull()
    expect(pill()).toBeNull()
  })

  it('toggles with ⌘/Ctrl + Shift + .', async () => {
    status({ data: { allowed: true, reason: null, armed: [], nodes: [] } })
    await render(<ClientChaosToolbar user={admin} />)
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { code: 'Period', key: '>', ctrlKey: true, shiftKey: true })
      )
    })
    expect(panel()).not.toBeNull()
  })
})

describe('Pretend down (#2858)', () => {
  it('builds a form’s dependencies from its widgets and panels', () => {
    const opts = layoutPretendDownOptions({
      assignments: [
        { field: '__widget_7__', widget_id: 7, label: 'Spend to date' },
        { field: '__comments__' },
        { field: 'title' }
      ]
    })
    const ids = opts.map((o) => o.id)
    expect(ids).toEqual(['widget:7', 'panel:comments', 'ai', 'partners', 'realtime'])
    expect(opts[0].label).toBe('Spend to date')
    expect(opts[0].patterns[0].test('/widgets-internal/7/render')).toBe(true)
    expect(opts[0].patterns[0].test('/widgets-internal/70/render')).toBe(false)
  })

  it('groups dashboard widgets by what they read', () => {
    const opts = dashboardPretendDownOptions([
      { id: 'a', type: 'count', collection: 'orders' },
      { id: 'b', type: 'sum', collection: 'orders' },
      { id: 'c', type: 'ai_query' }
    ])
    expect(opts[0]).toMatchObject({ label: 'orders data', hint: '2 widgets' })
    expect(opts[0].patterns[0].test('/dashboards/widgets/b/data')).toBe(true)
    expect(opts[0].patterns[0].test('/dashboards/widgets/c/data')).toBe(false)
    expect(opts[1].label).toBe('Ask AI charts')
  })

  it('a switch pretends one down; leaving the surface turns it back on', async () => {
    const options = layoutPretendDownOptions({ assignments: [{ field: '__tasks__' }] })
    function Surface() {
      usePretendDownScope('t')
      return <PretendDownList scope='t' options={options} />
    }
    await render(<Surface />)
    const tasks = host.querySelector('[role="switch"]') as HTMLButtonElement
    act(() => tasks.click())
    expect(tasks.getAttribute('aria-checked')).toBe('true')
    expect(getPretendDown('t').map((d) => d.id)).toEqual(['panel:tasks'])
    await act(async () => {
      root.render(<div />)
    })
    expect(getPretendDown('t')).toEqual([])
  })
})
