import { useEffect, useState } from 'react'
import { cn } from '../../../lib/utils'
import { inputCls, Setting } from '../settings/controls'
import type { SectionProps } from '../settings/section-props'
import { DEFAULT_COST_LIMIT, readTesting, testingPatch } from './testing-model'

/**
 * Form cost limit (#2649): above this many requests on open, Test → Cost and
 * Check impact warn. Stored beside the pinned test records (conditions.testing).
 * Commits on blur or Enter; blank = the default.
 */
export function CostLimitSetting(props: SectionProps) {
  const { layout } = props
  const cfg = readTesting(layout.conditions)
  const stored = cfg.cost_limit
  const [text, setText] = useState(stored == null ? '' : String(stored))
  useEffect(() => setText(stored == null ? '' : String(stored)), [stored])
  const commit = () => {
    const n = Number(text.trim())
    const next = text.trim() === '' || !Number.isFinite(n) || n <= 0 ? null : Math.round(n)
    if (next === stored) return setText(next == null ? '' : String(next))
    props.set(
      testingPatch(layout.conditions, { ...cfg, cost_limit: next }),
      next == null ? 'Reset the form cost limit' : `Set the form cost limit to ${next}`
    )
  }
  return (
    <Setting
      k='tool.cost_limit'
      htmlFor='setting-cost_limit'
      control={
        <input
          id='setting-cost_limit'
          inputMode='numeric'
          value={text}
          placeholder={String(DEFAULT_COST_LIMIT)}
          onChange={(e) => setText(e.target.value.replace(/[^0-9]/g, ''))}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
          className={cn(inputCls, 'w-24 font-mono')}
        />
      }
    />
  )
}
