import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub (phase 2): a Hub admin orders an environment's deploy components and turns on
// "the Hub deploys this environment" from the environment's edit panel.

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() }))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string, config?: unknown) => h.get(url, config),
    post: (url: string, body?: unknown) => h.post(url, body),
    patch: (url: string, body?: unknown) => h.patch(url, body),
    put: vi.fn(),
    delete: (url: string) => h.delete(url)
  }
}))

const { HubComponentsEditor } = await import('./HubComponentsEditor')

const env = {
  id: 10,
  app_id: 1,
  key: 'production',
  position: 2,
  status: 'active',
  base_url: 'https://efp.example.com',
  hostnames: [],
  placement_id: 5,
  version_pin: null,
  hub_token: null,
  hub_managed: false
}

const drivers = [
  {
    id: 7,
    kind: 'gitlab',
    name: 'efp-nivaro',
    config: {
      api: 'https://gitlab.example.com/api/v4',
      project: 'efp/efp-nivaro',
      branch: 'production',
      pin_file: 'nivaro.pin',
      deploy_job: 'deploy_production'
    },
    secret: '••••••'
  }
]

const implicit = {
  id: null,
  placement_id: 5,
  position: 1,
  name: 'api',
  kind: 'api',
  driver_id: 7,
  source_branch: 'main',
  target_branch: null,
  before_job: null,
  deploy_job: null,
  verify_url: null,
  verify_field: 'version',
  implicit: true
}

const stored = {
  ...implicit,
  id: 31,
  implicit: undefined,
  verify_url: 'https://efp.example.com/api/version'
}

function setup(components: unknown[]) {
  h.get.mockImplementation(async (url: string) => {
    if (url === '/hub/placements/5/components') return { data: { data: components } }
    if (url === '/hub/drivers') return { data: { data: drivers } }
    throw new Error(`unexpected GET ${url}`)
  })
  h.post.mockImplementation(async (_url: string, body: { position: number }) => ({
    data: { data: { ...body, id: 40 + body.position } }
  }))
  h.patch.mockResolvedValue({ data: { data: {} } })
  h.delete.mockResolvedValue({ data: {} })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <HubComponentsEditor appId={1} env={env} idPrefix='c' />
    </QueryClientProvider>
  )
}

describe('HubComponentsEditor', () => {
  afterEach(() => {
    h.get.mockReset()
    h.post.mockReset()
    h.patch.mockReset()
    h.delete.mockReset()
  })

  it('shows the implicit component from the driver, which cannot be removed', async () => {
    setup([implicit])
    const list = await screen.findByRole('list', { name: 'Deploy components' })
    const items = within(list).getAllByRole('listitem')
    expect(items).toHaveLength(1)
    expect(within(items[0]).getByText(/From the environment's driver/)).toBeInTheDocument()
    expect(within(items[0]).getByText('efp-nivaro')).toBeInTheDocument()
    expect(within(items[0]).queryByRole('button', { name: /Remove/ })).toBeNull()
  })

  it('turns on Hub deploys for the environment', async () => {
    setup([stored])
    const sw = await screen.findByRole('switch', { name: 'The Hub deploys this environment' })
    expect(sw).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(sw)
    await waitFor(() =>
      expect(h.patch).toHaveBeenCalledWith('/hub/environments/10', { hub_managed: true })
    )
  })

  it('refuses a check address that is not http(s), then stores the implicit one first', async () => {
    setup([implicit])
    await screen.findByRole('list', { name: 'Deploy components' })
    fireEvent.click(screen.getByRole('button', { name: 'Add component' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'frontend' } })
    fireEvent.change(screen.getByLabelText('Check address'), { target: { value: 'efp.example' } })
    expect(screen.getByText(/Use a full http\(s\) address/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save component' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Check address'), {
      target: { value: 'https://efp.example.com/version.json' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save component' }))
    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(2))
    // The driver's stand-in is stored at position 1 first, or adding a component would drop it.
    expect(h.post.mock.calls[0]).toEqual([
      '/hub/placements/5/components',
      expect.objectContaining({ position: 1, kind: 'api', name: 'api', driver_id: 7 })
    ])
    expect(h.post.mock.calls[1]).toEqual([
      '/hub/placements/5/components',
      expect.objectContaining({
        position: 2,
        kind: 'frontend',
        name: 'frontend',
        driver_id: 7,
        source_branch: 'main',
        verify_url: 'https://efp.example.com/version.json'
      })
    ])
  })

  it('edits a stored component and removes it with a second press', async () => {
    setup([stored])
    const list = await screen.findByRole('list', { name: 'Deploy components' })
    fireEvent.click(within(list).getByRole('button', { name: 'Edit api' }))
    fireEvent.change(screen.getByLabelText('Before job'), { target: { value: 'build_extension' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save component' }))
    await waitFor(() =>
      expect(h.patch).toHaveBeenCalledWith(
        '/hub/components/31',
        expect.objectContaining({ before_job: 'build_extension', target_branch: null })
      )
    )
    fireEvent.click(await within(list).findByRole('button', { name: 'Remove api' }))
    fireEvent.click(within(list).getByRole('button', { name: /Remove\?/ }))
    await waitFor(() => expect(h.delete).toHaveBeenCalledWith('/hub/components/31'))
  })
})
