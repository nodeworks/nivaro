import { readFileSync } from 'node:fs'
import { join } from 'node:path'
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

const { HubTargets, githubTargetDraftErrors, hostnameErrors, targetDraftErrors } = await import(
  './HubTargets'
)
const { syncSummary, TEMPLATE_REF_RE } = await import('./create-api')
// Task 33b: the DNS mode picker on Docker drivers and targets offers every mode the API accepts.
const { DNS_MODES, dnsModeOf, dnsModeOptions, MANAGED_DNS, withDnsMode, zoneBody, zoneFieldWords } =
  await import('../dns-modes')
const { dockerConfigBody, dockerDraftErrors, dockerDraftOf, EMPTY_DOCKER_DRAFT } = await import(
  '../docker/docker-api'
)

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

  it('G-A: a target that uses a GitLab connection sends no address and no token', async () => {
    const viaConn = {
      ...target,
      secret: null,
      connection_id: 5,
      connection: { id: 5, name: 'GitLab apps', problem: null },
      config: { ...target.config, api: 'https://gitlab.example.com' }
    }
    h.get.mockImplementation(async (url: string) =>
      url.includes('connections')
        ? {
            data: {
              data: [
                {
                  id: 5,
                  provider: 'gitlab',
                  name: 'GitLab apps',
                  config: { baseUrl: 'https://gitlab.example.com', groupPath: 'apps' }
                }
              ]
            }
          }
        : { data: { data: [viaConn] } }
    )
    h.patch.mockResolvedValue({ data: { data: viaConn, sync: [] } })
    mount()
    expect(await screen.findByText('Through GitLab apps')).toBeTruthy()
    fireEvent.click(screen.getByText('Swarm one'))
    expect(screen.queryByLabelText('Access token')).toBeNull()
    expect(screen.queryByLabelText('GitLab API URL')).toBeNull()
    await waitFor(() =>
      expect((screen.getByLabelText('Address and group') as HTMLInputElement).value).toBe(
        'https://gitlab.example.com · apps'
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(h.patch).toHaveBeenCalled())
    const [, body] = h.patch.mock.calls[0]
    expect(body.connection_id).toBe(5)
    expect(body).not.toHaveProperty('secret')
    expect(body.config).not.toHaveProperty('api')
    // Back to an own token: the address and token fields return, and connection_id is null.
    fireEvent.click(screen.getByRole('button', { name: 'Own token' }))
    expect(screen.getByLabelText('Access token')).toBeTruthy()
    const draft = {
      name: 'x',
      api: '',
      namespace: 'apps',
      template_project: 'apps/t',
      template_ref: 'v1',
      pin_file: '',
      deploy_job: '',
      deploy_host: 'h',
      manager_known_hosts: 'h ssh-ed25519 AAAA',
      proxy_network: '',
      dns_mode: 'manual' as const,
      dns_zone_resource_id: null,
      wildcard_domain: '',
      edge_address: '',
      scheme: 'https' as const,
      port: '',
      cert_note: '',
      traefik_version: '3' as const
    }
    // A connection target needs a connection, never an address; an own-token one the reverse.
    const viaErrs = targetDraftErrors({ ...draft, source: 'connection', connection_id: null })
    expect(viaErrs.connection_id).toBeTruthy()
    expect(viaErrs.api).toBeUndefined()
    expect(targetDraftErrors({ ...draft, source: 'connection', connection_id: 5 })).toEqual({})
    expect(targetDraftErrors(draft).api).toBeTruthy()
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
      dns_zone_resource_id: null,
      wildcard_domain: '',
      edge_address: '',
      scheme: 'https',
      port: '',
      cert_note: '',
      traefik_version: '3'
    })
    expect(errs.wildcard_domain).toBeTruthy()
  })

  it('Route 53 names need a hosted zone and an edge address (Task 11)', () => {
    const base = {
      dns_mode: 'route53' as const,
      dns_zone_resource_id: null,
      wildcard_domain: 'apps.example.com',
      edge_address: '',
      scheme: 'https' as const,
      port: '',
      cert_note: ''
    }
    const errs = hostnameErrors(base)
    expect(errs.dns_zone_resource_id).toBeTruthy()
    expect(errs.edge_address).toBeTruthy()
    expect(
      hostnameErrors({ ...base, dns_zone_resource_id: 4, edge_address: '203.0.113.10' })
    ).toEqual({})
  })

  it('a GitHub target needs a connection, a template repository and a workflow file (Task 11)', () => {
    const errs = githubTargetDraftErrors({
      name: 'Repos',
      connection_id: null,
      template: 'not-a-repo',
      visibility: 'private',
      deploy_workflow: 'deploy',
      source_branch: 'main',
      dns_mode: 'manual',
      dns_zone_resource_id: null,
      wildcard_domain: '',
      edge_address: '',
      scheme: 'https',
      port: '',
      cert_note: ''
    })
    expect(errs.connection_id).toBeTruthy()
    expect(errs.template).toBeTruthy()
    expect(errs.deploy_workflow).toBeTruthy()
    expect(errs.name).toBeUndefined()
  })

  it('syncSummary is null when no app was made on the target', () => {
    expect(syncSummary({ sync: [] })).toBeNull()
  })
})

