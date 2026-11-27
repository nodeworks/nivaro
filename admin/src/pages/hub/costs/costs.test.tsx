import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Task 44c: live cost and estimate screens — the figure and its lines, the running estimate under
// a provider form (debounced, last figure kept, secrets never sent, traffic source shown), the
// plan's before → after and total, and Costs → Now (run-rate, budgets read-only for owners).

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
  user: { is_admin: true } as unknown
}))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string, config?: unknown) => h.get(url, config),
    post: (url: string, body?: unknown, config?: unknown) => h.post(url, body, config),
    put: (url: string, body?: unknown) => h.put(url, body),
    patch: vi.fn(),
    delete: vi.fn()
  }
}))
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: h.user }) }))

const { caveats, cents, isEstimate, signedCents, trafficWords, unitPrice, withoutSecrets } =
  await import('./cost-api')
const { CostBreakdown, CostFigure } = await import('./CostFigure')
const { ResourceEstimate } = await import('./ResourceEstimate')
const { BeforeAfterLine, PlanCostTotalRow } = await import('./ChangeCost')
const { HubCostsNow } = await import('./HubCostsNow')

type Est = import('./cost-api').CostEstimate

const est = (over: Partial<Est> = {}): Est => ({
  currency: 'USD',
  monthlyCents: 4820,
  oneTimeCents: 0,
  yearlyCents: 0,
  basis: 'price_list',
  confidence: 'list_price',
  lines: [
    {
      label: 'EC2 t3.medium',
      qty: 730,
      unit: 'hour',
      unitCents: 4.16,
      monthlyCents: 3037,
      kind: 'base',
      source: 'price_list'
    },
    {
      label: 'Data out',
      qty: 120,
      unit: 'GB',
      unitCents: 9,
      monthlyCents: 1080,
      kind: 'transfer',
      source: 'measured'
    }
  ],
  priceAsOf: '2026-11-26',
  ...over
})

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const out = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>
  )
  return {
    ...out,
    redraw: (next: ReactNode) =>
      out.rerender(
        <QueryClientProvider client={qc}>
          <MemoryRouter>{next}</MemoryRouter>
        </QueryClientProvider>
      )
  }
}

beforeEach(() => {
  h.get.mockReset()
  h.post.mockReset()
  h.put.mockReset()
  h.user = { is_admin: true }
})
afterEach(() => vi.useRealTimers())

describe('cost words', () => {
  it('formats cents, signed differences and small unit prices', () => {
    expect(cents(4820)).toBe('$48.20')
    expect(signedCents(320)).toBe('+$3.20')
    expect(signedCents(-320)).toBe('−$3.20')
    expect(unitPrice(1.04)).toBe('$0.0104')
    expect(unitPrice(16.64)).toBe('$0.1664')
    expect(unitPrice(250)).toBe('$2.50')
  })

  it('says what an estimate leaves out, never a line it has', () => {
    expect(caveats(est())).toEqual(['Tax not included.', 'Credits and discounts not counted.'])
    const noTransfer = est({ lines: [est().lines[0]] })
    expect(caveats(noTransfer)).toContain('No data transfer counted.')
    const taxed = est({
      lines: [
        ...est().lines,
        {
          label: 'Tax 4%',
          qty: 1,
          unit: 'month',
          unitCents: 165,
          monthlyCents: 165,
          kind: 'tax',
          source: 'learned_from_bill'
        }
      ]
    })
    expect(caveats(taxed)).not.toContain('Tax not included.')
    expect(caveats(est({ basis: 'free', lines: [] }))).toEqual([])
  })

  it('names where the traffic figure came from', () => {
    expect(trafficWords(null, false)).toBe('none assumed')
    expect(trafficWords({ egressGbMonth: 0, source: 'measured' }, false)).toBe('none assumed')
    expect(trafficWords({ egressGbMonth: 120, source: 'measured' }, false)).toBe('measured')
    expect(trafficWords({ egressGbMonth: 120, source: 'form' }, true)).toBe('you entered')
  })

  it('never sends a secret value, nested ones included', () => {
    const fields = [
      { key: 'name', kind: 'string' },
      { key: 'token', kind: 'secret' },
      { key: 'blank', kind: 'secret' },
      {
        key: 'auth',
        kind: 'object',
        fields: [{ key: 'password', kind: 'secret' }]
      },
      { key: 'keys', kind: 'list', items: { key: 'k', kind: 'secret' } }
    ]
    const out = withoutSecrets(fields, {
      name: 'web',
      token: 'test-secret-one',
      blank: '',
      auth: { password: 'test-secret-two' },
      keys: ['test-secret-three']
    })
    expect(out).toEqual({
      name: 'web',
      token: true,
      blank: null,
      auth: { password: true },
      keys: [true]
    })
    expect(JSON.stringify(out)).not.toContain('test-secret')
  })

  it('reads an unexpected answer as no estimate', () => {
    expect(isEstimate({ changeId: 3 })).toBe(false)
    expect(isEstimate(est())).toBe(true)
  })
})

