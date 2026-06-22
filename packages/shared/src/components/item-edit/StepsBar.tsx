import { Check } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { StepDef } from './types'

export function StepsBar({
  steps,
  active,
  completed,
  errorSteps,
  onStepClick
}: {
  steps: StepDef[]
  active: string
  completed: Set<string>
  errorSteps?: Set<string>
  onStepClick: (k: string) => void
}) {
  return (
    <div className='w-full grid pt-5 pb-3' style={{ gridTemplateColumns: `repeat(${steps.length}, 1fr)` }}>
      {steps.map((s, i) => {
        const isActive = s.key === active
        const isDone = completed.has(s.key) && !isActive
        const hasError = errorSteps?.has(s.key) && !isActive
        return (
          <div key={s.key} className='relative flex flex-col items-center gap-2 px-1'>
            {i < steps.length - 1 && (
              <div
                className='absolute top-4 left-1/2 w-full -translate-y-1/2'
                style={{ right: 0 }}
              >
                <div
                  className={cn(
                    'h-0.5 w-full transition-colors duration-500',
                    isDone ? 'bg-emerald-400' : 'bg-slate-200 dark:bg-slate-700'
                  )}
                />
              </div>
            )}
            <button
              type='button'
              onClick={() => onStepClick(s.key)}
              className={cn(
                'relative z-10 flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00ceff] focus-visible:ring-offset-2',
                isActive
                  ? 'bg-[#00ceff] text-[#172940] shadow-[0_0_0_5px_rgba(0,206,255,0.16)]'
                  : hasError
                    ? 'bg-red-500 text-white'
                    : isDone
                      ? 'bg-emerald-500 text-white'
                      : 'border-2 border-slate-200 bg-white text-slate-400 hover:border-slate-300 hover:text-slate-500 dark:border-slate-700 dark:bg-transparent dark:text-slate-500 dark:hover:border-slate-600'
              )}
            >
              {isDone && !hasError
                ? <Check className='h-3.5 w-3.5' strokeWidth={2.5} />
                : <span className='text-[11px] font-bold'>{i + 1}</span>
              }
            </button>
            <span
              className={cn(
                'text-center text-[11px] leading-tight transition-colors duration-200',
                isActive
                  ? 'font-semibold text-slate-900 dark:text-slate-100'
                  : hasError
                    ? 'font-medium text-red-500'
                    : isDone
                      ? 'font-medium text-slate-400 dark:text-slate-500'
                      : 'font-medium text-slate-400 dark:text-slate-500'
              )}
            >
              {s.label}
            </span>
          </div>
        )
      })}
    </div>
  )
}
