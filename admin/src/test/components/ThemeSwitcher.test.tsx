import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ThemeSwitcher } from '@/components/theme-switcher'

const mockSetTheme = vi.fn()
let mockTheme = 'system'

vi.mock('@/lib/theme', () => ({
  useTheme: () => ({ theme: mockTheme, setTheme: mockSetTheme }),
}))

// Tooltip requires a provider in some versions — stub it to avoid portal issues
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children, asChild }: { children: React.ReactNode; asChild?: boolean }) => <>{children}</>,
  TooltipContent: () => null,
}))

describe('ThemeSwitcher (expanded)', () => {
  it('renders all three theme buttons', () => {
    render(<ThemeSwitcher collapsed={false} />)
    expect(screen.getByRole('button', { name: /light theme/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /system theme/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /dark theme/i })).toBeInTheDocument()
  })

  it('marks the active theme button as pressed', () => {
    mockTheme = 'system'
    render(<ThemeSwitcher collapsed={false} />)
    expect(screen.getByRole('button', { name: /system theme/i })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /light theme/i })).toHaveAttribute('aria-pressed', 'false')
  })

  it('calls setTheme when a button is clicked', async () => {
    mockTheme = 'system'
    render(<ThemeSwitcher collapsed={false} />)
    await userEvent.click(screen.getByRole('button', { name: /dark theme/i }))
    expect(mockSetTheme).toHaveBeenCalledWith('dark')
  })
})

describe('ThemeSwitcher (collapsed)', () => {
  it('renders a single accessible button', () => {
    mockTheme = 'light'
    render(<ThemeSwitcher collapsed={true} />)
    const btn = screen.getByRole('button')
    expect(btn).toBeInTheDocument()
    expect(btn).toHaveAttribute('aria-label')
  })

  it('cycles to the next theme on click', async () => {
    mockTheme = 'light' // light → system (index 0 → 1)
    render(<ThemeSwitcher collapsed={true} />)
    await userEvent.click(screen.getByRole('button'))
    expect(mockSetTheme).toHaveBeenCalledWith('system')
  })
})
