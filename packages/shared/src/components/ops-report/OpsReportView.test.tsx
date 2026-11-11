// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { ItemEditAuthContext, NivaroProvider } from '../../context'
import type { OpsDrillMetric } from '../../lib/ops-report-types'
import {
  FIXTURE_DIGEST_ONLY,
  FIXTURE_LIST,
  FIXTURE_REPORT,
  FIXTURE_SETTINGS,
  FIXTURE_TRENDS,
  fixtureDrill
} from './fixture'
import type { OpsTab } from './format'
import { OpsReportView } from './OpsReportView'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface Cmd {
  _method: string
  _path: string
  _params?: Record<string, unknown>
}

function fakeClient(opts: { digestOnly?: boolean } = {}) {
  const calls: Cmd[] = []
  const list = opts.digestOnly
    ? [{ ...FIXTURE_LIST[0], id: 99, status: 'digest_only' as const }, ...FIXTURE_LIST.slice(1)]
    : FIXTURE_LIST
  return {
    calls,
    request: async (cmd: Cmd) => {
      calls.push(cmd)
      const p = cmd._path
      if (p === '/ops-reports') return { data: list }
      if (p === '/ops-reports/trends') return { data: FIXTURE_TRENDS }
      if (p === '/ops-reports/settings') return { data: FIXTURE_SETTINGS }
      if (/\/ops-reports\/\d+\/drill$/.test(p))
        return {
          data: fixtureDrill(
            cmd._params?.metric as OpsDrillMetric,
            (cmd._params?.key as string | undefined) ?? null
          )
        }
      if (/^\/ops-reports\/99$/.test(p)) return { data: FIXTURE_DIGEST_ONLY }
      if (/^\/ops-reports\/\d+$/.test(p)) return { data: FIXTURE_REPORT }
      return { data: [] }
    }
  }
}

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

async function settle() {
  for (let i = 0; i < 15; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}

async function mount(tab?: OpsTab, opts?: { digestOnly?: boolean }) {
  const client = fakeClient(opts)
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () =>
    root?.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <ItemEditAuthContext.Provider value={{ isAdmin: true, userId: 'u1' } as never}>
            <OpsReportView tab={tab} />
          </ItemEditAuthContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  await settle()
  return { host, client }
}

const click = (el: Element | null) => {
  if (!el) throw new Error('nothing to click')
  return act(async () => {
    ;(el as HTMLElement).click()
  })
}
const panel = () => document.querySelector('[data-ops-drill-panel]') as HTMLElement | null

describe('OpsReportView', () => {
  it('shows the day list, the verdict, the score and the people block with its explanations', async () => {
    const { host } = await mount()
    expect(host.querySelectorAll('[data-ops-day]').length).toBe(FIXTURE_LIST.length)
    const text = host.textContent ?? ''
    expect(text).toContain('Watch')
    expect(text).toContain('Active people')
    expect(text).toContain('Signed in today')
    expect(text).toContain('Still signed in')
    for (const line of FIXTURE_REPORT.digest.people.explain) expect(text).toContain(line)
    expect(host.querySelector('[data-ops-score-parts]')?.textContent).toContain('Deadlocks')
    expect(host.querySelector('[data-ops-kpi="server_errors"]')).not.toBeNull()
    expect(host.querySelector('[data-ops-section="integrations"]')).not.toBeNull()
    expect(host.querySelector('[data-ops-incident]')).not.toBeNull()
  })

  it('opens a drill panel from a KPI tile and drills three levels down to a request, then back', async () => {
    const { host, client } = await mount()
    await click(host.querySelector('[data-ops-kpi="server_errors"]')?.closest('button') ?? null)
    await settle()
    expect(panel()?.textContent).toContain('POST /api/items/:c')
    expect(client.calls.some((c) => c._params?.metric === 'server_errors')).toBe(true)

    // level 2: the route's requests
    await click(panel()?.querySelector('[data-ops-drill-row="slow_route"]') ?? null)
    await settle()
    expect(panel()?.textContent).toContain('Dana Whitfield')
    expect(panel()?.textContent).toContain('Showing the first 2 of 7')

    // level 3: one request, with its code blocks
    await click(panel()?.querySelector('[data-ops-drill-row="request"]') ?? null)
    await settle()
    expect(panel()?.querySelector('[data-ops-block="json"]')?.textContent).toContain(
      '"statusCode": 500'
    )
    expect(panel()?.querySelector('[data-ops-block="code"]')?.textContent).toContain('createOne')
    expect(panel()?.textContent).toContain('Server errors')

    // level 4: the person, then back twice
    await click(panel()?.querySelector('[data-ops-drill-row="person"]') ?? null)
    await settle()
    expect(panel()?.textContent).toContain('their day')
    await click(panel()?.querySelector('[data-ops-drill-back]') ?? null)
    await settle()
    expect(panel()?.querySelector('[data-ops-block="json"]')).not.toBeNull()
    await click(panel()?.querySelector('[data-ops-drill-back]') ?? null)
    await settle()
    expect(panel()?.querySelector('[data-ops-drill-row="request"]')).not.toBeNull()
  })

  it('opens a digest row (a slow route) in the same panel', async () => {
    const { host } = await mount()
    // open the speed section, then click the first slow route
    await click(host.querySelector('[data-ops-section="speed"] button'))
    const row = host.querySelector('[data-ops-section="speed"] tr[data-ops-drill="slow_route"]')
    expect(row).not.toBeNull()
    await click(row)
    await settle()
    expect(panel()?.textContent).toContain('Requests on GET /api/dashboards/widgets/:id')
  })

  it('draws the trends with a verdict strip and one chart slot per number', async () => {
    const { host } = await mount('trends')
    expect(host.querySelectorAll('[data-ops-verdict-strip] button').length).toBe(
      FIXTURE_TRENDS.length
    )
    expect(host.querySelector('[data-ops-trend-group="score"]')).not.toBeNull()
    expect(host.querySelector('[data-ops-trend="p95_ms"]')).not.toBeNull()
    expect(host.querySelector('[data-ops-trend-group="speed"]')).not.toBeNull()
  })

  it('compares two days side by side with every number', async () => {
    const { host } = await mount('compare')
    expect(host.querySelector('[data-ops-compare]')).not.toBeNull()
    expect(host.querySelector('[data-ops-compare-row="requests"]')).not.toBeNull()
    expect(host.querySelector('[data-ops-compare-row="business.requested_usd"]')).not.toBeNull()
    expect(host.textContent).toContain('Difference')
  })

  it('reads a numbers-only report with missing blocks without crashing', async () => {
    const { host } = await mount(undefined, { digestOnly: true })
    const text = host.textContent ?? ''
    expect(text).toContain('The AI write-up did not finish')
    expect(text).toContain('Nothing recorded')
    expect(host.querySelector('[data-ops-section="traffic"]')).not.toBeNull()
    expect(host.querySelector('[data-ops-section="speed"]')?.textContent).toContain(
      'Nothing recorded'
    )
  })
})