const API = join(import.meta.dirname, '../../../../../api/src/services/hub/create/dns.ts')

describe('DNS modes', () => {
  it('match the API: every mode, and each managed one with its zone type', () => {
    const src = readFileSync(API, 'utf8')
    const line = src.slice(
      src.indexOf('export const DNS_MODES'),
      src.indexOf('\n', src.indexOf('export const DNS_MODES'))
    )
    const api = [...line.matchAll(/'([a-z0-9]+)'/g)].map((m) => m[1])
    expect([...DNS_MODES].sort()).toEqual([...api].sort())
    for (const [mode, info] of Object.entries(MANAGED_DNS))
      expect(src).toMatch(new RegExp(`${mode}: \\{ zone: '${info.zoneType.replace('.', '\\.')}'`))
  })

  it('the picker lists every mode; a managed one is named by its provider', () => {
    const opts = dnsModeOptions({ automatic: 'Automatic', manual: 'By hand' })
    expect(opts.map((o) => o.value)).toEqual(['automatic', 'route53', 'cloudflare', 'manual'])
    expect(opts.find((o) => o.value === 'cloudflare')?.label).toBe(
      'Cloudflare (the Hub adds each name)'
    )
  })

  it('a zone picked for one provider never carries to another', () => {
    const d = { dns_mode: 'route53' as const, dns_zone_resource_id: 7 }
    expect(withDnsMode(d, 'cloudflare')).toEqual({
      dns_mode: 'cloudflare',
      dns_zone_resource_id: null
    })
    expect(withDnsMode(d, 'route53')).toEqual({ dns_mode: 'route53' })
    expect(zoneBody({ dns_mode: 'cloudflare', dns_zone_resource_id: 9 })).toEqual({
      dns_zone_resource_id: 9
    })
    expect(zoneBody({ dns_mode: 'automatic', dns_zone_resource_id: 9 })).toEqual({})
    expect(dnsModeOf('cloudflare')).toBe('cloudflare')
    expect(dnsModeOf('bogus')).toBe('automatic')
  })

  it('a Docker driver in Cloudflare mode needs its zone and sends it', () => {
    const d = {
      ...EMPTY_DOCKER_DRAFT,
      agent_url: 'https://swarm.example.com:8443',
      dns_mode: 'cloudflare' as const,
      wildcard_domain: 'apps.example.com',
      edge_target: 'edge.example.com'
    }
    expect(dockerDraftErrors(d).dns_zone_resource_id).toBe(zoneFieldWords('cloudflare').missing)
    const body = dockerConfigBody({ ...d, dns_zone_resource_id: 12 })
    expect(body).toMatchObject({ dns_mode: 'cloudflare', dns_zone_resource_id: 12 })
    expect(
      dockerDraftOf({ dns_mode: 'cloudflare', dns_zone_resource_id: 12 } as never)
    ).toMatchObject({ dns_mode: 'cloudflare', dns_zone_resource_id: 12 })
  })

  it('a target in Cloudflare mode needs a zone and the edge address', () => {
    const e = hostnameErrors({
      dns_mode: 'cloudflare',
      dns_zone_resource_id: null,
      wildcard_domain: 'apps.example.com',
      edge_address: '',
      scheme: 'https',
      port: '',
      cert_note: ''
    })
    expect(e.dns_zone_resource_id).toBe('Pick the Cloudflare zone the names go in')
    expect(e.edge_address).toMatch(/^Cloudflare records point at the edge/)
  })
})
