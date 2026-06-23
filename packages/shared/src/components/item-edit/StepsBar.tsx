import { Check } from 'lucide-react'
import { Fragment } from 'react'
import { cn } from '../../lib/utils'
import type { StepDef } from './types'

type StepState = 'active' | 'done' | 'error' | 'inactive'

function resolveState(
  key: string,
  active: string,
  completed: Set<string>,
  errorSteps?: Set<string>
): StepState {
  if (key === active) return 'active'
  if (errorSteps?.has(key)) return 'error'
  if (completed.has(key)) return 'done'
  return 'inactive'
}

// Must match each button's bg colour exactly — used to fill SVG separator correctly
const LIGHT_BG: Record<StepState, string> = {
  active: '#172940',
  done:   '#f1f5f9', // slate-100
  error:  '#fef2f2', // red-50
  inactive: '#f1f5f9', // slate-100
}

const DARK_BG: Record<StepState, string> = {
  active:   '#172940',
  done:     '#1e293b',
  error:    '#1a0909',
  inactive: '#1e293b',
}

// Separator arrow: fills the full SVG area so no page-bg bleed occurs.
// Structure: rect (right step bg) → outer polygon (border colour) → inner polygon (left step bg)
function Chevron({
  leftState,
  rightState
}: {
  leftState: StepState
  rightState: StepState
}) {
  return (
    <span className='pointer-events-none z-10 w-2 shrink-0 self-stretch' aria-hidden='true'>
      {/* light — height='100%' attribute prevents SVG defaulting to 150px */}
      <svg height='100%' width='100%' viewBox='0 0 20 100' preserveAspectRatio='none' className='block dark:hidden'>
        <rect width='20' height='100' fill={LIGHT_BG[rightState]} />
        <polygon points='0,0 20,50 0,100' fill='#cbd5e1' />
        <polygon points='0,0 16,50 0,100' fill={LIGHT_BG[leftState]} />
      </svg>
      {/* dark */}
      <svg height='100%' width='100%' viewBox='0 0 20 100' preserveAspectRatio='none' className='hidden dark:block'>
        <rect width='20' height='100' fill={DARK_BG[rightState]} />
        <polygon points='0,0 20,50 0,100' fill='#334155' />
        <polygon points='0,0 16,50 0,100' fill={DARK_BG[leftState]} />
      </svg>
    </span>
  )
}

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
        'flex h-9 overflow-hidden',
        embedded
          ? 'border-b border-slate-200 dark:border-border'
          : 'rounded-lg shadow-[0_0_0_1px_#e2e8f0,0_1px_3px_-1px_rgba(0,0,0,0.06)] dark:shadow-none dark:border dark:border-border'
      )}
    >
      {steps.map((s, i) => {
        const state = resolveState(s.key, active, completed, errorSteps)
        const nextState = i < steps.length - 1
          ? resolveState(steps[i + 1].key, active, completed, errorSteps)
          : null
        const isLast = i === steps.length - 1
        const isActive = state === 'active'
        const isDone = state === 'done'
        const hasError = state === 'error'

        return (
          <Fragment key={s.key}>
            <button
              type='button'
              onClick={() => onStepClick(s.key)}
              className={cn(
                'group relative flex min-w-0 flex-1 items-center gap-2 px-3 py-0 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#00ceff]',
                isActive
                  ? 'bg-[#172940] dark:bg-[#00ceff]/[0.1]'
                  : hasError
                    ? 'bg-[#fef2f2] hover:bg-red-100/60 dark:bg-red-500/[0.05] dark:hover:bg-red-500/[0.08]'
                    : 'bg-[#f1f5f9] hover:bg-slate-200/70 dark:bg-[#1e293b] dark:hover:bg-white/[0.04]'
              )}
            >
              {/* Cyan top accent — active only */}
              {isActive && (
                <span className='pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-[#00ceff]' />
              )}

              {/* Bubble */}
              <span
                className={cn(
                  'flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full text-[9px] font-bold leading-none transition-colors duration-150',
                  isActive
                    ? 'bg-[#00ceff] text-[#172940]'
                    : isDone
                      ? 'bg-[#00ceff] text-white'
                      : hasError
                        ? 'bg-red-500 text-white'
                        : 'bg-slate-300 text-slate-500 dark:bg-white/[0.12] dark:text-slate-400'
                )}
              >
                {isDone ? (
                  <Check className='h-[7px] w-[7px]' strokeWidth={3} />
                ) : hasError ? (
                  '!'
                ) : (
                  i + 1
                )}
              </span>

              {/* Label */}
              <span
                className={cn(
                  'min-w-0 truncate text-[11px] font-semibold leading-none transition-colors duration-150',
                  isActive
                    ? 'text-white dark:text-[#00ceff]'
                    : isDone
                      ? 'text-slate-400 dark:text-slate-500'
                      : hasError
                        ? 'text-red-600 dark:text-red-400'
                        : 'text-slate-400 group-hover:text-slate-600 dark:text-slate-500 dark:group-hover:text-slate-300'
                )}
              >
                {s.label}
              </span>
            </button>

            {!isLast && nextState !== null && (
              <Chevron leftState={state} rightState={nextState} />
            )}
          </Fragment>
        )
      })}
    </div>
  )
}