describe('CostFigure', () => {
  it('shows the amount, the basis chip and the difference from now', () => {
    wrap(<CostFigure estimate={est()} before={est({ monthlyCents: 4500 })} />)
    expect(screen.getByText('$48.20')).toBeTruthy()
    expect(screen.getByText('List price')).toBeTruthy()
    expect(screen.getByText('(+$3.20 vs now)')).toBeTruthy()
  })

  it('says No estimate for an unknown price, never $0', () => {
    wrap(<CostFigure estimate={est({ confidence: 'unknown', monthlyCents: 0, lines: [] })} />)
    expect(screen.getByText('No estimate')).toBeTruthy()
    expect(screen.queryByText('$0.00')).toBeNull()
  })

  it('lists each line with quantity, unit price and source, the total and the price date', () => {
    wrap(<CostBreakdown estimate={est()} />)
    expect(screen.getByText('EC2 t3.medium')).toBeTruthy()
    expect(screen.getByText(/730 hour × \$0\.0416 · price list/)).toBeTruthy()
    expect(screen.getByText(/120 GB × \$0\.09 · measured/)).toBeTruthy()
    expect(screen.getByText('A month')).toBeTruthy()
    expect(screen.getByText(/Prices as of Nov 26/)).toBeTruthy()
    expect(screen.getByText('Tax not included.')).toBeTruthy()
  })

  it('shows a discount only as the minus line it was learned as', () => {
    wrap(
      <CostBreakdown
        estimate={est({
          lines: [
            ...est().lines,
            {
              label: 'Savings plan',
              qty: 1,
              unit: 'month',
              unitCents: -500,
              monthlyCents: -500,
              kind: 'discount',
              source: 'learned_from_bill'
            }
          ]
        })}
      />
    )
    expect(screen.getByText('−$5.00')).toBeTruthy()
    expect(screen.getByText('from your bills')).toBeTruthy()
    expect(screen.queryByText('Credits and discounts not counted.')).toBeNull()
  })
})

