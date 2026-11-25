import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub (phase 4): the stack panel — owners see status + Restart only; admins also get
// settings and Remove; confirms are typed inline.

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), put: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => h.get(url),
    post: (url: string, body?: unknown) => h.post(url, body),
    put: (url: string, body?: unknown) => h.put(url, body),
    patch: vi.fn(),
    delete: vi.fn()
  }
}))

const { HubStackPanel, stackRefetchInterval } = await import('./HubStackPanel')
const { stackKeys } = await import('./stack-api')

const env = {
  id: 5,
  app_id: 1,
  key: 'staging',
  position: 0,
  status: 'active',
  base_url: 'https://s.example.com',
  hostnames: [],
  placement_id: 7,
  version_pin: '1.0.0',
  hub_token: null
}

const status = (state: string) => ({
  name: 'efp-staging',
  image: 'nodeworks/nivaro@sha256:0123456789abcdef0123',
  state,
  published_port: null,
  services: [
    {
      name: 's_web',
      role: 'web',
      image: 'x',
      replicas: { desired: 2, running: 2 },
      update: 'completed',
      message: null
    }
  ]
})

function setup(
  opts: {
    state?: string
    agent?: string
    settings?: unknown
    nodes?: number | null
    onShare?: boolean
    leftovers?: unknown
    noStatus?: boolean
    preview?: unknown
  } = {}
) {
  h.get.mockImplementation(async (url: string) => {
    if (url === '/hub/environments/5/stack')
      return {
        data: {
          data: {
            stack_name: 'efp-staging',
            dns_mode: 'automatic',
            name_request: null,
            status:
              opts.noStatus || (opts.agent && opts.agent !== 'ok')
                ? null
                : status(opts.state ?? 'converged'),
            agent: opts.agent ?? 'ok',
            local_volumes_on_nodes: opts.nodes ?? null,
            uploads_on_share: opts.onShare ?? false,
            leftovers: opts.leftovers ?? null,
            apply_preview: opts.preview ?? null
          }
        }
      }
    if (url === '/hub/environments/5/stack/settings')
      return {
        data: {
          data: opts.settings ?? {
            size: 'small',
            redis: 'bundled',
            publish_port: null,
            settings: { LOG_LEVEL: 'info' },
            secrets: { SESSION_SECRET: '••••••', API_KEY: '••••••' },
            saved: true,
            extension_pins: {}
          }
        }
      }
    return { data: { data: [] } }
  })
}

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
const view = (isAdmin: boolean) =>
  render(
    <QueryClientProvider client={client()}>
      <HubStackPanel env={env} appId={1} isAdmin={isAdmin} layout='card' />
    </QueryClientProvider>
  )

afterEach(() => {
  vi.clearAllMocks()
})

