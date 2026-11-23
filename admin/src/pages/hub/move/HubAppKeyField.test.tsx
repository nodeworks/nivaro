import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub (phase 6, Task 18): the app's encryption key on an environment. The key is typed
// once and never shown again — only its mask and fingerprint.

const h = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }))

vi.mock('@/lib/api', () => ({
  api: {
    get: (url: string) => h.get(url),
    put: (url: string, body?: unknown) => h.put(url, body),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn()
  }
}))

const { HubAppKeyField } = await import('./HubAppKeyField')

const KEY = 'a'.repeat(64)

function renderField(shared = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <HubAppKeyField envId={10} idPrefix='k' shared={shared} />
    </QueryClientProvider>
  )
}

afterEach(() => vi.clearAllMocks())

describe('HubAppKeyField', () => {
  it('shows a saved key only as its mask and fingerprint, never in the input', async () => {
    h.get.mockResolvedValue({
      data: {
        data: {
          known: true,
          key: '••••••',
          fp: '0123456789abcdef0123456789abcdef',
          source: 'entry'
        }
      }
    })
    renderField()
    expect(await screen.findByText('••••••')).toBeInTheDocument()
    expect(screen.getByText('0123456789abcdef0123456789abcdef')).toBeInTheDocument()
    expect(screen.getByLabelText('App encryption key')).toHaveValue('')
  })

  it('after a save the typed key is cleared and only the new fingerprint shows', async () => {
    let fp: string | null = null
    h.get.mockImplementation(async () => ({
      data: {
        data: fp
          ? { known: true, key: '••••••', fp, source: 'entry' }
          : { known: false, key: null, fp: null, source: null, code: 'APP_KEY_UNKNOWN' }
      }
    }))
    h.put.mockImplementation(async () => {
      fp = 'ffffeeeeddddccccbbbbaaaa99998888'
      return { data: { data: { fp, changed: true, verified: 'hub-link' } } }
    })
    renderField()
    expect(await screen.findByText(/does not know this app's encryption key/)).toBeInTheDocument()
    const input = screen.getByLabelText('App encryption key')
    fireEvent.change(input, { target: { value: KEY } })
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }))
    await waitFor(() =>
      expect(h.put).toHaveBeenCalledWith('/hub/environments/10/app-key', { key: KEY })
    )
    expect(await screen.findByText('ffffeeeeddddccccbbbbaaaa99998888')).toBeInTheDocument()
    expect(input).toHaveValue('')
    expect(screen.queryByDisplayValue(KEY)).toBeNull()
    expect(screen.queryByText(KEY)).toBeNull()
  })

  it('refuses a value that is not 64 hex characters before asking the Hub', async () => {
    h.get.mockResolvedValue({
      data: { data: { known: false, key: null, fp: null, source: null } }
    })
    renderField()
    const input = await screen.findByLabelText('App encryption key')
    fireEvent.change(input, { target: { value: 'not-a-key' } })
    expect(screen.getByRole('button', { name: 'Save key' })).toBeDisabled()
    expect(screen.getByText(/64 characters, 0–9 and a–f/)).toBeInTheDocument()
  })

  it('a key that cannot change on a shared deployment says there is no override and what to do', async () => {
    h.get.mockResolvedValue({
      data: {
        data: {
          known: true,
          key: '••••••',
          fp: '0123456789abcdef0123456789abcdef',
          source: 'entry'
        }
      }
    })
    h.put.mockRejectedValue({
      response: { status: 409, data: { code: 'APP_KEY_IMMUTABLE', message: 'x' } }
    })
    renderField()
    fireEvent.change(await screen.findByLabelText('App encryption key'), {
      target: { value: KEY }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }))
    expect(
      await screen.findByText('The key of an app on a shared deployment cannot be changed')
    ).toBeInTheDocument()
    expect(screen.getByText(/There is no override for a lost key/)).toBeInTheDocument()
    // The typed key is gone from the field after a refusal, and nothing on the page shows it.
    expect(screen.getByLabelText('App encryption key')).toHaveValue('')
    expect(screen.queryByDisplayValue(KEY)).toBeNull()
    expect(document.body.textContent).not.toContain(KEY)
    expect(screen.getByLabelText('App encryption key')).toHaveAttribute('autocomplete', 'off')
  })

  it('names an entry the Hub can no longer open', async () => {
    h.get.mockResolvedValue({
      data: {
        data: {
          known: false,
          key: null,
          fp: null,
          source: null,
          code: 'APP_KEY_UNKNOWN',
          entry_unreadable: true
        }
      }
    })
    renderField()
    expect(await screen.findByText(/saved key can no longer be opened/)).toBeInTheDocument()
  })
})

describe('HubAppKeyField on a shared environment (design S12)', () => {
  it('a missing key is a lost key: no "enter it to place or move", and the support path', async () => {
    h.get.mockResolvedValue({
      data: { data: { known: false, key: null, fp: null, source: null, code: 'APP_KEY_UNKNOWN' } }
    })
    renderField(true)
    expect(await screen.findByText(/already runs on a shared deployment/)).toBeInTheDocument()
    expect(screen.queryByText(/to place or move it onto a shared deployment/)).toBeNull()
    expect(screen.getByText(/There is no override for a lost key/)).toBeInTheDocument()
  })
})
