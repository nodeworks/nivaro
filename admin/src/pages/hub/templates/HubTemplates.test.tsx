import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Hub enhancement 24: the Templates tab — list, detail, upload, a used template cannot be deleted.

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() }))
vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string, config?: unknown) => h.get(url, config),
    post: (url: string, body?: unknown) => h.post(url, body),
    patch: (url: string, body?: unknown) => h.patch(url, body),
    delete: (url: string) => h.del(url)
  }
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const { HubTemplates } = await import('./HubTemplates')
const { countsLine } = await import('./templates-api')

const counts = {
  collections: 4,
  fields: 9,
  relations: 1,
  workflows: 1,
  layouts: 0,
  queues: 2,
  rules: 0
}
const T = (id: number, name: string, used: number) => ({
  id,
  name,
  version: '1.0.0',
  description: `${name} words`,
  digest: 'sha256:abcdef0123456789',
  size_bytes: 2048,
  manifest: {
    name,
    description: null,
    version: '1.0.0',
    exported_at: '2026-11-20T00:00:00.000Z',
    nivaro_version: '0.3.214',
    collections: ['assets'],
    counts
  },
  archived: false,
  archived_at: null,
  created_by: null,
  created_at: '2026-11-20T00:00:00.000Z',
  updated_at: null,
  used
})

function mount() {
  h.get.mockResolvedValue({ data: { data: [T(1, 'Assets', 3), T(2, 'Buying', 0)] } })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <HubTemplates />
    </QueryClientProvider>
  )
}

afterEach(() => vi.clearAllMocks())

describe('HubTemplates', () => {
  it('countsLine leaves zero parts out', () => {
    expect(countsLine(T(1, 'A', 0).manifest)).toBe('4 collections · 1 workflow · 2 queues')
  })

  it('lists templates with a usage chip; a used one offers no delete, an unused one does', async () => {
    mount()
    expect(await screen.findByText('Assets')).toBeTruthy()
    expect(screen.getByText('In use · 3')).toBeTruthy()
    fireEvent.click(screen.getByText('Assets'))
    const del = (await screen.findAllByRole('button', { name: /Delete/ }))[0] as HTMLButtonElement
    expect(del.disabled).toBe(true)
    fireEvent.click(screen.getByText('Buying'))
    await waitFor(() =>
      expect(
        (screen.getAllByRole('button', { name: /Delete/ })[0] as HTMLButtonElement).disabled
      ).toBe(false)
    )
  })

  it('archive sends archived: true', async () => {
    mount()
    fireEvent.click(await screen.findByText('Buying'))
    h.patch.mockResolvedValue({ data: { data: { ...T(2, 'Buying', 0), archived: true } } })
    fireEvent.click(await screen.findByRole('button', { name: /Archive/ }))
    await waitFor(() =>
      expect(h.patch).toHaveBeenCalledWith('/hub/templates/2', { archived: true })
    )
  })

  it('upload: a picked export fills the name; Upload sends the bundle', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /Upload template/ }))
    const upload = screen.getByRole('button', { name: 'Upload' }) as HTMLButtonElement
    expect(upload.disabled).toBe(true)
    expect(screen.getByText('Pick an export file to upload.')).toBeTruthy()
    const bundle = {
      type: 'nivaro-blueprint',
      version: 1,
      name: 'Inspections',
      collections: [{ meta: { collection: 'x' }, fields: [] }],
      workflows: []
    }
    const file = new File([JSON.stringify(bundle)], 'inspections.json', {
      type: 'application/json'
    })
    fireEvent.change(document.getElementById('hub-template-file') as HTMLInputElement, {
      target: { files: [file] }
    })
    await waitFor(() =>
      expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Inspections')
    )
    expect(screen.getByText(/1 collection · 0 workflows/)).toBeTruthy()
    h.post.mockResolvedValue({ data: { data: T(3, 'Inspections', 0) } })
    fireEvent.click(screen.getByRole('button', { name: 'Upload' }))
    await waitFor(() =>
      expect(h.post).toHaveBeenCalledWith(
        '/hub/templates',
        expect.objectContaining({ bundle, name: 'Inspections' })
      )
    )
  })

  it('a file that is not a blueprint is refused in plain words', async () => {
    mount()
    fireEvent.click(await screen.findByRole('button', { name: /Upload template/ }))
    const file = new File(['{"type":"other"}'], 'x.json', { type: 'application/json' })
    fireEvent.change(document.getElementById('hub-template-file') as HTMLInputElement, {
      target: { files: [file] }
    })
    expect(await screen.findByText('This file is not an App Blueprint export.')).toBeTruthy()
  })
})
