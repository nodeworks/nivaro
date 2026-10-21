import { Fragment, useMemo } from 'react'
import type { DesignTarget } from '../design-context'
import { crumbsOf, KIND_WORDS } from '../nav/tree'
import { useInspectorEnv } from './kit'

/**
 * The inspector's eyebrow as a breadcrumb (#2622): "Field · Request ›
 * Billing", each step, tab or section a button that selects it, so the
 * parent's settings are one click away. Without anything above the target it
 * reads as before ("Field · Basic Information", "Section").
 */
export function Breadcrumb({
  kind,
  target,
  where = null
}: {
  /** "Field", "Panel", "Step"… */
  kind: string
  target: DesignTarget
  /** Shown after the kind when there is no breadcrumb (the header strip). */
  where?: string | null
}) {
  const env = useInspectorEnv()
  const crumbs = useMemo(() => crumbsOf(env.bundle, target), [env.bundle, target])
  if (crumbs.length === 0) return <>{where ? `${kind} · ${where}` : kind}</>
  return (
    <span data-breadcrumb=''>
      {kind} ·{' '}
      {crumbs.map((c, i) => (
        <Fragment key={c.target.kind === 'group' ? c.target.key : i}>
          {i > 0 && <span aria-hidden='true'> › </span>}
          {env.select ? (
            <button
              type='button'
              data-crumb={c.target.kind === 'group' ? c.target.key : undefined}
              data-tip={`Select the ${KIND_WORDS[c.kind].toLowerCase()} ${c.label}`}
              onClick={() => env.select?.(c.target)}
              className='rounded-sm text-slate-600 underline-offset-2 hover:text-slate-900 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-nvr-cyan dark:text-slate-300 dark:hover:text-foreground'
            >
              {c.label}
            </button>
          ) : (
            c.label
          )}
        </Fragment>
      ))}
    </span>
  )
}