describe('ResourceEstimate', () => {
  const fields = [
    { key: 'name', label: 'Name', kind: 'string' as const },
    { key: 'api_key', label: 'API key', kind: 'secret' as const }
  ]

  it('asks 400 ms after the last edit, sends no secret and names the measured traffic', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    h.post.mockResolvedValue({
      data: {
        data: {
          ...est(),
          before: null,
          deltaMonthlyCents: 4820,
          traffic: { egressGbMonth: 120, source: 'measured' }
        }
      }
    })
    const view = wrap(
      <ResourceEstimate
        connectionId={4}
        type='aws.ec2_instance'
        fields={fields}
        payload={{ name: 'web', api_key: 'test-secret-x' }}
        appId={7}
        environmentId={9}
        ready
      />
    )
    // The opening figure is asked at once; each edit after it waits for 400 ms of quiet.
    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(1))
    const [url, body] = h.post.mock.calls[0]
    expect(url).toBe('/hub/providers/estimate')
    expect(body).toEqual({
      connection_id: 4,
      type: 'aws.ec2_instance',
      desired: { name: 'web', api_key: true },
      app_id: 7,
      environment_id: 9
    })
    expect(JSON.stringify(body)).not.toContain('test-secret')
    await waitFor(() => expect(view.getByText('$48.20')).toBeTruthy())
    expect(view.getByText(/120 GB a month/)).toBeTruthy()
    expect(view.getByText('(measured)')).toBeTruthy()
    view.redraw(
      <ResourceEstimate
        connectionId={4}
        type='aws.ec2_instance'
        fields={fields}
        payload={{ name: 'web-2', api_key: 'test-secret-x' }}
        appId={7}
        environmentId={9}
        ready
      />
    )
    await act(async () => {
      vi.advanceTimersByTime(200)
    })
    expect(h.post).toHaveBeenCalledTimes(1)
    await act(async () => {
      vi.advanceTimersByTime(250)
    })
    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(2))
  })

  it('sends the figure a person typed and says so', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    h.post.mockImplementation((_u: string, body: { egress_gb_month?: number }) =>
      Promise.resolve({
        data: {
          data: {
            ...est(),
            before: null,
            deltaMonthlyCents: 0,
            traffic:
              body.egress_gb_month != null
                ? { egressGbMonth: body.egress_gb_month, source: 'form' }
                : null
          }
        }
      })
    )
    const view = wrap(
      <ResourceEstimate
        connectionId={4}
        type='aws.s3_bucket'
        fields={fields}
        payload={{ name: 'b' }}
        ready
      />
    )
    await act(async () => {
      vi.advanceTimersByTime(450)
    })
    await waitFor(() => expect(view.getByText(/none assumed/)).toBeTruthy())
    fireEvent.click(view.getByRole('button', { name: 'Set' }))
    fireEvent.change(view.getByLabelText('Data out, GB a month'), { target: { value: '250' } })
    fireEvent.click(view.getByRole('button', { name: 'Done' }))
    await act(async () => {
      vi.advanceTimersByTime(450)
    })
    await waitFor(() =>
      expect(
        h.post.mock.calls.some(
          (c) => (c[1] as { egress_gb_month?: number }).egress_gb_month === 250
        )
      ).toBe(true)
    )
    await waitFor(() => expect(view.getByText('(you entered)')).toBeTruthy())
  })

  it('keeps the last figure while the next one loads', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let resolveSecond: (v: unknown) => void = () => {}
    h.post
      .mockResolvedValueOnce({
        data: { data: { ...est(), before: null, deltaMonthlyCents: 0, traffic: null } }
      })
      .mockImplementationOnce(() => new Promise((r) => (resolveSecond = r)))
    const view = wrap(
      <ResourceEstimate connectionId={4} type='t' fields={fields} payload={{ name: 'a' }} ready />
    )
    await act(async () => {
      vi.advanceTimersByTime(450)
    })
    await waitFor(() => expect(view.getByText('$48.20')).toBeTruthy())
    view.redraw(
      <ResourceEstimate connectionId={4} type='t' fields={fields} payload={{ name: 'b' }} ready />
    )
    await act(async () => {
      vi.advanceTimersByTime(450)
    })
    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(2))
    // The first figure stays on screen, marked as updating, until the second one lands.
    expect(view.getByText('$48.20')).toBeTruthy()
    expect(view.getByLabelText('Updating')).toBeTruthy()
    await act(async () => {
      resolveSecond({
        data: {
          data: { ...est({ monthlyCents: 100 }), before: null, deltaMonthlyCents: 0, traffic: null }
        }
      })
    })
    await waitFor(() => expect(view.getByText('$1.00')).toBeTruthy())
  })
})

describe('plan costs', () => {
  it('shows an operation’s now → after and the difference', () => {
    wrap(
      <BeforeAfterLine
        label='x'
        cost={{
          before: est({ monthlyCents: 6074 }),
          after: est({ monthlyCents: 13447 }),
          deltaMonthlyCents: 7373
        }}
      />
    )
    expect(screen.getByText('$60.74')).toBeTruthy()
    expect(screen.getByText('$134.47')).toBeTruthy()
    expect(screen.getByText('(+$73.73 a month)')).toBeTruthy()
  })

  it('a delete reads as the saving', () => {
    wrap(
      <BeforeAfterLine label='x' cost={{ before: est(), after: null, deltaMonthlyCents: -4820 }} />
    )
    expect(screen.getByText('nothing')).toBeTruthy()
    expect(screen.getByText('(−$48.20 a month)')).toBeTruthy()
  })

  it('the total row names once, a year, the unknown parts and when prices were checked', () => {
    wrap(
      <PlanCostTotalRow
        currency='USD'
        approval
        total={{
          deltaMonthlyCents: 7373,
          oneTimeCents: 1200,
          yearlyCents: 1500,
          unknownOps: 2,
          checkedAt: new Date(Date.now() - 5 * 60_000).toISOString()
        }}
      />
    )
    expect(screen.getByText('+$73.73 a month · $12.00 once · $15.00 a year')).toBeTruthy()
    expect(screen.getByText('2 parts have no estimate')).toBeTruthy()
    expect(screen.getByText(/Prices checked/)).toBeTruthy()
    expect(screen.getByText('Estimated cost of what you approve')).toBeTruthy()
  })
})

