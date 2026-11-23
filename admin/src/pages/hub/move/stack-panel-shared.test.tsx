import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// Ruling P6-17 I-3: an environment on a shared deployment has no stack of its own. Its stack
// read answers 409 SHARED_PLACEMENT; the panel then renders nothing and never polls (owners
// cannot read placements, so the panel is mounted for them).

const h = vi.hoisted(() => ({ get: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => h.get(url),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn()
  }
}))

const { HubStackPanel, stackRefetchInterval } = await import('../docker/HubStackPanel')

const refusal = { response: { status: 409, data: { code: 'SHARED_PLACEMENT', error: 'shared' } } }

describe('HubStackPanel on a shared-placed environment', () => {
  it('renders nothing for SHARED_PLACEMENT', async () => {
    h.get.mockRejectedValue(refusal)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { container } = render(
      <QueryClientProvider client={qc}>
        <HubStackPanel
          env={{
            id: 10,
            app_id: 1,
            key: 'production',
            position: 0,
            status: 'active',
            base_url: 'https://efp.example.com',
            hostnames: [],
            placement_id: 9,
            version_pin: null,
            hub_token: null
          }}
          appId={1}
          isAdmin={false}
          layout='card'
        />
      </QueryClientProvider>
    )
    await waitFor(() => expect(h.get).toHaveBeenCalled())
    await waitFor(() => expect(qc.getQueryCache().getAll()[0]?.state.status).toBe('error'))
    expect(container).toBeEmptyDOMElement()
  })

  it('never polls after SHARED_PLACEMENT', () => {
    expect(stackRefetchInterval({ state: { error: refusal } })).toBe(false)
  })
})
