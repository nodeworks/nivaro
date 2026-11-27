import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { toast } from 'sonner'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub (phase 4): the Docker driver form — Generate makes a 64-hex token shown once, the
// DNS mode picks the field the agent needs, switching kind starts clean, Check agent reads the
// agent's version, edge mode and allow-lists, and every refusal is in plain words.

// jsdom has no layout or pointer capture; Radix Select needs them to open.
const proto = Element.prototype as unknown as Record<string, unknown>
proto.scrollIntoView ??= vi.fn()
proto.hasPointerCapture ??= () => false
proto.releasePointerCapture ??= vi.fn()
const openSelect = (el: HTMLElement) => fireEvent.keyDown(el, { key: 'Enter' })

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string, config?: unknown) => h.get(url, config),
    post: (url: string, body?: unknown) => h.post(url, body),
    patch: (url: string, body?: unknown) => h.patch(url, body),
    put: vi.fn(),
    delete: vi.fn()
  }
}))
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: { is_admin: true } }) }))

const { default: HubDrivers } = await import('../HubDrivers')
const { dockerConfigBody, dockerDraftErrors, generateAgentToken } = await import('./docker-api')
const { hubError } = await import('../hub-api')

const dockerDriver = {
  id: 9,
  kind: 'docker',
  name: 'Swarm A',
  config: {
    agent_url: 'https://swarm.example.com:8443',
    dns_mode: 'automatic',
    wildcard_domain: 'apps.example.com',
    edge_target: null
  },
  secret: '••••••'
}

