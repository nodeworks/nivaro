import { Monitor, Moon, Sun } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTheme } from '@/lib/theme'
import { cn } from '@/lib/utils'

type Theme = 'light' | 'dark' | 'system'

const MODES: { value: Theme; icon: React.ElementType; label: string }[] = [
  { value: 'light', icon: Sun, label: 'Light' },
  { value: 'system', icon: Monitor, label: 'System' },
  { value: 'dark', icon: Moon, label: 'Dark' }
]

export function ThemeSwitcher({ collapsed }: { collapsed: boolean }) {
  const { theme, setTheme } = useTheme()
  const current = MODES.find((m) => m.value === theme) ?? MODES[1]

  if (collapsed) {
    const nextIndex = (MODES.indexOf(current) + 1) % MODES.length
    const next = MODES[nextIndex]
    const Icon = current.icon
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type='button'
            onClick={() => setTheme(next.value)}
            aria-label={`Theme: ${current.label}. Click for ${next.label}`}
            className='flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-white/[0.05] hover:text-white'
          >
            <Icon className='h-[15px] w-[15px]' />
          </button>
        </TooltipTrigger>
        <TooltipContent side='right' sideOffset={8}>
          {current.label} theme
        </TooltipContent>
      </Tooltip>
    )
  }

  return (
    <div className='flex items-center gap-0.5 rounded-md bg-white/[0.06] p-0.5'>
      {MODES.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          type='button'
          onClick={() => setTheme(value)}
          aria-label={`${label} theme`}
          aria-pressed={theme === value}
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded transition-colors',
            theme === value
              ? 'bg-nvr-cyan/[0.2] text-nvr-cyan'
              : 'text-slate-500 hover:text-slate-300'
          )}
        >
          <Icon className='h-3.5 w-3.5' />
        </button>
      ))}
    </div>
  )
}
