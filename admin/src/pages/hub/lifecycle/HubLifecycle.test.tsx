import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Retirement } from './lifecycle-api'

// Clone & retire (Apps hub tab): every code the lifecycle routes answer has plain words; a
// retirement shows its steps and only the next one's sign-off; removal needs the typed key and the
// by-hand environments ticked; Undo / Cancel / Resume appear only when they apply.

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), admin: true }))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string, opts?: unknown) => h.get(url, opts),
    post: (url: string, body: unknown) => h.post(url, body),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn()
  }
}))
vi.mock('@/lib/auth', () => ({ useAuth: () => ({ user: { is_admin: h.admin } }) }))

const { default: HubLifecycle } = await import('./HubLifecycle')
const { LIFECYCLE_COPY } = await import('./lifecycle-api')
const { CODE_COPY_KEYS } = await import('../hub-api')

const ROOT = join(import.meta.dirname, '../../../../..')

const step = (key: string, label: string, state = 'pending', extra = {}) => ({
  key,
  label,
  state,
  signed_off_by: null,
  signed_off_at: null,
  sign_note: null,
  started_at: null,
  finished_at: null,
  note: null,
  detail: {},
  log: [],
  ...extra
})

function retirement(over: Partial<Retirement> = {}): Retirement {
  return {
    id: 9,
    app_id: 1,
    status: 'open',
    step: null,
    steps: [
      step('freeze', 'Freeze writes', 'done', {
        signed_off_at: '2026-11-25T10:00:00.000Z',
        note: 'Hub freeze #4 on; 2 of 2 environments in maintenance.'
      }),
      step('export', 'Export data', 'done', { note: '2 backups made.' }),
      step('notice', 'Final notice to users', 'done', { note: 'Final notice sent to 3 people.' }),
      step('remove', 'Stop and remove'),
      step('archive', 'Archive the Hub record')
    ] as Retirement['steps'],
    plan: {
      app: { id: 1, key: 'shop', name: 'Shop' },
      production: true,
      environments: [
        {
          id: 1,
          key: 'staging',
          status: 'active',
          production: false,
          kind: 'manual',
          freeze: 'link',
          has_link: true,
          stack: null,
          database: false,
          files_target: false
        },
        {
          id: 2,
          key: 'production',
          status: 'active',
          production: true,
          kind: 'docker',
          freeze: 'link',
          has_link: true,
          stack: 'shop-production',
          database: true,
          files_target: true
        }
      ]
    },
    lines: {
      freeze: [],
      export: [],
      notice: [],
      remove: ['production: the Docker stack shop-production is removed.'],
      archive: []
    },
    notice: null,
    checklists: { '2': 5 },
    error: null,
    heartbeat_at: null,
    started_by: null,
    created_at: '2026-11-25T09:00:00.000Z',
    finished_at: null,
    next_step: 'remove',
    undo_step: 'notice',
    cancellable: true,
    ...over
  }
}

function mount(url: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[url]}>
        <HubLifecycle />
      </MemoryRouter>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  h.get.mockReset()
  h.post.mockReset()
  h.admin = true
})

describe('every code the lifecycle routes answer has plain words', () => {
  const CODE = /(?:RetireError|CloneError|CloneExportError)\(\s*'([A-Z][A-Z0-9_]{3,})'/g
  it.each([
    'api/src/services/hub/lifecycle/retire-run.ts',
    'api/src/services/hub/lifecycle/retire-plan.ts',
    'api/src/services/hub/lifecycle/retire-steps.ts',
    'api/src/services/hub/lifecycle/clone.ts',
    'api/src/services/hub-link/clone-export.ts'
  ])('%s', (file) => {
    const src = readFileSync(join(ROOT, file), 'utf8')
    const codes = [...new Set([...src.matchAll(CODE)].map((m) => m[1]))]
    const planCodes = [...src.matchAll(/code: '([A-Z][A-Z0-9_]{3,})'/g)].map((m) => m[1])
    const all = [...codes, ...planCodes].filter((c) => c !== 'NOT_FOUND')
    expect(all.filter((c) => !LIFECYCLE_COPY[c] && !CODE_COPY_KEYS.has(c))).toEqual([])
  })
})

describe('a retirement', () => {
  it('shows every step and only the next one’s sign-off; removal needs the key and the by-hand tick', async () => {
    h.get.mockImplementation(async (url: string) => {
      if (url === '/hub/retirements') return { data: { data: [retirement()] } }
      if (url === '/hub/retirements/9') return { data: { data: retirement() } }
      if (url === '/hub/lifecycle/clones') return { data: { data: [] } }
      throw new Error(`unexpected GET ${url}`)
    })
    h.post.mockResolvedValue({ data: { data: retirement({ status: 'running' }) } })
    mount('/hub/lifecycle?retirement=9')
    expect(await screen.findByRole('heading', { name: 'Retiring Shop' })).toBeTruthy()
    expect(screen.getByText('Hub freeze #4 on; 2 of 2 environments in maintenance.')).toBeTruthy()
    const go = screen.getByRole('button', { name: 'Sign off and remove' }) as HTMLButtonElement
    expect(go.disabled).toBe(true)
    expect(screen.queryByRole('button', { name: 'Sign off and archive' })).toBeNull()
    fireEvent.change(screen.getByLabelText('Type shop to stop and remove it'), {
      target: { value: 'shop' }
    })
    expect(go.disabled).toBe(true) // staging must be ticked + a note
    fireEvent.click(screen.getByLabelText('I stopped staging'))
    fireEvent.change(screen.getByLabelText('Sign-off note (say how you did it)'), {
      target: { value: 'Stopped the VM' }
    })
    expect(go.disabled).toBe(false)
    fireEvent.click(go)
    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith('/hub/retirements/9/steps/remove', {
        note: 'Stopped the VM',
        confirm: 'shop',
        manual: [1]
      })
    )
    expect(screen.getByRole('button', { name: /Undo “Final notice to users”/ })).toBeTruthy()
  })

  it('an interrupted retirement offers Resume, never a sign-off', async () => {
    const r = retirement({
      status: 'interrupted',
      next_step: null,
      undo_step: null,
      cancellable: false
    })
    h.get.mockImplementation(async (url: string) =>
      url === '/hub/retirements/9'
        ? { data: { data: r } }
        : { data: { data: url === '/hub/retirements' ? [r] : [] } }
    )
    h.post.mockResolvedValue({ data: { data: retirement() } })
    mount('/hub/lifecycle?retirement=9')
    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }))
    await waitFor(() => expect(h.post).toHaveBeenCalledWith('/hub/retirements/9/resume', {}))
    expect(screen.queryByRole('button', { name: /Sign off/ })).toBeNull()
  })

  it('an owner reads it, but signs nothing off', async () => {
    h.admin = false
    h.get.mockImplementation(async (url: string) =>
      url === '/hub/retirements/9'
        ? { data: { data: retirement() } }
        : { data: { data: [retirement()] } }
    )
    mount('/hub/lifecycle?retirement=9')
    expect(await screen.findByRole('heading', { name: 'Retiring Shop' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Sign off/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Retire an app/ })).toBeNull()
  })
})
