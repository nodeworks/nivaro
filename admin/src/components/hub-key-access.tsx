import { cn } from '@/lib/utils'

/**
 * Hub access on a named API key (Hub mode only): the `$hub` scope entry — `hub:read` (read and
 * plan) or `hub:write` (also change). Never implied by `*`. Shown only where the server lists the
 * `hub` feature (GET /api/app-info); a regular install never offers it.
 */
export const HUB_SCOPE = '$hub'
export type HubKeyAccess = 'none' | 'read' | 'write'

interface Scope {
  collection: string
  actions: string[]
}

export function hubAccessOf(scopes: Scope[]): HubKeyAccess {
  const actions = scopes.find((s) => s.collection === HUB_SCOPE)?.actions ?? []
  if (actions.includes('*') || actions.includes('write')) return 'write'
  return actions.includes('read') ? 'read' : 'none'
}

export function withHubAccess<T extends Scope>(scopes: T[], access: HubKeyAccess): T[] {
  const rest = scopes.filter((s) => s.collection !== HUB_SCOPE)
  if (access === 'none') return rest
  return [
    ...rest,
    { collection: HUB_SCOPE, actions: access === 'write' ? ['read', 'write'] : ['read'] } as T
  ]
}

const OPTIONS: Array<{ value: HubKeyAccess; label: string }> = [
  { value: 'none', label: 'Off' },
  { value: 'read', label: 'hub:read' },
  { value: 'write', label: 'hub:write' }
]

const HINT: Record<HubKeyAccess, string> = {
  none: 'The key cannot call the Hub API (/api/hub), whatever its other scopes.',
  read: 'Reads apps, environments, status, runs and history, and makes plans. Changes nothing. Acts as the key’s owner: an app owner’s key sees only their apps.',
  write:
    'Also changes the Hub: apps, owners, environments, promotions, moves and upgrades, as far as the key’s owner may. Connected apps (MCP) never write, whatever the key allows.'
}

export function HubKeyAccessControl({
  value,
  onChange,
  disabled
}: {
  value: HubKeyAccess
  onChange: (v: HubKeyAccess) => void
  disabled?: boolean
}) {
  return (
    <div className='space-y-1.5'>
      <fieldset
        aria-label='Hub API access'
        className='m-0 inline-flex min-w-0 max-w-full flex-wrap rounded-md border border-slate-200 bg-slate-50 p-0.5 dark:border-border dark:bg-muted/40'
        data-key-hub-access
      >
        {OPTIONS.map((o) => (
          <button
            key={o.value}
            type='button'
            aria-pressed={value === o.value}
            disabled={disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              'h-7 whitespace-nowrap rounded px-3 text-[12px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/50 disabled:cursor-not-allowed disabled:opacity-60',
              value === o.value
                ? 'bg-white text-slate-900 shadow-sm dark:bg-white/10 dark:text-slate-100 dark:ring-1 dark:ring-white/15'
                : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200'
            )}
          >
            {o.label}
          </button>
        ))}
      </fieldset>
      <p className='text-[11px] text-slate-500 dark:text-slate-400'>{HINT[value]}</p>
    </div>
  )
}
