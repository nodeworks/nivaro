import { useQueryClient } from '@tanstack/react-query'
import { Lock, Smartphone } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { useItemEditAuth, useNivaroClient } from '../../../context'
import { patch, post } from '../../../lib/commands'
import {
  activeFreeze,
  activeWindowOf,
  activeWindowPatch,
  conditionsWithKey,
  dayWords,
  freezeOf,
  freezePatch,
  localDay,
  phoneOf,
  phoneOfPatch,
  windowState,
  windowWords
} from '../../../lib/layout-resolve'
import { cn } from '../../../lib/utils'
import { useLayoutEditorHost } from '../host'
import { apiFailure, useInvalidateLayouts } from '../overview/overview-api'
import { amberStrip } from '../panel-style'
import { inputCls, PickList, quietText, Setting, smallBtn } from './controls'
import type { SectionProps } from './section-props'
import { settingsKeys, useCollectionLayoutList } from './settings-api'
import { layoutKindOf } from './settings-registry'

/**
 * Form resolution and edit rules (#2714 #2715 #2717), stored in the layout's
 * `conditions` beside the role list (lib/layout-resolve.ts). The server
 * decides; these rows set them and say what they do today.
 */

const dateCls = cn(inputCls, 'h-8 w-[150px] font-mono dark:[color-scheme:dark]')

/** #2714 — the days this form resolves on. */
export function ActiveDatesSetting(props: SectionProps) {
  const { layout } = props
  const stored = activeWindowOf(layout.conditions)
  const [from, setFrom] = useState(stored?.from ?? '')
  const [until, setUntil] = useState(stored?.until ?? '')
  useEffect(() => {
    setFrom(stored?.from ?? '')
    setUntil(stored?.until ?? '')
  }, [stored?.from, stored?.until])
  const backwards = !!from && !!until && from > until
  const commit = (f: string, u: string) => {
    if (f && u && f > u) return
    if ((f || null) === (stored?.from ?? null) && (u || null) === (stored?.until ?? null)) return
    props.set(
      activeWindowPatch(layout.conditions, { from: f || null, until: u || null }),
      f || u ? 'Set active dates' : 'Clear active dates'
    )
  }
  const state = windowState(stored, localDay())
  return (
    <Setting
      k='layout.conditions.active_window'
      note={
        backwards ? (
          <span className='text-amber-700 dark:text-amber-300'>
            The end comes before the start.
          </span>
        ) : stored && state ? (
          <span data-active-window-state={state}>
            {state === 'open'
              ? `In use now, ${windowWords(stored)}.`
              : state === 'before'
                ? `Not in use yet: starts ${dayWords(stored.from as string)}.`
                : `No longer in use: ended ${dayWords(stored.until as string)}.`}
          </span>
        ) : null
      }
    >
      <div className='flex flex-wrap items-end gap-2'>
        <label className='flex flex-col gap-1'>
          <span className={quietText}>From</span>
          <input
            type='date'
            aria-label='Active from'
            value={from}
            max={until || undefined}
            onChange={(e) => {
              setFrom(e.target.value)
              commit(e.target.value, until)
            }}
            className={dateCls}
          />
        </label>
        <label className='flex flex-col gap-1'>
          <span className={quietText}>Until</span>
          <input
            type='date'
            aria-label='Active until'
            value={until}
            min={from || undefined}
            onChange={(e) => {
              setUntil(e.target.value)
              commit(from, e.target.value)
            }}
            className={dateCls}
          />
        </label>
        {(from || until) && (
          <button
            type='button'
            className={cn(smallBtn, 'mb-0.5')}
            onClick={() => {
              setFrom('')
              setUntil('')
              commit('', '')
            }}
          >
            Clear
          </button>
        )}
      </div>
    </Setting>
  )
}

