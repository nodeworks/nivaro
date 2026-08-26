import { useQuery } from '@tanstack/react-query'
import { ExternalLink, Server } from 'lucide-react'
import { useState } from 'react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * Multi-instance switcher (#659) — a compact dropdown over the environments
 * registry listing every API-kind component with a base_url. Clicking a row
 * opens that instance's admin in a NEW TAB (external origin), the current
 * origin's row is marked. Renders nothing when the registry is empty or the
 * viewer isn't an admin (/environments is requireAdmin → 403).
 *
 * MOUNT (orchestrator — AppLayout sidebar footer, beside ThemeSwitcher):
 *   <InstanceSwitcher />
 */

interface EnvComponent {
  id: number
  name: string
  kind: 'api' | 'frontend' | 'service'
  base_url: string | null
}

interface Environment {
  id: number
  name: string
  color: string | null
  sort: number
  components: EnvComponent[]
}

const COLOR_DOT: Record<string, string> = {
  emerald: 'bg-emerald-500',
  amber: 'bg-amber-500',
  red: 'bg-red-500',
  sky: 'bg-sky-500',
  slate: 'bg-slate-400'
}

function sameOrigin(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).origin === window.location.origin
  } catch {
    return false
  }
}

export function InstanceSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const [open, setOpen] = useState(false)

  const { data: environments, isError } = useQuery<Environment[]>({
    queryKey: ['instance-switcher-environments'],
    queryFn: () => api.get<{ data: Environment[] }>('/environments').then((r) => r.data.data),
    staleTime: 5 * 60_000,
    retry: false
  })

  const rows = (environments ?? []).flatMap((env) =>
    env.components
      .filter((c) => c.kind === 'api' && !!c.base_url)
      .map((c) => ({
        key: `${env.id}-${c.id}`,
        envName: env.name,
        color: env.color,
        name: c.name,
        baseUrl: c.base_url as string,
        current: sameOrigin(c.base_url as string)
      }))
  )

  // Graceful null: non-admin (403), registry empty, or no API components.
  if (isError || rows.length === 0) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className='flex h-7 items-center gap-1.5 rounded-md px-2 text-[11.5px] text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-muted dark:hover:text-foreground'
          data-tip='Switch instance'
          aria-label='Switch instance'
        >
          <Server className='h-3.5 w-3.5' />
          {!collapsed && (
            <span className='max-w-[110px] truncate'>
              {rows.find((r) => r.current)?.envName ?? 'Instances'}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align='start' side='top' className='w-[260px] p-0'>
        <Command>
          <CommandInput placeholder='Search instances…' className='h-8 text-[12.5px]' />
          <CommandList>
            <CommandEmpty className='py-4 text-center text-[12px] text-slate-400'>
              No matching instance
            </CommandEmpty>
            <CommandGroup>
              {rows.map((r) => (
                <CommandItem
                  key={r.key}
                  value={`${r.envName} ${r.name}`}
                  onSelect={() => {
                    setOpen(false)
                    if (!r.current) window.open(r.baseUrl, '_blank', 'noopener')
                  }}
                  className='gap-2 text-[12.5px]'
                >
                  <span
                    className={cn(
                      'h-2 w-2 shrink-0 rounded-full',
                      COLOR_DOT[r.color ?? ''] ?? 'bg-slate-300'
                    )}
                  />
                  <span className='min-w-0 flex-1 truncate'>
                    <span className='font-medium'>{r.envName}</span>
                    <span className='text-slate-400'> · {r.name}</span>
                  </span>
                  {r.current ? (
                    <span className='shrink-0 rounded bg-nvr-cyan/10 px-1.5 py-px text-[10px] font-medium text-nvr-navy dark:text-nvr-cyan'>
                      current
                    </span>
                  ) : (
                    <ExternalLink className='h-3 w-3 shrink-0 text-slate-300' />
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
