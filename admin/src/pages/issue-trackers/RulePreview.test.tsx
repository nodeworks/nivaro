import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '@/lib/api'
import type { RuleDraft } from './api'
import { RulePreview } from './RulePreview'
import { newRule } from './rule-sentence'

const post = api.post as unknown as ReturnType<typeof vi.fn<(...args: any[]) => any>>

function view(draft: RuleDraft, qc: QueryClient) {
  return (
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <RulePreview draft={draft} />
      </QueryClientProvider>
    </MemoryRouter>
  )
}

const flush = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  post.mockReset()
  post.mockResolvedValue({
    data: {
      data: {
        would_open: [
          { issue: 11, at: '2026-11-16T10:00:00.000Z', title: 'Checkout fails' },
          { issue: 12, at: '2026-11-16T11:00:00.000Z', title: 'Save timeout' }
        ],
        held: [{ issue: 13, reason: 'Hourly limit reached' }],
        considered: 40,
        truncated: false
      }
    }
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('RulePreview', () => {
  it('asks once, 600 ms after the last change', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const draft = newRule(3, 'issue')
    const { rerender } = render(view(draft, qc))
    // the value the panel opens with is asked at once
    await flush(0)
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenLastCalledWith('/trackers/rules/preview', {
      rule: expect.objectContaining({ enabled: false, mode: 'suggest' }),
      days: 7
    })
    rerender(view({ ...draft, name: 'A' }, qc))
    await flush(300)
    rerender(view({ ...draft, name: 'AB' }, qc))
    await flush(599)
    expect(post).toHaveBeenCalledTimes(1)
    await flush(1)
    expect(post).toHaveBeenCalledTimes(2)
    expect(post.mock.calls[1][1].rule.name).toBe('AB')
  })

  it('says what it would have done, and switches to 30 days', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(view({ ...newRule(3, 'issue'), mode: 'create' }, qc))
    await flush(0)
    expect(screen.getByText(/Would have opened/).textContent).toMatch(
      /Would have opened 2 GitLab issues in the last 7 days/
    )
    expect(screen.getByText('Checkout fails')).toBeTruthy()
    expect(screen.getByText('Hourly limit reached')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '30 days' }))
    await flush(0)
    expect(post).toHaveBeenLastCalledWith(
      '/trackers/rules/preview',
      expect.objectContaining({ days: 30 })
    )
  })

  it('lists what to fix when the server says the rule is not valid', async () => {
    post.mockRejectedValue({
      response: {
        status: 400,
        data: {
          code: 'INVALID_RULE',
          errors: [{ path: 'action.connection', message: 'Choose a GitLab connection.' }]
        }
      }
    })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(view(newRule(3, 'issue'), qc))
    await flush(0)
    expect(screen.getByText('Fix the rule to see a preview')).toBeTruthy()
    expect(screen.getByText('Choose a GitLab connection.')).toBeTruthy()
  })
})
