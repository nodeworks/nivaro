// #2851 The Traffic Map's "Inject fault here" deep link opens the start form aimed at the node.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, type vi } from 'vitest'
import { api } from '@/lib/api'
import type { CatalogFault } from './api'
import { FaultsTab } from './FaultsTab'
import { linkedTarget } from './StartForm'

const getMock = api.get as unknown as ReturnType<typeof vi.fn>
const fault: CatalogFault = {
  key: 'slow_requests',
  label: 'Slow requests',
  area: 'http',
  proves: 'Slow answers stay honest.',
  claim_keys: [],
  targets: ['all', 'route', 'share'],
  params: {},
  max_seconds: 300,
  default_seconds: 30,
  points: ['http.request'],
  danger: 'low',
  hypothesis_defaults: [],
  console_href: null,
  last_run: null
}

beforeEach(() => {
  getMock.mockReset()
  getMock.mockImplementation((url: string) =>
    Promise.resolve({
      data: {
        data:
          url === '/chaos/catalog'
            ? { refusal: null, store: 'memory', faults: [fault] }
            : url === '/chaos/status'
              ? { allowed: true, reason: null, armed: [], nodes: ['api-1'] }
              : { ok: true, checks: [] }
      }
    })
  )
})

describe('chaos console deep link', () => {
  it('parses ?target= against what the fault takes', () => {
    expect(linkedTarget('route:/api/items/orders*', fault)).toEqual({
      kind: 'route',
      value: '/api/items/orders*'
    })
    expect(linkedTarget('all', fault)).toEqual({ kind: 'all', value: '' })
    expect(linkedTarget('table:orders', fault)).toBeNull()
    expect(linkedTarget('route:', fault)).toBeNull()
    expect(linkedTarget(null, fault)).toBeNull()
  })

  it('?fault=&target= opens that fault’s form aimed at the route', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter
          initialEntries={[
            '/chaos?tab=faults&fault=slow_requests&target=route%3A%2Fapi%2Fitems%2Forders*'
          ]}
        >
          <FaultsTab />
        </MemoryRouter>
      </QueryClientProvider>
    )
    await screen.findByText('Slow requests')
    await waitFor(() => expect(screen.getByDisplayValue('/api/items/orders*')).toBeTruthy())
    expect(screen.getByText('Close')).toBeTruthy()
  })
})