describe('HubStackPanel', () => {
  it('owner sees status and Restart, no settings, no Remove', async () => {
    setup()
    view(false)
    expect(await screen.findByText('Converged')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Restart' })).toBeTruthy()
    expect(screen.queryByText('Edit settings')).toBeNull()
    expect(screen.queryByText(/Remove stack/)).toBeNull()
  })

  it('owner on production: no Restart, no Apply now, says who deploys it', async () => {
    setup()
    render(
      <QueryClientProvider client={client()}>
        <HubStackPanel env={env} appId={1} isAdmin={false} canDeploy={false} layout='card' />
      </QueryClientProvider>
    )
    expect(await screen.findByText('Converged')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Apply now/ })).toBeNull()
    expect(screen.queryByText('View settings')).toBeNull()
    expect(screen.getByText(/Hub administrators restart and apply/)).toBeTruthy()
  })

  it('owner on non-production may open the stack settings read-only', async () => {
    setup()
    view(false)
    fireEvent.click(await screen.findByRole('button', { name: /View settings/ }))
    await waitFor(() => expect(h.get).toHaveBeenCalledWith('/hub/environments/5/stack/settings'))
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('Restart stays disabled until the environment key is typed', async () => {
    setup()
    h.post.mockResolvedValue({ data: { data: { services: [] } } })
    view(false)
    fireEvent.click(await screen.findByRole('button', { name: 'Restart' }))
    const go = screen.getByRole('button', { name: 'Restart now' }) as HTMLButtonElement
    expect(go.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/to restart/), { target: { value: 'staging' } })
    expect(go.disabled).toBe(false)
    fireEvent.click(go)
    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith('/hub/environments/5/stack/restart', {
        confirm: 'staging'
      })
    )
  })

  it('P4-30: Apply now needs the typed key and starts the apply run', async () => {
    setup()
    h.post.mockResolvedValue({ data: { data: { deploy_id: 9, job_run_id: null } } })
    view(false)
    fireEvent.click(await screen.findByRole('button', { name: 'Apply now' }))
    const go = screen.getAllByRole('button', { name: 'Apply now' }).at(-1) as HTMLButtonElement
    expect(go.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/to apply/), { target: { value: 'staging' } })
    expect(go.disabled).toBe(false)
    fireEvent.click(go)
    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith('/hub/environments/5/stack/apply', { confirm: 'staging' })
    )
  })

  it('P4-35: the Apply now box names the saved size and the pins that change', async () => {
    setup({
      preview: {
        size: 'large',
        running_size: 'medium',
        pins_changed: [
          {
            id: 'efp-ops',
            running: 'nodeworks/efp-ops@222222222222',
            saved: 'nodeworks/efp-ops@333333333333'
          }
        ],
        pins_unreadable: false
      }
    })
    view(false)
    fireEvent.click(await screen.findByRole('button', { name: 'Apply now' }))
    expect(screen.getByText('large')).toBeTruthy()
    expect(screen.getByText(/runs medium now/)).toBeTruthy()
    expect(screen.getByText('nodeworks/efp-ops@333333333333')).toBeTruthy()
  })

  it('P4-30: after a save the editor says when settings apply, and offers Apply now', async () => {
    setup()
    h.put.mockImplementation(async () => ({
      data: {
        data: {
          size: 'small',
          redis: 'bundled',
          publish_port: null,
          settings: { LOG_LEVEL: 'debug' },
          secrets: { SESSION_SECRET: '••••••', API_KEY: '••••••' },
          saved: true,
          extension_pins: {}
        }
      }
    }))
    view(true)
    fireEvent.click(await screen.findByText('Edit settings'))
    const value = (await screen.findByLabelText('Setting value')) as HTMLInputElement
    fireEvent.change(value, { target: { value: 'debug' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))
    expect(
      await screen.findByText(
        /The settings reach the stack on its next deploy, or now with Apply now/
      )
    ).toBeTruthy()
    // Its Apply now opens the typed confirm.
    const buttons = screen.getAllByRole('button', { name: 'Apply now' })
    fireEvent.click(buttons[buttons.length - 1])
    expect(await screen.findByLabelText(/to apply/)).toBeTruthy()
  })

  it('P4-33: warns about local volumes on a swarm of several nodes', async () => {
    setup({ nodes: 3 })
    view(false)
    expect(await screen.findByText(/each node keeps its own uploads and Redis data/)).toBeTruthy()
  })

  it('P4-25: no service but leftovers: says what is left, not "No stack yet"', async () => {
    setup({
      noStatus: true,
      leftovers: { services: 0, secrets: 1, networks: 0, volumes: 2, extensions: true }
    })
    view(true)
    expect(await screen.findByText('Leftovers on the swarm')).toBeTruthy()
    expect(screen.getByText(/2 volumes, 1 secret and the extensions folder/)).toBeTruthy()
    expect(screen.queryByText('No stack yet')).toBeNull()
  })

  it('P4-25: nothing left: "No stack yet"', async () => {
    setup({ noStatus: true })
    view(true)
    expect(await screen.findByText('No stack yet')).toBeTruthy()
  })

  it('P4-33: no volume warning on one node', async () => {
    setup()
    view(false)
    await screen.findByText('Converged')
    expect(screen.queryByText(/each node keeps its own/)).toBeNull()
  })

  it('shows the rolled back hint', async () => {
    setup({ state: 'rolled_back' })
    view(false)
    expect(await screen.findByText(/rolled the stack back/)).toBeTruthy()
  })

  it('says another environment owns a mismatched stack', async () => {
    setup({ agent: 'STACK_OWNER_MISMATCH' })
    view(false)
    expect((await screen.findAllByText(/belongs to another environment/)).length).toBeGreaterThan(0)
  })

  it('secrets show only masks and Replace never pre-fills', async () => {
    setup()
    view(true)
    fireEvent.click(await screen.findByText('Edit settings'))
    await screen.findByText('API_KEY')
    expect(screen.getAllByText('••••••').length).toBe(2)
    fireEvent.click(screen.getAllByRole('button', { name: 'Replace' })[1])
    const input = screen.getByLabelText('New value for API_KEY') as HTMLInputElement
    expect(input.value).toBe('')
    // The generated secret cannot be cleared.
    expect(screen.queryAllByRole('button', { name: 'Clear' }).length).toBe(0)
  })

  it('a settings refusal lands on its row', async () => {
    setup()
    h.put.mockRejectedValue({
      response: {
        status: 400,
        data: { code: 'SECRET_IN_SETTINGS', error: 'LOG_LEVEL looks like a credential' }
      }
    })
    view(true)
    fireEvent.click(await screen.findByText('Edit settings'))
    const value = (await screen.findByLabelText('Setting value')) as HTMLInputElement
    fireEvent.change(value, { target: { value: 'debug' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))
    expect(await screen.findByText(/Put it under Secrets/)).toBeTruthy()
    expect(h.put.mock.calls[0][1].secrets).toEqual({ SESSION_SECRET: '••••••', API_KEY: '••••••' })
  })

  it('removing with volumes needs both phrases', async () => {
    setup()
    h.post.mockResolvedValue({
      data: {
        data: { removed: { services: ['a'], secrets: 2, networks: [], volumes: ['v'] } }
      }
    })
    view(true)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove stack…' }))
    const go = screen.getByRole('button', { name: 'Remove stack' }) as HTMLButtonElement
    fireEvent.change(screen.getByLabelText(/to remove it/), { target: { value: 'efp-staging' } })
    expect(go.disabled).toBe(false)
    fireEvent.click(screen.getByLabelText(/data volumes/))
    expect(go.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText(/delete efp-staging data/), {
      target: { value: 'delete efp-staging data' }
    })
    expect(go.disabled).toBe(false)
    fireEvent.click(go)
    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith('/hub/environments/5/stack/remove', {
        confirm: 'efp-staging',
        remove_volumes: true,
        confirm_volumes: 'delete efp-staging data'
      })
    )
    expect(await screen.findByText(/Removed 1 services, 2 secrets/)).toBeTruthy()
  })

  it('a SQLite DB_CLIENT sends size small whatever was picked', async () => {
    setup({
      settings: {
        size: 'large',
        redis: 'bundled',
        publish_port: null,
        settings: { DB_CLIENT: 'sqlite' },
        secrets: {},
        saved: true,
        extension_pins: {}
      }
    })
    h.put.mockResolvedValue({ data: { data: {} } })
    view(true)
    fireEvent.click(await screen.findByText('Edit settings'))
    const value = (await screen.findByLabelText('Setting value')) as HTMLInputElement
    expect(screen.getByRole('combobox', { name: 'Size' })).toHaveTextContent('Small')
    // A harmless edit makes the form dirty; the saved size is small, not large.
    fireEvent.click(screen.getByRole('button', { name: 'Add setting' }))
    fireEvent.change(screen.getAllByLabelText('Setting name')[1], { target: { value: 'A' } })
    fireEvent.change(screen.getAllByLabelText('Setting value')[1], { target: { value: 'b' } })
    expect(value.value).toBe('sqlite')
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))
    await waitFor(() => expect(h.put).toHaveBeenCalled())
    expect(h.put.mock.calls[0][1].size).toBe('small')
  })

  it('a refusal that matches no row falls back to the page notice', async () => {
    setup()
    h.put.mockRejectedValue({
      response: {
        status: 400,
        data: { code: 'BAD_SIZE', error: 'size must be small, medium or large.' }
      }
    })
    view(true)
    fireEvent.click(await screen.findByText('Edit settings'))
    fireEvent.change(await screen.findByLabelText('Setting value'), { target: { value: 'debug' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))
    expect(await screen.findByText('Pick small, medium or large')).toBeTruthy()
  })

  it('a refusal with `field` lands on the named row, not the row the message mentions', async () => {
    setup({
      settings: {
        size: 'small',
        redis: 'bundled',
        publish_port: null,
        settings: { LOG_LEVEL: 'info', MAIL_FROM: 'a@b.c' },
        secrets: { SESSION_SECRET: '••••••' },
        saved: true,
        extension_pins: {}
      }
    })
    h.put.mockRejectedValue({
      response: {
        status: 400,
        data: {
          code: 'BAD_VALUE',
          error: 'Setting MAIL_FROM is longer than 4 KB. (LOG_LEVEL is fine)',
          field: { kind: 'setting', key: 'MAIL_FROM' }
        }
      }
    })
    view(true)
    fireEvent.click(await screen.findByText('Edit settings'))
    const values = (await screen.findAllByLabelText('Setting value')) as HTMLInputElement[]
    fireEvent.change(values[1], { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Check this value.')
    expect(alert.textContent).not.toContain('4 KB')
    // Under the MAIL_FROM row (the second), not the LOG_LEVEL one.
    expect(values[1].closest('li')?.contains(alert)).toBe(true)
    expect(values[0].closest('li')?.contains(alert)).toBe(false)
  })

  it('an owner whose stack read fails without a code sees a short notice', async () => {
    h.get.mockRejectedValue(new Error('network'))
    view(false)
    expect(await screen.findByText(/stack status is not available/i)).toBeTruthy()
  })

  it('owner notice in the desktop table sits inside a row and cell', async () => {
    h.get.mockRejectedValue(new Error('network'))
    const { container } = render(
      <QueryClientProvider client={client()}>
        <table>
          <tbody>
            <HubStackPanel env={env} appId={1} isAdmin={false} layout='row' />
          </tbody>
        </table>
      </QueryClientProvider>
    )
    const note = await screen.findByText(/stack status is not available/i)
    const td = note.closest('td')
    expect(td?.getAttribute('colspan')).toBe('6')
    expect(td?.parentElement?.tagName).toBe('TR')
    expect(container.querySelectorAll('tbody > p').length).toBe(0)
  })

  it('a clean draft re-seeds from newer data; a dirty one is never overwritten', async () => {
    const withLevel = (v: string) => ({
      size: 'small',
      redis: 'bundled',
      publish_port: null,
      settings: { LOG_LEVEL: v },
      secrets: {},
      saved: true,
      extension_pins: {}
    })
    setup({ settings: withLevel('info') })
    const qc = client()
    render(
      <QueryClientProvider client={qc}>
        <HubStackPanel env={env} appId={1} isAdmin layout='card' />
      </QueryClientProvider>
    )
    fireEvent.click(await screen.findByText('Edit settings'))
    const value = () => screen.getByLabelText('Setting value') as HTMLInputElement
    expect(((await screen.findByLabelText('Setting value')) as HTMLInputElement).value).toBe('info')

    // Clean: newer data lands.
    setup({ settings: withLevel('debug') })
    await qc.invalidateQueries({ queryKey: stackKeys.settings(5) })
    await waitFor(() => expect(value().value).toBe('debug'))

    // Dirty: newer data never overwrites the edit.
    fireEvent.change(value(), { target: { value: 'mine' } })
    setup({ settings: withLevel('warn') })
    await qc.invalidateQueries({ queryKey: stackKeys.settings(5) })
    await new Promise((r) => setTimeout(r, 50))
    expect(value().value).toBe('mine')
  })

  it('a refusal about a whole list shows neutral copy, never the server text', async () => {
    setup()
    h.put.mockRejectedValue({
      response: {
        status: 400,
        data: {
          code: 'BAD_VALUE',
          error: 'A stack holds at most 64 settings. raw-server-text',
          field: { kind: 'setting' }
        }
      }
    })
    view(true)
    fireEvent.click(await screen.findByText('Edit settings'))
    fireEvent.change(await screen.findByLabelText('Setting value'), { target: { value: 'x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))
    const alert = await screen.findByText(/Check the Settings list/)
    expect(alert.textContent).not.toContain('raw-server-text')
  })

  it('renders nothing for an environment that is not Docker', async () => {
    h.get.mockRejectedValue({ response: { status: 409, data: { code: 'NOT_DOCKER', error: 'x' } } })
    const { container } = view(false)
    await waitFor(() => expect(h.get).toHaveBeenCalled())
    await new Promise((r) => setTimeout(r, 20))
    expect(container.textContent).toBe('')
  })

  it('two mounts (table and phone card) never share an element id', async () => {
    setup()
    render(
      <QueryClientProvider client={client()}>
        <HubStackPanel env={env} appId={1} isAdmin layout='card' />
        <HubStackPanel env={env} appId={1} isAdmin layout='card' idPrefix='-m' />
      </QueryClientProvider>
    )
    await waitFor(() => expect(screen.getAllByText('Edit settings').length).toBe(2))
    const unique = (min: number) => {
      const ids = [...document.querySelectorAll('[id]')].map((e) => e.id)
      expect(ids.length).toBeGreaterThan(min)
      expect(new Set(ids).size).toBe(ids.length)
    }
    // One action form is open at a time per panel: check each form's ids in turn.
    for (const b of screen.getAllByText('Edit settings')) fireEvent.click(b)
    await waitFor(() =>
      expect(document.querySelectorAll('[id^="hub-stack-5"]').length).toBeGreaterThan(2)
    )
    unique(3)
    for (const b of await screen.findAllByRole('button', { name: 'Restart' })) fireEvent.click(b)
    await waitFor(() => expect(screen.getAllByLabelText(/to restart/).length).toBe(2))
    unique(1)
    for (const b of screen.getAllByRole('button', { name: 'Remove stack…' })) fireEvent.click(b)
    await waitFor(() => expect(screen.getAllByLabelText(/to remove it/).length).toBe(2))
    unique(3)
  })
})

describe('stackRefetchInterval', () => {
  it('stops polling for a non-Docker environment, speeds up while updating', () => {
    const notDocker = { response: { status: 409, data: { code: 'NOT_DOCKER', error: 'x' } } }
    expect(stackRefetchInterval({ state: { error: notDocker } })).toBe(false)
    expect(
      stackRefetchInterval({ state: { error: null, data: { status: { state: 'updating' } } } })
    ).toBe(5000)
    expect(
      stackRefetchInterval({ state: { error: null, data: { status: { state: 'converged' } } } })
    ).toBe(30000)
  })
})

describe('HubStackPanel: files (Hub agent 0.2.2)', () => {
  const settings = (files?: Record<string, unknown>) => ({
    size: 'small',
    redis: 'bundled',
    publish_port: null,
    settings: {},
    secrets: { SESSION_SECRET: '••••••' },
    saved: true,
    extension_pins: {},
    ...(files ? { files } : {})
  })

  it('shows the stored folders and sends what was typed', async () => {
    setup({
      settings: settings({ uploads_folder: 'efp', files_subfolder: null, run_as: 'image' })
    })
    h.put.mockResolvedValue({ data: { data: settings() } })
    view(true)
    fireEvent.click(await screen.findByText('Edit settings'))
    const folder = (await screen.findByLabelText('Uploads folder')) as HTMLInputElement
    expect(folder.value).toBe('efp')
    fireEvent.change(screen.getByLabelText('Files sub-folder'), {
      target: { value: 'directus-uploads' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))
    await vi.waitFor(() => expect(h.put).toHaveBeenCalled())
    expect(h.put.mock.calls[0][1]).toMatchObject({
      uploads_folder: 'efp',
      files_subfolder: 'directus-uploads',
      run_as: 'image'
    })
  })

  it('an older Hub answer without files reads as all default; a refusal lands on its field', async () => {
    setup({ settings: settings() })
    h.put.mockRejectedValue({
      response: {
        status: 400,
        data: { code: 'BAD_UPLOADS_FOLDER', error: 'x', field: { kind: 'uploads_folder' } }
      }
    })
    view(true)
    fireEvent.click(await screen.findByText('Edit settings'))
    const folder = (await screen.findByLabelText('Uploads folder')) as HTMLInputElement
    expect(folder.value).toBe('')
    fireEvent.change(folder, { target: { value: '../x' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }))
    expect(await screen.findByText(/The uploads folder is not a valid path/)).toBeTruthy()
  })
})

describe('HubStackPanel: Remove on an NFS share (Hub agent 0.2.3)', () => {
  it('says only the Redis data goes and names the folder whose files stay', async () => {
    setup({
      onShare: true,
      settings: {
        size: 'small',
        redis: 'bundled',
        publish_port: null,
        settings: {},
        secrets: {},
        saved: true,
        extension_pins: {},
        files: { uploads_folder: 'directus-uploads', files_subfolder: null, run_as: 'app' }
      }
    })
    view(true)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove stack…' }))
    expect(screen.getByText(/uploads stay on the NFS share whatever you choose/)).toBeTruthy()
    fireEvent.click(screen.getByLabelText("Also delete the stack's Redis data"))
    expect(await screen.findByText(/The Redis data goes for good/)).toBeTruthy()
    expect(await screen.findByText('directus-uploads')).toBeTruthy()
  })

  it('without a share the copy is the volumes one, as before', async () => {
    setup()
    view(true)
    fireEvent.click(await screen.findByRole('button', { name: 'Remove stack…' }))
    expect(screen.getByLabelText("Also delete the stack's data volumes")).toBeTruthy()
  })
})
