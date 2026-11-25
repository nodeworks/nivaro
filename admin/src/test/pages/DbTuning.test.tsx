import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@nivaro/shared', () => ({
  NivaroProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DbTuningView: () => <div data-testid='tuning-view' />,
  useOverflowTip: () => ({ current: null }),
  // hub-page → lib/hub-product → lib/api installs the client chaos interceptor at import.
  clientChaosAxiosInterceptor: () => (config: unknown) => config
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import DbTuning from '@/pages/DbTuning'

describe('DbTuning page', () => {
  it('describes the tab and mounts the tuning view', () => {
    render(<DbTuning />)
    expect(screen.getByText(/proposed from this instance/)).toBeInTheDocument()
    expect(screen.getByTestId('tuning-view')).toBeInTheDocument()
  })
})
