import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement } from 'react'
import { useSettings } from '@/lib/useSettings'
import type { CMSSettings } from '@/lib/api'

// vi.mock is hoisted before variable declarations — use vi.hoisted() to share
// values between the factory closure and the rest of the test file.
const { mockSettings } = vi.hoisted(() => {
  const mockSettings: CMSSettings = {
    id: 1,
    project_name: 'Test Project',
    project_description: null,
    project_url: null,
    project_color: '#00ceff',
    default_language: 'en-US',
    updated_at: '2024-01-01T00:00:00Z',
    teams_webhook_url: null,
    ad_group_role_map: null,
    anthropic_api_key: null,
    presence_session_ttl: null,
    presence_sweep_interval: null,
    presence_ping_interval: null,
    ai_model: null,
    ai_max_tokens_generate: null,
    ai_max_tokens_summarize: null,
    sla_business_day_start: null,
    sla_business_day_end: null,
    sla_business_days: null,
    file_max_size_mb: null,
    collection_page_size: null,
    activity_retention_days: null,
    revision_retention_count: null,
  }
  return { mockSettings }
})

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    api: {
      get: vi.fn().mockResolvedValue({ data: { data: mockSettings } }),
      post: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    },
  }
})

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: React.ReactNode }) =>
    createElement(QueryClientProvider, { client: qc }, children)
}

describe('useSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns loading state initially', () => {
    const { result } = renderHook(() => useSettings(), { wrapper: makeWrapper() })
    expect(result.current.isLoading).toBe(true)
    expect(result.current.data).toBeUndefined()
  })

  it('returns settings data after fetch resolves', async () => {
    const { result } = renderHook(() => useSettings(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual(mockSettings)
    expect(result.current.data?.project_name).toBe('Test Project')
  })

  it('exposes isError false on success', async () => {
    const { result } = renderHook(() => useSettings(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.isError).toBe(false)
  })
})