describe('Costs → Now', () => {
  const live = {
    currency: 'USD',
    sampledAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    nowCents: 31571,
    monthToDateCents: 27383,
    forecastCents: 31396,
    month: '2026-11',
    billed: null,
    gapCents: null,
    byApp: [{ app_id: 1, nowCents: 25186, monthToDateCents: 21845, forecastCents: 25046 }],
    byProvider: [{ provider: 'aws', nowCents: 16071, monthToDateCents: 13939 }],
    series: []
  }
  const budget = {
    app_id: 1,
    monthly_cents: 25000,
    auto_approve_under_cents: null,
    last_alert_month: null,
    last_alert_pct: null,
    updated_by: null,
    updated_at: null
  }
  const routes = (url: string) => {
    if (url.startsWith('/hub/costs/live')) return { data: { data: live } }
    if (url === '/hub/apps')
      return { data: { data: [{ id: 1, key: 'orders', name: 'Orders portal' }] } }
    if (url === '/hub/apps/1/cost-budget') return { data: { data: budget } }
    if (url === '/hub/costs/settings')
      return { data: { data: { cost_auto_approve_under_cents: 2000 } } }
    if (url === '/hub/provider-types') return { data: { data: { providers: [] } } }
    throw new Error(`unexpected ${url}`)
  }

  it('shows now, month to date, forecast and No bill yet without a cost feed', async () => {
    h.get.mockImplementation((url: string) => Promise.resolve(routes(url)))
    wrap(<HubCostsNow isAdmin />)
    await waitFor(() => expect(screen.getByText('$315.71/mo')).toBeTruthy())
    expect(screen.getByText('$273.83')).toBeTruthy()
    expect(screen.getByText('$313.96')).toBeTruthy()
    expect(screen.getByText('No bill yet')).toBeTruthy()
    await waitFor(() => expect(screen.getByText(/\$250\.46 of \$250\.00/)).toBeTruthy())
    expect(screen.getByText(/over budget/)).toBeTruthy()
  })

  it('shows Billed through its date with the gap', async () => {
    h.get.mockImplementation((url: string) =>
      Promise.resolve(
        url.startsWith('/hub/costs/live')
          ? {
              data: {
                data: {
                  ...live,
                  billed: { throughDate: '2026-11-24', monthToDateCents: 26000 },
                  gapCents: 1200
                }
              }
            }
          : routes(url)
      )
    )
    wrap(<HubCostsNow isAdmin />)
    await waitFor(() => expect(screen.getByText('$260.00')).toBeTruthy())
    expect(screen.getByText(/Through Nov 24, 2026, \+\$12\.00 against the estimate/)).toBeTruthy()
  })

  it('owners see budgets read only; admins edit them and the Hub-wide amount', async () => {
    h.get.mockImplementation((url: string) => Promise.resolve(routes(url)))
    const owner = wrap(<HubCostsNow isAdmin={false} />)
    await waitFor(() => expect(owner.getByText(/\$250\.46 of \$250\.00/)).toBeTruthy())
    expect(owner.queryByRole('button', { name: /Edit the budget/ })).toBeNull()
    expect(owner.queryByLabelText(/Approve without asking under/)).toBeNull()
    expect(owner.getByText(/less than \$20\.00 a month/)).toBeTruthy()
    owner.unmount()

    h.put.mockResolvedValue({ data: { data: { ...budget, monthly_cents: 30000 } } })
    const admin = wrap(<HubCostsNow isAdmin />)
    const edit = await admin.findByRole('button', { name: 'Edit the budget of Orders portal' })
    fireEvent.click(edit)
    const input = await admin.findByLabelText('Budget a month (USD)')
    fireEvent.change(input, { target: { value: '300' } })
    fireEvent.click(
      within(input.closest('form') as HTMLElement).getByRole('button', { name: 'Save' })
    )
    await waitFor(() =>
      expect(h.put).toHaveBeenCalledWith('/hub/apps/1/cost-budget', {
        monthly_cents: 30000,
        auto_approve_under_cents: null
      })
    )
    const auto = admin.getByLabelText(/Approve without asking under/)
    fireEvent.change(auto, { target: { value: '35' } })
    const card = auto.closest('form') as HTMLElement
    fireEvent.click(within(card).getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(h.put).toHaveBeenCalledWith('/hub/costs/settings', {
        cost_auto_approve_under_cents: 3500
      })
    )
  })

  it('a stopped sampler reads as not sampled, never as nothing running', async () => {
    h.get.mockImplementation((url: string) =>
      Promise.resolve(
        url.startsWith('/hub/costs/live')
          ? {
              data: {
                data: {
                  ...live,
                  nowCents: 0,
                  sampledAt: new Date(Date.now() - 3 * 3600_000).toISOString()
                }
              }
            }
          : routes(url)
      )
    )
    wrap(<HubCostsNow isAdmin />)
    await waitFor(() => expect(screen.getByText('Not sampled')).toBeTruthy())
    expect(screen.queryByText('Nothing priced runs now')).toBeNull()
  })
})
