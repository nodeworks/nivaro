import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub (phase 3): targets — where new apps go. The token is only ever the mask, Test shows
// the three checks, and a save says what happened to the apps already made on the target.

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() }))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string, config?: unknown) => h.get(url, config),
    post: (url: string, body?: unknown) => h.post(url, body),
    patch: (url: string, body?: unknown) => h.patch(url, body),
    put: vi.fn(),
    delete: (url: string) => h.del(url)
  }
}))

// Radix select in jsdom (the Traefik version picker).
const proto = Element.prototype as unknown as Record<string, unknown>
proto.scrollIntoView ??= vi.fn()
proto.hasPointerCapture ??= () => false
proto.releasePointerCapture ??= vi.fn()

const { HubTargets, targetDraftErrors } = await import('./HubTargets')
const { syncSummary, TEMPLATE_REF_RE } = await import('./create-api')

const target = {
  id: 3,
  kind: 'gitlab',
  name: 'Swarm one',
  secret: '••••••',
  config: {
    api: 'https://gitlab.example.com/api/v4',
    namespace: 'apps',
    template_project: 'ops/nivaro-app',
    template_ref: 'v1.2.0',
    pin_file: '.hub/nivaro-version',
    deploy_job: 'deploy',
    deploy_host: 'deploy@swarm1.example.com',
    manager_known_hosts: 'swarm1.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIExample',
    proxy_network: 'proxy',
    dns_mode: 'automatic',
    wildcard_domain: 'apps.example.com',
    edge_address: null,
    scheme: 'https',
    port: null,
    cert_note: null
  }
}

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <HubTargets />
    </QueryClientProvider>
  )
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('HubTargets', () => {
  it('lists targets with their template ref and opens one with the token masked', async () => {
    h.get.mockResolvedValue({ data: { data: [target] } })
    mount()
    expect(await screen.findByText('Swarm one')).toBeTruthy()
    expect(screen.getByText(/ops\/nivaro-app@v1\.2\.0/)).toBeTruthy()
    fireEvent.click(screen.getByText('Swarm one'))
    const token = (await screen.findByLabelText('Access token')) as HTMLInputElement
    expect(token.value).toBe('••••••')
    expect(token.type).toBe('password')
    expect((screen.getByLabelText('Template ref') as HTMLInputElement).value).toBe('v1.2.0')
  })

  it('saving without touching the token does not send it, and shows the app sync', async () => {
    h.get.mockResolvedValue({ data: { data: [target] } })
    h.patch.mockResolvedValue({
      data: {
        data: target,
        sync: [
          { app_id: 1, ok: true },
          { app_id: 2, ok: false, pending: true }
        ]
      }
    })
    mount()
    fireEvent.click(await screen.findByText('Swarm one'))
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }))
    await waitFor(() => expect(h.patch).toHaveBeenCalled())
    const [url, body] = h.patch.mock.calls[0]
    expect(url).toBe('/hub/targets/3')
    expect(body).not.toHaveProperty('secret')
    expect(JSON.stringify(body)).not.toContain('••••••')
    expect(await screen.findByText(/1 app updated, 1 finishing in the background/)).toBeTruthy()
  })

  it('P6-35: the Traefik version is saved (3 for a target saved before it), 2 when picked', async () => {
    h.get.mockResolvedValue({ data: { data: [target] } })
    h.patch.mockResolvedValue({ data: { data: target, sync: [] } })
    mount()
    fireEvent.click(await screen.findByText('Swarm one'))
    const pick = await screen.findByRole('combobox', { name: 'Traefik version' })
    expect(pick.textContent).toMatch(/3/)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(h.patch).toHaveBeenCalledTimes(1))
    expect(h.patch.mock.calls[0][1].config.traefik_version).toBe(3)
    // Radix select by keyboard: open, move to the v2 option, pick it.
    fireEvent.keyDown(pick, { key: 'Enter' })
    fireEvent.click(await screen.findByRole('option', { name: /^Traefik 2/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(h.patch).toHaveBeenCalledTimes(2))
    expect(h.patch.mock.calls[1][1].config.traefik_version).toBe(2)
  })

  it('a sync that could not start says so', async () => {
    h.get.mockResolvedValue({ data: { data: [target] } })
    h.patch.mockResolvedValue({
      data: { data: target, sync: null, sync_error: 'SYNC_READ_FAILED' }
    })
    mount()
    fireEvent.click(await screen.findByText('Swarm one'))
    fireEvent.click(await screen.findByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/could not be updated; save again/)).toBeTruthy()
  })

  it('Test shows the three checks', async () => {
    h.get.mockResolvedValue({ data: { data: [target] } })
    h.post.mockResolvedValue({
      data: {
        data: {
          ok: false,
          checks: [
            { id: 'token', ok: true, text: 'Token works (signed in as bot)' },
            { id: 'namespace', ok: false, text: 'Namespace apps found, but not a Maintainer' },
            { id: 'template', ok: true, text: 'Template ops/nivaro-app found' }
          ]
        }
      }
    })
    mount()
    fireEvent.click(await screen.findByText('Swarm one'))
    fireEvent.click(await screen.findByRole('button', { name: 'Test' }))
    expect(await screen.findByText(/Token works/)).toBeTruthy()
    expect(screen.getByText(/not a Maintainer/)).toBeTruthy()
    expect(screen.getByText(/Template ops\/nivaro-app found/)).toBeTruthy()
    expect(h.post).toHaveBeenCalledWith('/hub/targets/3/test', {})
  })

  it('Test checks the saved target: it waits while the form has unsaved edits', async () => {
    h.get.mockResolvedValue({ data: { data: [target] } })
    mount()
    fireEvent.click(await screen.findByText('Swarm one'))
    const test = (await screen.findByRole('button', { name: 'Test' })) as HTMLButtonElement
    expect(test.disabled).toBe(false)
    fireEvent.change(screen.getByLabelText('Namespace'), { target: { value: 'other' } })
    expect(test.disabled).toBe(true)
    expect(screen.getByText(/Save first: Test checks the saved settings/)).toBeTruthy()
  })

  it('a new target starts with an empty token and refuses a 10-digit major ref', async () => {
    h.get.mockResolvedValue({ data: { data: [] } })
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /New target/ }))
    expect(((await screen.findByLabelText('Access token')) as HTMLInputElement).value).toBe('')
    fireEvent.change(screen.getByLabelText('Template ref'), { target: { value: 'v1234567890' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add target' }))
    expect(await screen.findByText(/major number at most 9 digits/)).toBeTruthy()
    expect(h.post).not.toHaveBeenCalled()
  })
})

