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
    <div className='w-full grid' style={{ gridTemplateColumns: `repeat(${steps.length}, 1fr)` }}>
      {steps.map((s, i) => {
        const isActive = s.key === active
        const isDone = completed.has(s.key) && !isActive
        const hasError = errorSteps?.has(s.key) && !isActive
        return (
          <div key={s.key} className='relative flex flex-col items-center gap-1.5 px-1'>
            {i < steps.length - 1 && (
              <div
                className='absolute top-3.5 left-1/2 w-full -translate-y-1/2'
                style={{ right: 0 }}
              >
                <div
                  className={cn(
                    'h-px w-full transition-colors duration-300',
                    isDone ? 'bg-emerald-400' : 'bg-slate-200'
                  )}
                />
              </div>
            )}
            <button
              type='button'
              onClick={() => onStepClick(s.key)}
              className={cn(
                'relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 text-[11px] font-semibold transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00ceff] focus-visible:ring-offset-2',
                isActive
                  ? 'border-[#00ceff] bg-[#00ceff] text-[#172940]'
                  : hasError
                    ? 'border-red-500 bg-red-500 text-white'
                    : isDone
                      ? 'border-emerald-500 bg-emerald-500 text-white'
                      : 'border-slate-200 bg-white text-slate-400 hover:border-slate-300'
              )}
            >
              {isDone && !hasError ? <Check className='h-3.5 w-3.5' strokeWidth={2.5} /> : <span>{i + 1}</span>}
            </button>
            <span
              className={cn(
                'text-center text-[11px] font-medium leading-tight',
                isActive ? 'text-slate-900' : hasError ? 'text-red-500' : isDone ? 'text-slate-600' : 'text-slate-400'
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
