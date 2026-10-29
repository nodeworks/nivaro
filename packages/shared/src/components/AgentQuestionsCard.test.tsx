// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type AgentQuestionRow, AgentQuestionsCard } from './AgentQuestionsCard'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const Q = '0b8f3c1e-1111-4a2b-9c3d-123456789abc'
const question = (over: Partial<AgentQuestionRow> = {}): AgentQuestionRow => ({
  id: Q,
  status: 'open',
  question: 'Ship order 7 today?',
  choices: ['Yes', 'No'],
  allow_text: false,
  collection: null,
  item: null,
  asked_by: 'Claude',
  asked_for: 'u1',
  asked_for_name: 'Rob Lee',
  recipient: 'u1',
  expires_at: new Date(Date.now() + 3 * 3_600_000).toISOString(),
  created_at: new Date().toISOString(),
  ...over
})

function mount(questions: AgentQuestionRow[]) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  const qc = new QueryClient()
  act(() =>
    root.render(
      <QueryClientProvider client={qc}>
        <AgentQuestionsCard questions={questions} />
      </QueryClientProvider>
    )
  )
  return {
    host,
    cleanup: () => {
      act(() => root.unmount())
      host.remove()
    }
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AgentQuestionsCard (#3220)', () => {
  it('renders nothing with no questions', () => {
    const { host, cleanup } = mount([])
    expect(host.querySelector('[data-my-work-questions]')).toBeNull()
    cleanup()
  })

  it('answers with one click on a choice and says it was sent', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: {} }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { host, cleanup } = mount([question()])
    expect(host.textContent).toContain('Ship order 7 today?')
    expect(host.textContent).toContain('your assistant')
    // Choices only: no free-text box.
    expect(host.querySelector('textarea')).toBeNull()
    const yes = host.querySelector('[data-my-work-question-choice="Yes"]') as HTMLButtonElement
    await act(async () => {
      yes.click()
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`/api/agent-questions/${Q}/answer`)
    expect(JSON.parse(String(init.body))).toEqual({ choice: 'Yes' })
    expect(host.textContent).toContain('Sent to Claude: Yes')
    cleanup()
  })

  it('offers free text, names whose assistant asked, and shows a refusal', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'This question is already expired' }), {
            status: 409
          })
      )
    )
    const { host, cleanup } = mount([
      question({ choices: [], allow_text: true, asked_for: 'u2', asked_for_name: 'Kim Ito' })
    ])
    expect(host.textContent).toContain('for Kim Ito')
    const box = host.querySelector('textarea') as HTMLTextAreaElement
    expect(box).not.toBeNull()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      setter?.call(box, 'Next week')
      box.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      ;(host.querySelector('button[type="submit"]') as HTMLButtonElement).click()
    })
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('already expired')
    cleanup()
  })
})
