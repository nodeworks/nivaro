import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, it, type vi } from 'vitest'
import { api } from '@/lib/api'
import { WhyNotFired } from './WhyNotFired'

const get = api.get as unknown as ReturnType<typeof vi.fn<(...args: any[]) => any>>

function renderIt() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <WhyNotFired />
      </QueryClientProvider>
    </MemoryRouter>
  )
}

beforeEach(() => {
  get.mockReset()
})

describe('WhyNotFired', () => {
  it('explains an issue: live rows, stored rows and a flow-made decision', async () => {
    get.mockResolvedValue({
      data: {
        data: [
          {
            rule: 4,
            name: 'Crashes',
            outcome: 'no_match',
            detail: 'Severity medium is below high',
            at: '2026-11-17T15:00:00.000Z',
            live: true
          },
          {
            rule: -1,
            name: 'Flow',
            outcome: 'fired',
            detail: 'Opened group/proj#7',
            at: '2026-11-17T14:00:00.000Z'
          }
        ]
      }
    })
    renderIt()
    fireEvent.change(screen.getByLabelText('Issue number'), { target: { value: '#12' } })
    fireEvent.click(screen.getByRole('button', { name: /Explain/ }))
    expect(await screen.findByText('Severity medium is below high')).toBeTruthy()
    expect(get).toHaveBeenCalledWith('/trackers/rules/explain', { params: { issue: 12 } })
    expect(screen.getByText('Did not match')).toBeTruthy()
    expect(screen.getByText('Flow')).toBeTruthy()
    expect(screen.getByText('Fired')).toBeTruthy()
    expect(screen.getByText('Opened group/proj#7')).toBeTruthy()
  })

  it('says when the issue does not exist, and refuses text that is not a number', async () => {
    get.mockRejectedValue({ response: { status: 404, data: { code: 'NOT_FOUND' } } })
    renderIt()
    fireEvent.change(screen.getByLabelText('Issue number'), { target: { value: 'abc' } })
    fireEvent.click(screen.getByRole('button', { name: /Explain/ }))
    expect(screen.getByText(/Type an issue number/)).toBeTruthy()
    expect(get).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Issue number'), { target: { value: '99' } })
    fireEvent.click(screen.getByRole('button', { name: /Explain/ }))
    expect(await screen.findByText('There is no issue #99 in the issue log.')).toBeTruthy()
  })
})