describe('target rules', () => {
  it('template ref: tags with a major of at most 9 digits, or a full sha', () => {
    expect(TEMPLATE_REF_RE.test('v1.2.0')).toBe(true)
    expect(TEMPLATE_REF_RE.test('123456789.0')).toBe(true)
    expect(TEMPLATE_REF_RE.test('v1234567890')).toBe(false)
    expect(TEMPLATE_REF_RE.test('a'.repeat(40))).toBe(true)
    expect(TEMPLATE_REF_RE.test('main')).toBe(false)
  })

  it('automatic names need a wildcard domain', () => {
    const errs = targetDraftErrors({
      name: 'x',
      api: 'https://g/api/v4',
      namespace: 'a',
      template_project: 'b/c',
      template_ref: 'v1',
      pin_file: '',
      deploy_job: '',
      deploy_host: 'h',
      manager_known_hosts: 'h ssh-ed25519 AAAA',
      proxy_network: '',
      dns_mode: 'automatic',
      wildcard_domain: '',
      edge_address: '',
      scheme: 'https',
      port: '',
      cert_note: '',
      traefik_version: '3'
    })
    expect(errs.wildcard_domain).toBeTruthy()
  })

  it('syncSummary is null when no app was made on the target', () => {
    expect(syncSummary({ sync: [] })).toBeNull()
  })
})
