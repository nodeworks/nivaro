import { Check } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { StepDef } from './types'

export function StepsBar({
  steps,
  active,
  completed,
  errorSteps,
  onStepClick,
  embedded = false
}: {
  steps: StepDef[]
  active: string
  completed: Set<string>
  errorSteps?: Set<string>
  onStepClick: (k: string) => void
  embedded?: boolean
}) {
  return (
    <div
      className={cn(
        'flex overflow-hidden',
        embedded
          ? 'border-b border-slate-200 dark:border-border'
          : 'rounded-xl border border-slate-200 dark:border-border'
      )}
    >
      {steps.map((s, i) => {
        const isActive = s.key === active
        const isDone = completed.has(s.key) && !isActive
        const hasError = errorSteps?.has(s.key) && !isActive

        return (
          <button
            key={s.key}
            type='button'
            onClick={() => onStepClick(s.key)}
            className={cn(
              'group relative flex min-w-0 flex-1 items-center gap-2.5 px-4 py-3.5 text-left transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#00ceff]',
              i < steps.length - 1 && 'border-r',
              isActive
                ? 'border-r-[#172940]/20 bg-[#172940] dark:border-r-border dark:bg-[#00ceff]/[0.08]'
                : hasError
                  ? 'border-r-slate-200 bg-red-50/50 hover:bg-red-50 dark:border-r-border dark:bg-red-500/[0.04] dark:hover:bg-red-500/[0.07]'
                  : 'border-r-slate-200 bg-white hover:bg-slate-50/80 dark:border-r-border dark:bg-card dark:hover:bg-white/[0.02]'
            )}
          >
            {isActive && (
              <span className='pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-[#00ceff]' />
            )}

            <span
              className={cn(
                'flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[10px] font-bold leading-none transition-colors duration-200',
                isActive
                  ? 'bg-[#00ceff] text-[#172940]'
                  : isDone
                    ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400'
                    : hasError
                      ? 'bg-red-100 text-red-600 dark:bg-red-500/15 dark:text-red-400'
                      : 'bg-slate-100 text-slate-400 dark:bg-white/[0.06] dark:text-slate-500'
              )}
            >
              {isDone && !hasError ? (
                <Check className='h-[10px] w-[10px]' strokeWidth={3} />
              ) : hasError ? (
                '!'
              ) : (
                i + 1
              )}
            </span>

            <span
              className={cn(
                'min-w-0 truncate text-[12px] font-medium leading-none transition-colors duration-200',
                isActive
                  ? 'text-white dark:text-[#00ceff]'
                  : isDone
                    ? 'text-slate-400 dark:text-slate-500'
                    : hasError
                      ? 'font-semibold text-red-600 dark:text-red-400'
                      : 'text-slate-500 group-hover:text-slate-700 dark:text-slate-400 dark:group-hover:text-slate-300'
              )}
            >
              {s.label}
            </span>
          </button>
        )
      })}
    </div>
  )
}
