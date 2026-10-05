import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@nivaro/shared', () => ({
  NivaroProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DbTuningView: () => <div data-testid='tuning-view' />
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import DbTuning from '@/pages/DbTuning'

describe('DbTuning page', () => {
  it('renders the header and mounts the tuning view', () => {
    render(<DbTuning />)
    expect(screen.getByRole('heading', { name: 'Database tuning' })).toBeInTheDocument()
    expect(screen.getByTestId('tuning-view')).toBeInTheDocument()
  })
})
