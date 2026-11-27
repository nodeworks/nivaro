import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub (phase 2): a Hub admin orders an environment's deploy components and turns on
// "the Hub deploys this environment" from the environment's edit panel.

// jsdom has no layout or pointer capture; Radix Select needs them to open.
const proto = Element.prototype as unknown as Record<string, unknown>
proto.scrollIntoView ??= vi.fn()
proto.hasPointerCapture ??= () => false
proto.releasePointerCapture ??= vi.fn()
const openSelect = (el: HTMLElement) => fireEvent.keyDown(el, { key: 'Enter' })

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

const workflows = [
  {
    id: 12,
    connection_id: 3,
    provider: 'github',
    type: 'github.workflow',
    external_id: 'acme/efp#deploy.yml',
    name: 'deploy.yml',
    scope: 'app',
    app_id: 1,
    environment_id: null,
    deleted_at: null
  }
]

function setup(components: unknown[]) {
  h.get.mockImplementation(async (url: string) => {
    if (url === '/hub/placements/5/components') return { data: { data: components } }
    if (url === '/hub/drivers') return { data: { data: drivers } }
    if (url === '/hub/resources') return { data: { data: workflows } }
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

  it("P23/P29: the stand-in shows the placement's branch and is stored with it", async () => {
    setup([{ ...implicit, target_branch: 'qa' }])
    const list = await screen.findByRole('list', { name: 'Deploy components' })
    expect(within(list).getByText('main → qa')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Add component' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'frontend' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save component' }))
    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(2))
    expect(h.post.mock.calls[0]).toEqual([
      '/hub/placements/5/components',
      expect.objectContaining({ position: 1, kind: 'api', target_branch: 'qa' })
    ])
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

describe('fix round 1', () => {
  afterEach(() => {
    h.get.mockReset()
    h.post.mockReset()
    h.patch.mockReset()
    h.delete.mockReset()
  })

  it('recovers when the new component fails after the implicit one was stored', async () => {
    let components: unknown[] = [implicit]
    h.get.mockImplementation(async (url: string) => {
      if (url === '/hub/placements/5/components') return { data: { data: components } }
      if (url === '/hub/drivers') return { data: { data: drivers } }
      throw new Error(`unexpected GET ${url}`)
    })
    let failNext = true
    h.post.mockImplementation(async (_url: string, body: { position: number }) => {
      if (body.position === 1) {
        components = [{ ...implicit, id: 41, implicit: undefined }]
        return { data: { data: { ...body, id: 41 } } }
      }
      if (failNext) {
        failNext = false
        throw { response: { status: 502, data: { code: 'GITLAB_UNREACHABLE' } } }
      }
      return { data: { data: { ...body, id: 42 } } }
    })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } })
    render(
      <QueryClientProvider client={qc}>
        <HubComponentsEditor appId={1} env={env} idPrefix='c' />
      </QueryClientProvider>
    )
    await screen.findByRole('list', { name: 'Deploy components' })
    fireEvent.click(screen.getByRole('button', { name: 'Add component' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'frontend' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save component' }))
    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(2))
    // The stored list is read again, so the stand-in now shows as stored.
    await waitFor(() => expect(screen.queryByText(/From the environment's driver/)).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: 'Save component' }))
    await waitFor(() => expect(h.post).toHaveBeenCalledTimes(3))
    // The retry stores only the new component; the stand-in is never posted twice.
    expect(h.post.mock.calls[2][1]).toEqual(
      expect.objectContaining({ position: 2, name: 'frontend' })
    )
    expect(
      h.post.mock.calls.filter(([, b]) => (b as { position: number }).position === 1)
    ).toHaveLength(1)
  })

  it('puts both rows back when moving a component up fails half way', async () => {
    const second = { ...stored, id: 32, position: 2, name: 'frontend', kind: 'frontend' }
    setup([stored, second])
    h.patch.mockImplementation(async (url: string, body: { position: number }) => {
      // The third step (api → position 2) fails.
      if (url === '/hub/components/31' && body.position === 2) throw { response: { status: 500 } }
      return { data: { data: {} } }
    })
    const list = await screen.findByRole('list', { name: 'Deploy components' })
    fireEvent.click(within(list).getByRole('button', { name: 'Move frontend up' }))
    await waitFor(() => expect(h.patch).toHaveBeenCalledTimes(5))
    expect(h.patch.mock.calls.map(([u, b]) => [u, (b as { position: number }).position])).toEqual([
      ['/hub/components/31', 3],
      ['/hub/components/32', 1],
      ['/hub/components/31', 2],
      ['/hub/components/32', 2],
      ['/hub/components/31', 1]
    ])
  })

  it('phase 4: a stack is offered only for a Docker driver and hides the GitLab fields', async () => {
    const docker = {
      id: 9,
      kind: 'docker',
      name: 'Swarm A',
      config: { agent_url: 'https://swarm.example.com:8443', dns_mode: 'automatic' },
      secret: '••••••'
    }
    h.get.mockImplementation(async (url: string) => {
      if (url === '/hub/placements/5/components') return { data: { data: [implicit] } }
      if (url === '/hub/drivers') return { data: { data: [...drivers, docker] } }
      throw new Error(`unexpected GET ${url}`)
    })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <HubComponentsEditor appId={1} env={env} idPrefix='c' />
      </QueryClientProvider>
    )
    await screen.findByRole('list', { name: 'Deploy components' })
    fireEvent.click(screen.getByRole('button', { name: 'Add component' }))
    // GitLab driver: API and frontend, never a stack; the branch fields show.
    openSelect(screen.getByRole('combobox', { name: 'Kind' }))
    expect(screen.queryByRole('option', { name: /^Stack/ })).toBeNull()
    expect(screen.getByRole('option', { name: /^API/ })).toBeInTheDocument()
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })
    expect(screen.getByLabelText('Source branch')).toBeInTheDocument()
    // Docker driver: only the stack; branch and job fields are gone.
    openSelect(screen.getByRole('combobox', { name: 'Driver' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Swarm A' }))
    openSelect(screen.getByRole('combobox', { name: 'Kind' }))
    expect(await screen.findByRole('option', { name: /^Stack/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /^API/ })).toBeNull()
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' })
    expect(screen.queryByLabelText('Source branch')).toBeNull()
    expect(screen.queryByLabelText('Target branch')).toBeNull()
    expect(screen.queryByLabelText('Before job')).toBeNull()
    expect(screen.queryByLabelText('Deploy job')).toBeNull()
  })

  it('phase 4: going back to GitLab restores the previous kind, and a stack body has no source branch', async () => {
    const docker = {
      id: 9,
      kind: 'docker',
      name: 'Swarm A',
      config: { agent_url: 'https://swarm.example.com:8443', dns_mode: 'automatic' },
      secret: '••••••'
    }
    h.get.mockImplementation(async (url: string) => {
      if (url === '/hub/placements/5/components') return { data: { data: [stored] } }
      if (url === '/hub/drivers') return { data: { data: [...drivers, docker] } }
      throw new Error(`unexpected GET ${url}`)
    })
    h.post.mockResolvedValue({ data: { data: {} } })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <HubComponentsEditor appId={1} env={env} idPrefix='c' />
      </QueryClientProvider>
    )
    await screen.findByRole('list', { name: 'Deploy components' })
    fireEvent.click(screen.getByRole('button', { name: 'Add component' }))
    // A second component defaults to a frontend; docker and back keeps it.
    expect(screen.getByRole('combobox', { name: 'Kind' })).toHaveTextContent(/Frontend/)
    openSelect(screen.getByRole('combobox', { name: 'Driver' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Swarm A' }))
    openSelect(screen.getByRole('combobox', { name: 'Driver' }))
    fireEvent.click(await screen.findByRole('option', { name: drivers[0].name }))
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Kind' })).toHaveTextContent(/Frontend/)
    )
    // Stack body: no source_branch key.
    openSelect(screen.getByRole('combobox', { name: 'Driver' }))
    fireEvent.click(await screen.findByRole('option', { name: 'Swarm A' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'stack' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save component' }))
    await waitFor(() => expect(h.post).toHaveBeenCalled())
    const body = h.post.mock.calls.at(-1)?.[1] as Record<string, unknown>
    expect(body.kind).toBe('stack')
    expect('source_branch' in body).toBe(false)
  })
})

describe('provider components (Task 11)', () => {
  afterEach(() => {
    h.get.mockReset()
    h.patch.mockReset()
  })

  it('a GitHub Actions component approves the waiting run on a named GitHub environment', async () => {
    setup([
      {
        ...stored,
        id: 32,
        name: 'deploy',
        kind: 'github_actions',
        driver_id: 0,
        resource_id: 12,
        deploy_job: null
      }
    ])
    const list = await screen.findByRole('list', { name: 'Deploy components' })
    expect(within(list).getByText('GitHub Actions')).toBeTruthy()
    expect(within(list).getByText(/runs the workflow with the version/)).toBeTruthy()
    fireEvent.click(within(list).getByRole('button', { name: 'Edit deploy' }))
    expect(screen.queryByLabelText('Driver')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Approve the waiting run' }))
    fireEvent.change(screen.getByLabelText('GitHub environment'), {
      target: { value: 'prod-gh' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save component' }))
    await waitFor(() =>
      expect(h.patch).toHaveBeenCalledWith(
        '/hub/components/32',
        expect.objectContaining({
          kind: 'github_actions',
          resource_id: 12,
          deploy_job: 'approve:prod-gh',
          source_branch: 'main'
        })
      )
    )
    const body = h.patch.mock.calls[0][1] as Record<string, unknown>
    expect(body).not.toHaveProperty('driver_id')
  })
})
