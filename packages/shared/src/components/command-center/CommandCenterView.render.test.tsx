// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The shell (slice 4) at phone and desktop widths, with stand-in panels: where each slot goes,
// peek is stored (not navigated) and closes on Esc, the lenses reach the URL, shortcuts work.

vi.mock('./panels/registry', async () => {
  const { useCc } = await import('./state')
  const stub = (key: string) =>
    function Stub() {
      const cc = useCc()
      return (
        <section data-testid={key}>
          <h2>{key}</h2>
          <button type='button' onClick={() => cc.setPeek({ collection: 'orders', id: '42' })}>
            open {key}
          </button>
        </section>
      )
    }
  const CC_PANELS = [
    { key: 'map', label: 'Live map', area: 'main', component: stub('map') },
    { key: 'attention', label: 'Needs attention', area: 'lead', component: stub('attention') },
    { key: 'flow', label: 'Pipeline flow', area: 'rail', component: stub('flow') },
    { key: 'workload', label: 'Workload', area: 'lead', component: stub('workload') },
    { key: 'feed', label: 'Live feed', area: 'bottom', component: stub('feed') }
  ]
  return { CC_PANELS, CC_PANEL_KEYS: CC_PANELS.map((p) => p.key) }
})
vi.mock('./PeekPanel', async () => {
  const { useCc } = await import('./state')
  return {
    PeekPanel: function Peek() {
      const { peek, setPeek } = useCc()
      if (!peek) return null
      return (
        <div data-cc-peek role='dialog' aria-label='Record'>
          <span data-testid='peek'>{`${peek.collection}:${peek.id}`}</span>
          <button type='button' onClick={() => setPeek(null)}>
            Close
          </button>
        </div>
      )
    }
  }
})

const { CommandCenterView } = await import('./CommandCenterView')
const { NavigationContext, NivaroProvider } = await import('../../context')

const navigate = vi.fn()
const requests: Array<{ path: string; params?: Record<string, unknown> }> = []
const client = {
  request: vi.fn(async (cmd: { _path: string; _params?: Record<string, unknown> }) => {
    requests.push({ path: cmd._path, params: cmd._params })
    if (cmd._path === '/command-center/config')
      return {
        data: {
          geo_collections: [{ key: 'locations', label: 'Locations' }],
          regions: [
            { id: 'n', label: 'North', lat: null, lng: null },
            { id: 's', label: 'South', lat: null, lng: null }
          ],
          region_label: 'Region',
          stuck_days: 7
        }
      }
    if (cmd._path === '/command-center/prefs')
      return { data: { layout: null, theme: 'app', saved_views: [], role_default: null } }
    if (cmd._path === '/command-center/snapshot') return { data: null }
    return { data: null }
  })
}

let host: HTMLDivElement
let root: Root

function mount(width: number, search = '') {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  window.history.replaceState(null, '', `/command${search}`)
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  act(() =>
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <NavigationContext.Provider value={{ navigate }}>
            <CommandCenterView />
          </NavigationContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
}

// Let every mocked request (config, prefs, snapshot) settle and the board re-render.
const flush = async () => {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}
const order = () =>
  Array.from(host.querySelectorAll('[data-testid]')).map((el) => el.getAttribute('data-testid'))
const key = (k: string, target: EventTarget = document.body) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
  })

beforeEach(() => {
  navigate.mockReset()
  requests.length = 0
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('Command Center shell', () => {
  it('375px: attention first, the map behind "Show map", the feed last', async () => {
    mount(375)
    await flush()
    expect(order()).toEqual(['attention', 'workload', 'flow', 'feed'])
    const show = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent === 'Show map'
    )
    expect(show).toBeTruthy()
    act(() => show!.click())
    expect(order()).toContain('map')
  })

  it('1440px: the map beside a rail that opens with Needs attention', async () => {
    mount(1440)
    await flush()
    const aside = host.querySelector('aside')
    expect(
      Array.from(aside!.querySelectorAll('[data-testid]')).map((e) => e.getAttribute('data-testid'))
    ).toEqual(['attention', 'flow', 'workload'])
    expect(host.querySelector('[data-cc-size]')?.getAttribute('data-cc-size')).toBe('wide')
  })

  it('1920px: attention has its own column before the map', async () => {
    mount(1920)
    await flush()
    expect(order().slice(0, 3)).toEqual(['attention', 'workload', 'map'])
  })

  it('opening a record stores the peek (no navigation), writes the URL, and Esc closes it', async () => {
    mount(1440)
    await flush()
    const opener = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent === 'open flow'
    )!
    act(() => opener.focus())
    act(() => opener.click())
    expect(navigate).not.toHaveBeenCalled()
    expect(host.querySelector('[data-testid="peek"]')?.textContent).toBe('orders:42')
    expect(new URLSearchParams(window.location.search).get('peek')).toBe('orders:42')
    key('Escape')
    expect(host.querySelector('[data-testid="peek"]')).toBeNull()
    expect(window.location.search).not.toContain('peek')
    expect(document.activeElement).toBe(opener)
  })

  it('reads the lenses from the URL and sends them with every board read', async () => {
    mount(1440, '?region=s&tv=1&utm=keep')
    await flush()
    const snap = requests.find((r) => r.path === '/command-center/snapshot')
    expect(snap?.params).toMatchObject({ region: 's' })
    expect(host.querySelector('[data-cc-tv]')).toBeTruthy()
    expect(window.location.search).toContain('utm=keep')
  })

  it('number keys jump to regions, t toggles TV, and typing in a field is left alone', async () => {
    mount(1440)
    await flush()
    key('2')
    expect(new URLSearchParams(window.location.search).get('region')).toBe('s')
    key('0')
    expect(new URLSearchParams(window.location.search).get('region')).toBeNull()
    const input = document.createElement('input')
    host.appendChild(input)
    key('1', input)
    expect(new URLSearchParams(window.location.search).get('region')).toBeNull()
    key('t')
    expect(new URLSearchParams(window.location.search).get('tv')).toBe('1')
    key('Escape')
    expect(new URLSearchParams(window.location.search).get('tv')).toBeNull()
  })

  it('shows skeletons, not dashes, while the first snapshot loads', async () => {
    client.request.mockImplementationOnce(() => new Promise(() => {}))
    mount(1440)
    expect(host.textContent).not.toContain('–')
    expect(host.querySelector('header .motion-safe\\:animate-pulse')).toBeTruthy()
  })
})
