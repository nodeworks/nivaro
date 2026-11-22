import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SharedDeployment } from './shared-api'

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => h.get(url),
    post: (url: string, body: unknown) => h.post(url, body),
    patch: (url: string, body: unknown) => h.patch(url, body),
    put: vi.fn(),
    delete: vi.fn()
  }
}))

const { SharedDeploymentForm } = await import('./SharedDeploymentForm')

const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      {ui}
    </QueryClientProvider>
  )

const ROW: SharedDeployment = {
  id: 4,
  key: 'shared-one',
  name: 'Shared one',
  mode: 'registered',
  driver_id: null,
  stack: null,
  version_pin: '0.3.210',
  extensions: ['efp-ops'],
  extension_pins: {},
  host_pattern: null,
  link_url: 'https://shared-one.example.com',
  pool_budget: 60,
  status: 'active',
  settings: {},
  token: '••••••',
  last_seen_at: null,
  created_at: null,
  updated_at: null
}

afterEach(() => {
  h.get.mockReset()
  h.post.mockReset()
  h.patch.mockReset()
})

const type = (label: RegExp | string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } })

/** The page text a person reads: the collapsed "Details for support" left out. */
function shownText(): string {
  const copy = document.body.cloneNode(true) as HTMLElement
  for (const d of copy.querySelectorAll('[data-error-details]')) d.remove()
  return copy.textContent ?? ''
}

describe('SharedDeploymentForm', () => {
  it('creates a deployment run elsewhere and hands back the answer (token included)', async () => {
    h.get.mockResolvedValue({ data: { data: [] } })
    h.post.mockResolvedValue({
      data: { data: { row: { ...ROW, id: 9 }, token: 'tok_x'.repeat(8), env_block: 'X=1' } }
    })
    const onCreated = vi.fn()
    wrap(<SharedDeploymentForm shared={null} onCreated={onCreated} onCancel={() => {}} />)
    type('Name', 'Shared one')
    type('Key', 'shared-one')
    type(/Link address/, 'https://shared-one.example.com')
    type(/Extensions/, 'efp-ops, other-ext')
    fireEvent.click(screen.getByRole('button', { name: 'Add shared deployment' }))
    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    expect(h.post).toHaveBeenCalledWith(
      '/hub/shared',
      expect.objectContaining({
        key: 'shared-one',
        name: 'Shared one',
        mode: 'registered',
        link_url: 'https://shared-one.example.com',
        extensions: ['efp-ops', 'other-ext'],
        pool_budget: 60
      })
    )
    expect(onCreated.mock.calls[0][0]).toMatchObject({ token: 'tok_x'.repeat(8) })
  })

  it('refuses locally before asking the API (bad key, no link address)', () => {
    h.get.mockResolvedValue({ data: { data: [] } })
    wrap(<SharedDeploymentForm shared={null} onCreated={() => {}} onCancel={() => {}} />)
    type('Name', 'X')
    type('Key', 'Bad Key')
    fireEvent.click(screen.getByRole('button', { name: 'Add shared deployment' }))
    expect(screen.getByText(/lower-case letters, digits and hyphens/)).toBeInTheDocument()
    expect(h.post).not.toHaveBeenCalled()
  })

  it('edit keeps key and mode read-only and sends only what changed', async () => {
    h.patch.mockResolvedValue({ data: { data: { ...ROW, name: 'Renamed' } } })
    const onSaved = vi.fn()
    wrap(<SharedDeploymentForm shared={ROW} onSaved={onSaved} onCancel={() => {}} />)
    expect(screen.queryByLabelText('Key')).toBeNull()
    expect(screen.getByText('shared-one')).toBeInTheDocument()
    type('Name', 'Renamed')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(h.patch).toHaveBeenCalledWith('/hub/shared/4', { name: 'Renamed' })
  })

  it('a docker deployment edits size and Redis inside its settings, keeping the rest', async () => {
    const docker: SharedDeployment = {
      ...ROW,
      mode: 'docker',
      driver_id: 3,
      stack: 'shared-one',
      settings: { redis: 'external', publish_port: 8080 }
    }
    h.patch.mockResolvedValue({ data: { data: docker } })
    const onSaved = vi.fn()
    wrap(<SharedDeploymentForm shared={docker} onSaved={onSaved} onCancel={() => {}} />)
    expect(screen.getByText(/without its address an upgrade cannot start/)).toBeInTheDocument()
    type('Name', 'Docker one')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    // Unchanged settings are not sent; only the name changed.
    expect(h.patch).toHaveBeenCalledWith('/hub/shared/4', { name: 'Docker one' })
  })

  it('the Redis address is write-only: stored shows the mask and Replace; a new one is sent once', async () => {
    const docker: SharedDeployment = {
      ...ROW,
      mode: 'docker',
      driver_id: 3,
      stack: 'shared-one',
      settings: { redis: 'external' }
    }
    h.patch.mockResolvedValue({ data: { data: docker } })
    const onSaved = vi.fn()
    wrap(
      <SharedDeploymentForm
        shared={docker}
        secrets={{ REDIS_URL: '••••••' }}
        onSaved={onSaved}
        onCancel={() => {}}
      />
    )
    expect(screen.queryByLabelText('Redis address')).toBeNull()
    expect(screen.getByText('••••••')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
    const box = screen.getByLabelText('Redis address') as HTMLInputElement
    expect(box.value).toBe('')
    expect(box.type).toBe('password')
    fireEvent.change(box, { target: { value: 'rediss://u:p@redis.internal:6380/0' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(h.patch).toHaveBeenCalledWith('/hub/shared/4', {
      secrets: { REDIS_URL: 'rediss://u:p@redis.internal:6380/0' }
    })
    // Cleared after save: the value is never kept on screen.
    expect(screen.queryByDisplayValue('rediss://u:p@redis.internal:6380/0')).toBeNull()
  })

  it('takes extension pins as image digests (repo@sha256:…) and refuses a bare version', async () => {
    h.patch.mockResolvedValue({ data: { data: ROW } })
    const onSaved = vi.fn()
    wrap(<SharedDeploymentForm shared={ROW} onSaved={onSaved} onCancel={() => {}} />)
    type('Extension pins', 'efp-ops=1.4.2')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(screen.getByText(/repo@sha256:digest/)).toBeInTheDocument()
    expect(h.patch).not.toHaveBeenCalled()
    const pin = `registry.example.com:5000/efp-ops@sha256:${'a'.repeat(64)}`
    type('Extension pins', `efp-ops=${pin}`)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(h.patch).toHaveBeenCalledWith('/hub/shared/4', { extension_pins: { 'efp-ops': pin } })
  })

  it('a refusal shows in plain words, without a status code', async () => {
    h.get.mockResolvedValue({ data: { data: [] } })
    h.post.mockRejectedValue({
      isAxiosError: true,
      message: 'Request failed with status code 409',
      response: {
        status: 409,
        data: { statusCode: 409, code: 'KEY_TAKEN', message: 'That key is taken.' }
      }
    })
    wrap(<SharedDeploymentForm shared={null} onCreated={() => {}} onCancel={() => {}} />)
    type('Name', 'Shared one')
    type('Key', 'shared-one')
    type(/Link address/, 'https://shared-one.example.com')
    fireEvent.click(screen.getByRole('button', { name: 'Add shared deployment' }))
    expect(
      await screen.findByText('Another shared deployment already uses this key')
    ).toBeInTheDocument()
    expect(shownText()).not.toMatch(/409|status code/)
  })
})