/** #2715 — this form's phone version, or the form this one is the phone version of. */
export function PhoneVersionSetting(props: SectionProps) {
  const { layout, collection } = props
  const id = Number(layout.id)
  const host = useLayoutEditorHost()
  const client = useNivaroClient()
  const qc = useQueryClient()
  const invalidate = useInvalidateLayouts(collection)
  const layouts = useCollectionLayoutList(collection)
  const [busy, setBusy] = useState(false)
  const forms = layouts.filter((l) => layoutKindOf(l) === 'grouped')
  const of = phoneOf(layout.conditions)
  const variant = forms.find((l) => l.id !== id && phoneOf(l.conditions) === id) ?? null
  const desktop = of != null ? (forms.find((l) => l.id === of) ?? null) : null
  const open = (layoutId: number) => {
    if (host.layoutLink) host.navigate(host.layoutLink(collection, layoutId))
  }

  const makeVariant = async () => {
    setBusy(true)
    try {
      const base = String(layout.name || 'Form')
      const res = await client.request<{ data?: { id?: number; conditions?: unknown } }>(
        post(`/collection-layouts/${id}/clone`, { name: `${base} (phone)`.slice(0, 255) })
      )
      const made = res?.data
      if (!made?.id) throw new Error('No id came back')
      await client.request(
        patch(`/collection-layouts/${made.id}`, {
          conditions: conditionsWithKey(made.conditions, 'phone_of', id)
        })
      )
      void qc.invalidateQueries({ queryKey: settingsKeys.layouts(collection) })
      invalidate()
      toast.success('Phone version made: remove what a phone does not need')
      open(Number(made.id))
    } catch (err) {
      toast.error(apiFailure(err, 'Could not make the phone version').message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Setting
      k='layout.conditions.phone_of'
      note={
        of != null ? (
          <span data-phone-of={of}>
            This form opens instead of{' '}
            <strong className='font-medium text-slate-700 dark:text-foreground'>
              {desktop?.name ?? `form ${of}`}
            </strong>{' '}
            on small screens, for the records and roles that form gets.
          </span>
        ) : null
      }
    >
      {variant ? (
        <div
          data-phone-version={variant.id}
          className='flex flex-wrap items-center gap-2 text-[12.5px] text-slate-700 dark:text-foreground'
        >
          <Smartphone className='h-3.5 w-3.5 shrink-0 text-slate-500 dark:text-muted-foreground' />
          <span className='min-w-0 truncate'>{variant.name}</span>
          {host.layoutLink && (
            <button type='button' className={smallBtn} onClick={() => open(variant.id)}>
              Open
            </button>
          )}
        </div>
      ) : (
        <div className='flex flex-wrap items-center gap-2'>
          <PickList
            ariaLabel='Phone version of'
            value={of != null ? String(of) : null}
            placeholder='Not a phone version'
            clearLabel='Not a phone version'
            options={forms
              .filter((l) => l.id !== id && phoneOf(l.conditions) == null)
              .map((l) => ({ value: String(l.id), label: l.name }))}
            onChange={(v) =>
              props.set(
                phoneOfPatch(layout.conditions, v ? Number(v) : null),
                v ? 'Make this a phone version' : 'Stop being a phone version'
              )
            }
            className='w-[220px]'
          />
          {of == null && (
            <button
              type='button'
              className={smallBtn}
              disabled={busy}
              data-action='make-phone-version'
              onClick={() => void makeVariant()}
            >
              <Smartphone className='h-3.5 w-3.5' />
              {busy ? 'Making…' : 'Make a phone version'}
            </button>
          )}
          {desktop && host.layoutLink && (
            <button type='button' className={smallBtn} onClick={() => open(desktop.id)}>
              Open {desktop.name}
            </button>
          )}
        </div>
      )}
    </Setting>
  )
}

/** #2717 — refuse edits to this layout until a date. */
export function FreezeSetting(props: SectionProps) {
  const { layout } = props
  const { userId } = useItemEditAuth()
  const stored = freezeOf(layout.conditions)
  const inForce = activeFreeze(layout.conditions)
  const [until, setUntil] = useState('')
  const [reason, setReason] = useState('')
  const ready = until > localDay() && reason.trim().length >= 3
  const freeze = () => {
    if (!ready) return
    props.set(
      freezePatch(layout.conditions, {
        until,
        reason: reason.trim().slice(0, 300),
        by: userId || null,
        at: new Date().toISOString()
      }),
      `Freeze edits until ${dayWords(until)}`
    )
    setUntil('')
    setReason('')
  }
  return (
    <Setting k='layout.conditions.freeze'>
      {stored ? (
        <div
          data-layout-frozen={stored.until}
          className={cn(
            'flex flex-wrap items-center gap-2 rounded-md border px-2.5 py-2 text-[12.5px]',
            inForce
              ? amberStrip
              : 'border-slate-200 text-slate-600 dark:border-border dark:text-muted-foreground'
          )}
        >
          <Lock className='h-3.5 w-3.5 shrink-0' />
          <span className='min-w-0 flex-1'>
            {inForce ? 'Frozen until ' : 'The freeze ended on '}
            {dayWords(stored.until)}
            {stored.reason ? `: ${stored.reason}` : ''}
          </span>
          <button
            type='button'
            className={smallBtn}
            data-action='lift-freeze'
            onClick={() =>
              props.set(
                freezePatch(layout.conditions, null),
                inForce ? 'Lift the edit freeze' : 'Remove the ended freeze'
              )
            }
          >
            {inForce ? 'Lift' : 'Remove'}
          </button>
        </div>
      ) : (
        <div className='flex flex-wrap items-end gap-2'>
          <label className='flex flex-col gap-1'>
            <span className={quietText}>Until</span>
            <input
              type='date'
              aria-label='Frozen until'
              value={until}
              min={localDay()}
              onChange={(e) => setUntil(e.target.value)}
              className={dateCls}
            />
          </label>
          <label className='flex min-w-[180px] flex-1 flex-col gap-1'>
            <span className={quietText}>Reason people see</span>
            <input
              value={reason}
              maxLength={300}
              placeholder='e.g. Go-live on Monday'
              onChange={(e) => setReason(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') freeze()
              }}
              className={cn(inputCls, 'h-8')}
            />
          </label>
          <button
            type='button'
            className={cn(smallBtn, 'mb-0.5')}
            disabled={!ready}
            data-action='freeze'
            onClick={freeze}
          >
            <Lock className='h-3.5 w-3.5' />
            Freeze
          </button>
        </div>
      )}
    </Setting>
  )
}
