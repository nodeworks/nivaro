import { Check } from 'lucide-react'
import { cn } from '../../lib/utils'
import type { StepDef } from './types'

type StepState = 'active' | 'done' | 'error' | 'inactive'

const ARROW_DEPTH = 10
const SEP = 2 // separator strip width px
const R = 12  // bar corner radius px (matches rounded-xl = 0.75rem)

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

function getOuterClip(isFirst: boolean, isLast: boolean): string {
  if (isFirst && isLast) return 'none'
  const d = ARROW_DEPTH
  if (isFirst) return `polygon(0 0, calc(100% - ${d}px) 0, 100% 50%, calc(100% - ${d}px) 100%, 0 100%)`
  if (isLast) return `polygon(0 0, 100% 0, 100% 100%, 0 100%, ${d}px 50%)`
  return `polygon(0 0, calc(100% - ${d}px) 0, 100% 50%, calc(100% - ${d}px) 100%, 0 100%, ${d}px 50%)`
}

function getInnerClip(isFirst: boolean, isLast: boolean): string {
  if (isFirst && isLast) return 'none'
  const d = ARROW_DEPTH
  const s = SEP
  if (isLast) return `polygon(0 0, 100% 0, 100% 100%, 0 100%, ${d}px 50%)`
  if (isFirst) return `polygon(0 0, calc(100% - ${d + s}px) 0, calc(100% - ${s}px) 50%, calc(100% - ${d + s}px) 100%, 0 100%)`
  return `polygon(0 0, calc(100% - ${d + s}px) 0, calc(100% - ${s}px) 50%, calc(100% - ${d + s}px) 100%, 0 100%, ${d}px 50%)`
}

// border-radius string for each step position
function getBorderRadius(isFirst: boolean, isLast: boolean): string | undefined {
  if (isFirst && isLast) return `${R}px ${R}px 0 0`
  if (isFirst) return `${R}px 0 0 0`
  if (isLast) return `0 ${R}px 0 0`
  return undefined
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
        'relative flex h-9',
        embedded
          ? 'border-b border-slate-200 dark:border-border'
          : 'rounded-lg shadow-[0_0_0_1px_#e2e8f0,0_1px_3px_-1px_rgba(0,0,0,0.06)] dark:shadow-none dark:border dark:border-border'
      )}
    >
      {steps.map((s, i) => {
        const isFirst = i === 0
        const isLast = i === steps.length - 1
        const state = resolveState(s.key, active, completed, errorSteps)
        const isActive = state === 'active'
        const isDone = state === 'done'
        const hasError = state === 'error'
        const borderRadius = getBorderRadius(isFirst, isLast)

        return (
          <div
            key={s.key}
            className='relative min-w-0 flex-1'
            style={{
              clipPath: getOuterClip(isFirst, isLast),
              zIndex: steps.length - i,
              marginLeft: isFirst ? 0 : -ARROW_DEPTH,
              // overflow + translateZ: promotes wrapper to compositing layer so
              // Chrome properly clips clip-path'd children to border-radius
              overflow: 'hidden',
              transform: 'translateZ(0)',
              borderRadius,
            }}
          >
            {/* Separator — fills wrapper in border color; button's inner clip leaves SEP px visible at arrow edge */}
            {!isLast && (
              <div
                className='pointer-events-none absolute inset-0 bg-[#cbd5e1] dark:bg-[#334155]'
                style={{ borderRadius }}
              />
            )}

            <button
              type='button'
              onClick={() => onStepClick(s.key)}
              style={{
                clipPath: getInnerClip(isFirst, isLast),
                paddingLeft: isFirst ? 12 : 12 + ARROW_DEPTH,
                paddingRight: 12,
                borderRadius,
              }}
              className={cn(
                'group absolute inset-0 flex items-center gap-2 py-0 text-left transition-colors duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#00ceff]',
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

              {/* Step bubble */}
              <span
                className={cn(
                  'flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-full text-[9px] font-bold leading-none transition-colors duration-100',
                  isActive
                    ? 'bg-[#00ceff] text-[#172940]'
                    : isDone
                      ? 'bg-[#00ceff] text-[#172940]'
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
                  'min-w-0 truncate text-[11px] font-semibold leading-none transition-colors duration-100',
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
          </div>
        )
      })}
    </div>
  )
}
