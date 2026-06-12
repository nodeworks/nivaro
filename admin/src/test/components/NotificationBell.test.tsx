import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { NotificationBell } from '@/components/notification-bell'

// Mock socket.io — prevents real network connections
vi.mock('socket.io-client', () => ({
  io: () => ({
    on: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
  }),
}))

// Mock auth context
vi.mock('@/lib/auth', () => ({
  useAuth: () => ({ user: { id: 'user-1', static_token: null } }),
}))

// Mock API calls used by the bell
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
    ...actual,
    getUnreadCount: vi.fn().mockResolvedValue(0),
    getNotifications: vi.fn().mockResolvedValue([]),
    markAllRead: vi.fn().mockResolvedValue(undefined),
    markRead: vi.fn().mockResolvedValue(undefined),
  }
})

// Stub Popover to avoid Radix portal rendering issues in jsdom
vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('NotificationBell', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the notifications button', () => {
    render(<NotificationBell collapsed={false} />, { wrapper })
    expect(screen.getByRole('button', { name: /notifications/i })).toBeInTheDocument()
  })

  it('renders a bell icon (svg inside the button)', () => {
    render(<NotificationBell collapsed={false} />, { wrapper })
    const btn = screen.getByRole('button', { name: /notifications/i })
    expect(btn.querySelector('svg')).toBeInTheDocument()
  })

  it('does not show a badge when unread count is 0', () => {
    render(<NotificationBell collapsed={false} />, { wrapper })
    // Badge only mounts when unread > 0; with mock returning 0 it should be absent
    expect(screen.queryByText(/^\d+$/)).toBeNull()
  })

  it('renders in compact mode without crashing', () => {
    render(<NotificationBell collapsed={true} compact={true} />, { wrapper })
    expect(screen.getByRole('button', { name: /notifications/i })).toBeInTheDocument()
  })
})
