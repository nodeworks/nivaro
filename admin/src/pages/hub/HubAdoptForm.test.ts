import { beforeEach, describe, expect, it, vi } from 'vitest'

// Nivaro Hub (phase 1): storing one environment makes its dedicated placement first; when the
// environment then fails, that placement is deleted again so it never blocks its driver.

const h = vi.hoisted(() => ({ post: vi.fn(), delete: vi.fn() }))

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(),
    post: (url: string, body?: unknown) => h.post(url, body),
    patch: vi.fn(),
    put: vi.fn(),
    delete: (url: string) => h.delete(url)
  }
}))

const { createEnvironment, emptyEnvDraft } = await import('./HubAdoptForm')

const draft = { ...emptyEnvDraft('prod'), base_url: 'https://efp.example.com', driver_id: '3' }

beforeEach(() => {
  h.post.mockReset()
  h.delete.mockReset().mockResolvedValue({ status: 204 })
})

describe('createEnvironment', () => {
  it('names the placement it made on the environment', async () => {
    h.post.mockImplementation(async (url: string) =>
      url === '/hub/placements' ? { data: { data: { id: 41 } } } : { data: { data: { id: 7 } } }
    )
    await createEnvironment(1, draft, 0)
    expect(h.post).toHaveBeenLastCalledWith(
      '/hub/apps/1/environments',
      expect.objectContaining({ key: 'prod', placement_id: 41 })
    )
    expect(h.delete).not.toHaveBeenCalled()
  })

  it('a failed environment deletes the placement it made and rethrows', async () => {
    const refusal = { response: { status: 409, data: { code: 'KEY_TAKEN' } } }
    h.post.mockImplementation(async (url: string) => {
      if (url === '/hub/placements') return { data: { data: { id: 41 } } }
      throw refusal
    })
    await expect(createEnvironment(1, draft, 0)).rejects.toBe(refusal)
    expect(h.delete).toHaveBeenCalledWith('/hub/placements/41')
  })

  it('a failed clean-up never hides the environment error', async () => {
    const refusal = new Error('env refused')
    h.post.mockImplementation(async (url: string) => {
      if (url === '/hub/placements') return { data: { data: { id: 41 } } }
      throw refusal
    })
    h.delete.mockRejectedValue(new Error('network'))
    await expect(createEnvironment(1, draft, 0)).rejects.toBe(refusal)
  })

  it('without a driver no placement is made or deleted', async () => {
    h.post.mockResolvedValue({ data: { data: { id: 7 } } })
    await createEnvironment(1, { ...draft, driver_id: '' }, 0)
    expect(h.post).toHaveBeenCalledTimes(1)
    expect(h.delete).not.toHaveBeenCalled()
  })
})