function setup(path = '/?new=1', drivers: unknown[] = []) {
  h.get.mockImplementation(async (url: string) => {
    if (url === '/hub/drivers') return { data: { data: drivers } }
    if (url === '/hub/drivers/9/agent')
      return {
        data: {
          data: {
            api: 1,
            agent_version: '0.4.2',
            engine_api: '1.45',
            swarm: { manager: true, node_id: 'n1' },
            images: ['nodeworks/nivaro'],
            host_suffixes: ['.apps.example.com'],
            edge: 'traefik',
            publish_ports: null,
            extensions_shared: false,
            redis_bundled: true
          }
        }
      }
    throw new Error(`unexpected GET ${url}`)
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <HubDrivers />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

async function pickKind(label: RegExp) {
  openSelect(await screen.findByRole('combobox', { name: 'Kind' }))
  fireEvent.click(await screen.findByRole('option', { name: label }))
}

describe('Docker driver form', () => {
  afterEach(() => {
    h.get.mockReset()
    h.post.mockReset()
    h.patch.mockReset()
    vi.restoreAllMocks()
  })

  it('Generate fills a 64-hex token and shows it once with the copy line', async () => {
    setup()
    await pickKind(/^Docker/)
    fireEvent.click(await screen.findByRole('button', { name: /Generate/ }))
    const shown = (await screen.findByTestId('generated-token')).textContent ?? ''
    expect(shown).toMatch(/^[0-9a-f]{64}$/)
    expect(
      screen.getByText("Put this in the agent's token secret now — it is never shown again")
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Copy/ })).toBeInTheDocument()
    expect((screen.getByLabelText('Agent token') as HTMLInputElement).value).toBe(shown)
  })

  it('shows the Wildcard domain for automatic DNS and the Edge target for manual', async () => {
    setup()
    await pickKind(/^Docker/)
    expect(await screen.findByLabelText('Wildcard domain')).toBeInTheDocument()
    expect(screen.queryByLabelText('Edge target')).toBeNull()
    openSelect(screen.getByRole('combobox', { name: 'DNS mode' }))
    fireEvent.click(await screen.findByRole('option', { name: /^Manual/ }))
    expect(await screen.findByLabelText('Edge target')).toBeInTheDocument()
    expect(screen.queryByLabelText('Wildcard domain')).toBeNull()
  })

  it('switching kind clears the GitLab fields', async () => {
    setup()
    fireEvent.change(await screen.findByLabelText('Project'), { target: { value: 'group/repo' } })
    expect((screen.getByLabelText('Project') as HTMLInputElement).value).toBe('group/repo')
    await pickKind(/^Docker/)
    expect(screen.queryByLabelText('Project')).toBeNull()
    await pickKind(/^GitLab/)
    expect((await screen.findByLabelText('Project')) as HTMLInputElement).toHaveValue('')
  })

  it('creates a docker driver with only the fields its DNS mode needs', async () => {
    setup()
    h.post.mockResolvedValue({ data: { data: { ...dockerDriver } } })
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Swarm A' } })
    await pickKind(/^Docker/)
    fireEvent.change(await screen.findByLabelText('Agent URL'), {
      target: { value: 'https://swarm.example.com:8443/' }
    })
    fireEvent.change(screen.getByLabelText('Wildcard domain'), {
      target: { value: 'apps.example.com' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
    const token = (await screen.findByTestId('generated-token')).textContent
    fireEvent.click(screen.getByRole('button', { name: 'Add driver' }))
    await waitFor(() => expect(h.post).toHaveBeenCalled())
    expect(h.post).toHaveBeenCalledWith('/hub/drivers', {
      kind: 'docker',
      name: 'Swarm A',
      config: {
        agent_url: 'https://swarm.example.com:8443',
        dns_mode: 'automatic',
        wildcard_domain: 'apps.example.com',
        edge_target: null,
        edge_scheme: null,
        edge_port: null
      },
      secret: token
    })
  })

  it('switching kind drops the GitLab config from the POST body', async () => {
    setup()
    h.post.mockResolvedValue({ data: { data: { ...dockerDriver } } })
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Swarm A' } })
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'group/repo' } })
    await pickKind(/^Docker/)
    fireEvent.change(await screen.findByLabelText('Agent URL'), {
      target: { value: 'https://swarm.example.com:8443' }
    })
    fireEvent.change(screen.getByLabelText('Wildcard domain'), {
      target: { value: 'apps.example.com' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add driver' }))
    await waitFor(() => expect(h.post).toHaveBeenCalled())
    const body = h.post.mock.calls[0][1] as { config: Record<string, unknown> }
    expect(Object.keys(body.config).sort()).toEqual(
      ['agent_url', 'dns_mode', 'edge_port', 'edge_scheme', 'edge_target', 'wildcard_domain'].sort()
    )
    expect(JSON.stringify(body)).not.toContain('group/repo')
  })

  it('the token box is gone after switching kind', async () => {
    setup()
    await pickKind(/^Docker/)
    fireEvent.click(await screen.findByRole('button', { name: /Generate/ }))
    expect(await screen.findByTestId('generated-token')).toBeInTheDocument()
    await pickKind(/^GitLab/)
    expect(screen.queryByTestId('generated-token')).toBeNull()
    await pickKind(/^Docker/)
    expect(screen.queryByTestId('generated-token')).toBeNull()
  })

  it('keeps the token across the create to edit remount until it is confirmed', async () => {
    const list: unknown[] = []
    setup('/?new=1', list)
    h.post.mockImplementation(async () => {
      list.push(dockerDriver)
      return { data: { data: { ...dockerDriver } } }
    })
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Swarm A' } })
    await pickKind(/^Docker/)
    fireEvent.change(await screen.findByLabelText('Agent URL'), {
      target: { value: 'https://swarm.example.com:8443' }
    })
    fireEvent.change(screen.getByLabelText('Wildcard domain'), {
      target: { value: 'apps.example.com' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Generate' }))
    const token = (await screen.findByTestId('generated-token')).textContent
    fireEvent.click(screen.getByRole('button', { name: 'Add driver' }))
    expect(await screen.findByRole('button', { name: 'Check agent' })).toBeInTheDocument()
    expect(screen.getByTestId('generated-token').textContent).toBe(token)
    fireEvent.click(screen.getByRole('button', { name: "I've saved it" }))
    expect(screen.queryByTestId('generated-token')).toBeNull()
  })

  it('without a clipboard, Copy says to copy by hand', async () => {
    setup()
    const err = vi.spyOn(toast, 'error').mockImplementation(() => 0 as never)
    await pickKind(/^Docker/)
    fireEvent.click(await screen.findByRole('button', { name: /Generate/ }))
    fireEvent.click(await screen.findByRole('button', { name: /Copy/ }))
    expect(err).toHaveBeenCalledWith('Select it and copy by hand')
  })

  it('clears the agent check when the saved address changes', async () => {
    setup('/?driver=9', [dockerDriver])
    h.patch.mockResolvedValue({ data: { data: dockerDriver } })
    fireEvent.click(await screen.findByRole('button', { name: 'Check agent' }))
    expect(await screen.findByText('0.4.2')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Agent URL'), {
      target: { value: 'https://other.example.com:8443' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(h.patch).toHaveBeenCalled())
    await waitFor(() => expect(screen.queryByText('0.4.2')).toBeNull())
  })

  it('a saved driver shows only the mask, and Check agent shows what the agent reports', async () => {
    setup('/?driver=9', [dockerDriver])
    const tokenField = (await screen.findByLabelText('Agent token')) as HTMLInputElement
    expect(tokenField.value).toBe('••••••')
    expect(screen.queryByTestId('generated-token')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Check agent' }))
    expect(await screen.findByText('0.4.2')).toBeInTheDocument()
    expect(screen.getByText('Traefik (host names)')).toBeInTheDocument()
    expect(screen.getByText('nodeworks/nivaro')).toBeInTheDocument()
    expect(screen.getByText('.apps.example.com')).toBeInTheDocument()
  })

  it('an unreachable agent reads in plain words', async () => {
    setup('/?driver=9', [dockerDriver])
    const base = h.get.getMockImplementation() as (u: string) => Promise<unknown>
    h.get.mockImplementation(async (u: string) => {
      if (u === '/hub/drivers/9/agent')
        throw {
          response: { status: 502, data: { code: 'AGENT_UNREACHABLE', error: 'ECONNREFUSED' } }
        }
      return base(u)
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Check agent' }))
    expect(
      await screen.findByText('The Hub agent on the Docker host does not answer')
    ).toBeInTheDocument()
    expect(screen.queryByText(/ECONNREFUSED/)).toBeNull()
  })
})

describe('docker-api helpers', () => {
  it('generates 64 hex characters, different each time', () => {
    const a = generateAgentToken()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(generateAgentToken()).not.toBe(a)
  })

  it('sends the wildcard for automatic and the edge target for manual', () => {
    const base = {
      agent_url: 'https://a.example.com/',
      wildcard_domain: 'w.example.com',
      edge_target: 'e.example.com',
      edge_scheme: '' as const,
      edge_port: ''
    }
    expect(dockerConfigBody({ ...base, dns_mode: 'automatic' })).toEqual({
      agent_url: 'https://a.example.com',
      dns_mode: 'automatic',
      wildcard_domain: 'w.example.com',
      edge_target: null,
      edge_scheme: null,
      edge_port: null
    })
    expect(
      dockerConfigBody({
        ...base,
        dns_mode: 'automatic',
        edge_scheme: 'https',
        edge_port: ' 3280 '
      })
    ).toMatchObject({ edge_scheme: 'https', edge_port: 3280 })
    expect(
      dockerDraftErrors({ ...base, dns_mode: 'automatic', edge_port: '99999' }).edge_port
    ).toMatch(/1 to 65535/)
    expect(dockerDraftErrors({ ...base, dns_mode: 'automatic', edge_port: '3280' }).edge_port).toBe(
      ''
    )
    expect(dockerConfigBody({ ...base, dns_mode: 'manual' })).toMatchObject({
      wildcard_domain: null,
      edge_target: 'e.example.com'
    })
    expect(
      dockerDraftErrors({ ...base, agent_url: 'nope', dns_mode: 'manual', edge_target: '' })
    ).toMatchObject({
      agent_url: expect.stringMatching(/agent/i),
      edge_target: expect.stringMatching(/point at/)
    })
  })

  it('Route 53 mode sends the zone, the wildcard and the edge, and needs all three (Task 11)', () => {
    const base = {
      agent_url: 'https://a.example.com',
      wildcard_domain: 'apps.example.com',
      edge_target: '203.0.113.10',
      edge_scheme: '' as const,
      edge_port: '',
      dns_mode: 'route53' as const
    }
    expect(dockerConfigBody({ ...base, dns_zone_resource_id: 7 })).toMatchObject({
      dns_mode: 'route53',
      dns_zone_resource_id: 7,
      wildcard_domain: 'apps.example.com',
      edge_target: '203.0.113.10'
    })
    expect(
      dockerDraftErrors({
        ...base,
        dns_zone_resource_id: null,
        wildcard_domain: '',
        edge_target: ''
      })
    ).toMatchObject({
      dns_zone_resource_id: expect.stringMatching(/hosted zone/),
      wildcard_domain: expect.stringMatching(/domain/),
      edge_target: expect.stringMatching(/point at/)
    })
    expect(
      dockerConfigBody({ ...base, dns_mode: 'automatic', dns_zone_resource_id: 7 })
    ).not.toHaveProperty('dns_zone_resource_id')
  })

  it('says AGENT_UNREACHABLE with its hint', () => {
    const d = hubError({ response: { status: 502, data: { code: 'AGENT_UNREACHABLE' } } }, 'x')
    expect(d.title).toBe('The Hub agent on the Docker host does not answer')
    expect(d.hint).toMatch(/agent/)
  })
})
