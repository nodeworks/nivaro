import { useState } from 'react'
import { useNivaroClient } from '../../../context'
import type { GroupRow } from '../../../lib/layout-ops'
import { cn } from '../../../lib/utils'
import { SimpleSelect } from '../../ui/SimpleSelect'
import { createLayout } from '../overview/OverviewActions'
import { apiFailure, useInvalidateLayouts, useRoleNames } from '../overview/overview-api'
import { inputBase, tintCard } from '../panel-style'
import { ghostBtn, primaryBtn, quiet } from './AiComposer'
import { fetchSlim, type SlimResult } from './ai-forms-api'
import { stashBuild } from './pending'
import { listNames, planSlimOps } from './plan'

/**
 * Lighter version for a role (#2671): which fields the role's people actually
 * changed (revisions, last 180 days), the rest hidden on a CHILD layout shown
 * to that role. Created only on "Create lighter version"; the new layout
 * opens with the change waiting as one unsaved step.
 */
export function SlimPanel({
  collection,
  layoutId,
  parentGroups,
  onOpenLayout,
  onBack
}: {
  collection: string
  layoutId: number
  /** The parent's groups as the draft has them (copied for sections hidden in the child). */
  parentGroups: GroupRow[]
  onOpenLayout: (id: number) => void
  onBack: () => void
}) {
  const client = useNivaroClient()
  const invalidate = useInvalidateLayouts(collection)
  const { data: roles = [] } = useRoleNames(true)
  const [roleId, setRoleId] = useState('')
  const [result, setResult] = useState<SlimResult | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const look = async () => {
    if (!roleId) return
    setBusy(true)
    setError(null)
    try {
      const r = await fetchSlim(client, layoutId, roleId)
      setResult(r)
      setName(r.name ?? '')
    } catch (err) {
      setError(apiFailure(err, 'Could not read this role’s edits').message)
    } finally {
      setBusy(false)
    }
  }

  const create = async () => {
    const plan = result?.plan
    if (!result || !plan || !name.trim()) return
    setBusy(true)
    setError(null)
    try {
      const id = await createLayout(client, {
        collection,
        name: name.trim(),
        layout_type: 'grouped'
      })
      if (id == null) throw new Error('No id came back')
      const parent = { id: layoutId, groups: parentGroups }
      stashBuild(id, {
        label: `Lighter version for ${result.role.name}`,
        plan: (bundle) => planSlimOps(bundle, parent, plan, result.role),
        done: `Lighter version drafted. Check it and Save.`
      })
      invalidate()
      onOpenLayout(id)
    } catch (err) {
      setError(apiFailure(err, 'Could not create the form').message)
    } finally {
      setBusy(false)
    }
  }

  const plan = result?.plan
  return (
    <div className='space-y-2.5' data-ai-slim=''>
      <p className='text-[12px] font-semibold text-slate-700 dark:text-foreground'>
        Lighter version for a role
      </p>
      <p className={quiet}>
        Keeps the fields that role’s people changed in the last 180 days and hides the rest, on a
        new form that inherits from this one and is shown to that role.
      </p>
      <div className='flex items-center gap-2'>
        <SimpleSelect
          value={roleId}
          onChange={(v) => {
            setRoleId(v)
            setResult(null)
          }}
          options={roles.map((r) => ({ value: r.id, label: r.name }))}
          ariaLabel='Role'
          className='h-8 flex-1 text-[12.5px]'
          triggerProps={{ 'data-ai-slim-role': '' }}
        />
        <button
          type='button'
          className={primaryBtn}
          disabled={!roleId || busy}
          onClick={() => void look()}
          data-ai-slim-look=''
        >
          {busy && !result ? 'Reading…' : 'Look at their edits'}
        </button>
      </div>
      {result && !plan && (
        <p className={quiet} data-ai-slim-thin=''>
          Only {result.revisions} save{result.revisions === 1 ? '' : 's'} by {result.role.name}{' '}
          people in the last {result.days} days: too few to tell which fields they use.
        </p>
      )}
      {result && plan && (
        <>
          <p className={quiet}>
            {result.revisions} saves by {result.people} {result.people === 1 ? 'person' : 'people'}{' '}
            in the last {result.days} days. A field counts as used from {plan.min_changes} change
            {plan.min_changes === 1 ? '' : 's'}.
          </p>
          <div className={cn(tintCard, 'space-y-1 px-2.5 py-2')} data-ai-slim-keep=''>
            <p className='text-[12px] font-semibold text-slate-700 dark:text-foreground'>
              Keeps {plan.keep.length}
            </p>
            <ul className='space-y-0.5 text-[12.5px] text-slate-700 dark:text-foreground'>
              {plan.keep.map((k) => (
                <li key={k.field} className='flex justify-between gap-2'>
                  <span className='truncate'>{k.label}</span>
                  <span className='shrink-0 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                    {k.why === 'required'
                      ? 'required'
                      : `${k.changes} change${k.changes === 1 ? '' : 's'}`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className={cn(tintCard, 'space-y-1 px-2.5 py-2')} data-ai-slim-drop=''>
            <p className='text-[12px] font-semibold text-slate-700 dark:text-foreground'>
              Hides {plan.drop.length}
            </p>
            {plan.drop.length === 0 ? (
              <p className={quiet}>Nothing: this role uses every field on the form.</p>
            ) : (
              <ul className='space-y-0.5 text-[12.5px] text-slate-700 dark:text-foreground'>
                {plan.drop.map((d) => (
                  <li key={d.field} className='flex justify-between gap-2'>
                    <span className='truncate'>{d.label}</span>
                    {d.group_label && (
                      <span className='shrink-0 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
                        {d.group_label}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {plan.hide_groups.length > 0 && (
              <p className={quiet}>
                Also hides {listNames(plan.hide_groups.map((g) => `“${g.label}”`))}: nothing in it
                is used.
              </p>
            )}
          </div>
          <label className='block'>
            <span className='mb-1 block text-[11.5px] font-semibold text-slate-600 dark:text-muted-foreground'>
              Name
            </span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputBase}
              maxLength={80}
            />
          </label>
        </>
      )}
      {error && (
        <p role='alert' className='text-[12.5px] leading-snug text-red-700 dark:text-red-300'>
          {error}
        </p>
      )}
      <div className='flex items-center justify-end gap-1.5 pt-0.5'>
        <button type='button' className={ghostBtn} onClick={onBack}>
          Back
        </button>
        {plan && (
          <button
            type='button'
            className={primaryBtn}
            disabled={busy || !name.trim() || plan.drop.length === 0}
            onClick={() => void create()}
            data-ai-slim-create=''
          >
            {busy ? 'Creating…' : 'Create lighter version'}
          </button>
        )}
      </div>
    </div>
  )
}
