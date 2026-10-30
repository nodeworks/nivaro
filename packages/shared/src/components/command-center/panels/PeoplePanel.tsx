import { useMutation } from '@tanstack/react-query'
import { ChevronRight, Footprints, LocateFixed, MessageSquare } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../../context'
import { post } from '../../../lib/commands'
import { toastError } from '../../../lib/error-toast'
import { cn } from '../../../lib/utils'
import { UserChip } from '../../item-edit/UserChip'
import { useCc } from '../state'
import { BUTTON, FAINT, FOCUS, MUTED, PANEL, PANEL_HEAD, TITLE } from '../theme'
import type { PersonOn, Snapshot } from '../types'

/**
 * CC-13 — people on now, grouped like the map bubbles (offices, regions, no location). Groups
 * start collapsed to counts; open one for names and what each person is on (page + the record
 * they have open, only as far as you may see it). A name opens their card; administrators also
 * get "Follow in Traffic Map" and "Message these people" (one in-app note each, capped).
 */

const MESSAGE_CAP = 50
type Group = Snapshot['people']['regions'][number]

export function PeoplePanel() {
  const cc = useCc()
  const snap = cc.snapshot
  const groups = snap?.people.regions ?? []
  const [open, setOpen] = useState<Set<string>>(new Set())
  const keyOf = (g: Group) => `${g.region_id ?? 'x'}:${g.label}`
  const toggle = (k: string) =>
    setOpen((cur) => {
      const next = new Set(cur)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  const regionIgnored = cc.region && snap?.people.region_applies === false
  return (
    <section className={PANEL} data-cc-panel='people' aria-labelledby='cc-people-title'>
      <div className={PANEL_HEAD}>
        <h2 id='cc-people-title' className={TITLE}>
          People on now
        </h2>
        <span className={`text-[11px] tabular-nums ${FAINT}`}>
          {snap?.people.online_count ?? 0} online
          {snap && snap.people.idle_count > 0 ? ` · ${snap.people.idle_count} idle` : ''}
        </span>
      </div>
      <div className='space-y-1 p-2'>
        {regionIgnored && (
          <p className={`px-1 pb-1 text-[11px] ${FAINT}`}>
            People are not placed in regions here — showing everyone.
          </p>
        )}
        {groups.map((g) => {
          const k = keyOf(g)
          return <PeopleGroup key={k} group={g} expanded={open.has(k)} onToggle={() => toggle(k)} />
        })}
        {snap && groups.length === 0 && (
          <p className={`px-1 text-[12px] ${FAINT}`}>Nobody online right now.</p>
        )}
        {!snap && <p className={`px-1 text-[12px] ${FAINT}`}>Loading…</p>}
      </div>
    </section>
  )
}

function PeopleGroup({
  group: g,
  expanded,
  onToggle
}: {
  group: Group
  expanded: boolean
  onToggle: () => void
}) {
  const cc = useCc()
  const [composing, setComposing] = useState(false)
  const centroid =
    g.region_id != null
      ? cc.config?.regions.find((r) => String(r.id) === String(g.region_id))
      : null
  const focus =
    g.lat != null && g.lng != null
      ? { lat: g.lat, lng: g.lng, zoom: g.region_id != null ? 8 : 12 }
      : centroid?.lat != null && centroid.lng != null
        ? { lat: centroid.lat, lng: centroid.lng, zoom: 8 }
        : null
  const people: PersonOn[] =
    g.people ??
    g.names.map((n, i) => ({
      user_id: `${i}`,
      name: n,
      idle: false,
      page_label: null,
      record: null
    }))
  const canMessage = cc.isAdmin && !cc.kiosk && !!g.people?.length
  const listId = `cc-people-${(g.region_id ?? g.label).toString().replace(/[^A-Za-z0-9_-]/g, '_')}`
  return (
    <div className='rounded-md'>
      <div className='flex items-center gap-1'>
        <button
          type='button'
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={onToggle}
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-left hover:bg-[var(--cc-chip)]',
            FOCUS
          )}
        >
          <ChevronRight
            className={cn(
              'h-3.5 w-3.5 shrink-0 text-[var(--cc-faint)] motion-safe:transition-transform',
              expanded && 'rotate-90'
            )}
            aria-hidden='true'
          />
          <span
            className='h-2.5 w-2.5 shrink-0 rounded-full bg-[var(--cc-people)]'
            aria-hidden='true'
          />
          <span className='truncate text-[12px] font-semibold text-[var(--cc-people-text)]'>
            {g.label}
          </span>
          <span className={`text-[11px] tabular-nums ${FAINT}`}>{g.count}</span>
        </button>
        {focus && (
          <button
            type='button'
            onClick={() => cc.focusMap(focus)}
            aria-label={`Show ${g.label} on the map`}
            data-tip='Show on the map'
            className={cn(
              'rounded p-1 text-[var(--cc-faint)] hover:bg-[var(--cc-chip)] hover:text-[var(--cc-text)]',
              FOCUS
            )}
          >
            <LocateFixed className='h-3.5 w-3.5' />
          </button>
        )}
        {canMessage && (
          <button
            type='button'
            onClick={() => setComposing((v) => !v)}
            aria-label={`Message the people in ${g.label}`}
            data-tip='Message these people'
            className={cn(
              'rounded p-1 text-[var(--cc-faint)] hover:bg-[var(--cc-chip)] hover:text-[var(--cc-text)]',
              FOCUS
            )}
          >
            <MessageSquare className='h-3.5 w-3.5' />
          </button>
        )}
      </div>
      {composing && canMessage && (
        <MessageComposer
          label={g.label}
          ids={(g.people ?? []).map((p) => p.user_id).slice(0, MESSAGE_CAP)}
          total={g.count}
          onDone={() => setComposing(false)}
        />
      )}
      {expanded && (
        <ul id={listId} className='mb-1 ml-5 mt-0.5 space-y-0.5'>
          {people.map((p) => (
            <PersonRow key={p.user_id} p={p} real={!!g.people} />
          ))}
          {g.count > people.length && (
            <li className={`px-1 text-[11px] ${FAINT}`}>and {g.count - people.length} more</li>
          )}
        </ul>
      )}
    </div>
  )
}

function PersonRow({ p, real }: { p: PersonOn; real: boolean }) {
  const cc = useCc()
  const nameButton = (
    <button
      type='button'
      className={cn(
        'truncate rounded text-left text-[12px] font-medium text-[var(--cc-text)] hover:underline',
        FOCUS
      )}
      aria-label={`${p.name} — open their card`}
    >
      {p.name}
    </button>
  )
  return (
    <li className='flex items-start gap-1.5 rounded px-1 py-0.5'>
      <span
        className={cn(
          'mt-[5px] h-2 w-2 shrink-0 rounded-full',
          p.idle ? 'bg-[var(--cc-faint)]' : 'bg-[var(--cc-people)]'
        )}
        aria-hidden='true'
      />
      <div className='min-w-0 flex-1'>
        <div className='flex items-center gap-1.5'>
          {real && !cc.kiosk ? (
            <UserChip userId={p.user_id}>{nameButton}</UserChip>
          ) : (
            <span className='truncate text-[12px] font-medium'>{p.name}</span>
          )}
          <span className={`text-[10.5px] ${FAINT}`}>{p.idle ? 'idle' : 'active'}</span>
          {real && cc.isAdmin && !cc.kiosk && (
            <button
              type='button'
              onClick={() => cc.navigate(`/traffic-map?follow=${encodeURIComponent(p.user_id)}`)}
              aria-label={`Follow ${p.name} in the Traffic Map`}
              data-tip='Follow in Traffic Map'
              className={cn(
                'ml-auto rounded p-0.5 text-[var(--cc-faint)] hover:bg-[var(--cc-chip)] hover:text-[var(--cc-text)]',
                FOCUS
              )}
            >
              <Footprints className='h-3 w-3' />
            </button>
          )}
        </div>
        {(p.record || p.page_label) && (
          <p className={`truncate text-[11px] ${MUTED}`}>
            {p.record ? (
              <button
                type='button'
                onClick={() =>
                  p.record && cc.setPeek({ collection: p.record.collection, id: p.record.id })
                }
                className={cn('truncate rounded text-left hover:underline', FOCUS)}
                aria-label={`On ${p.record.label} — preview it`}
              >
                On {p.record.label}
              </button>
            ) : (
              <>On {p.page_label}</>
            )}
          </p>
        )}
      </div>
    </li>
  )
}

function MessageComposer({
  label,
  ids,
  total,
  onDone
}: {
  label: string
  ids: string[]
  total: number
  onDone: () => void
}) {
  const client = useNivaroClient()
  const [text, setText] = useState('')
  const [armed, setArmed] = useState(false)
  const send = useMutation({
    mutationFn: () =>
      client.request<{ data: { sent: number; skipped: number } }>(
        post('/command-center/people/message', { user_ids: ids, message: text.trim() })
      ),
    onSuccess: (r) => {
      const sent = r.data?.sent ?? ids.length
      toast.success(`Sent to ${sent} ${sent === 1 ? 'person' : 'people'}`)
      onDone()
    },
    onError: (err: unknown) => {
      setArmed(false)
      toastError(err, 'Message not sent')
    }
  })
  const fieldId = `cc-msg-${label.replace(/[^A-Za-z0-9_-]/g, '_')}`
  return (
    <div className='mb-1.5 ml-5 mt-1 space-y-1.5 rounded-md border border-[var(--cc-border)] p-2'>
      <label htmlFor={fieldId} className={`block text-[11px] ${FAINT}`}>
        One in-app message to each of {ids.length} {ids.length === 1 ? 'person' : 'people'} in{' '}
        {label}
        {total > ids.length ? ` (the first ${ids.length} of ${total})` : ''}
      </label>
      <textarea
        id={fieldId}
        value={text}
        maxLength={1000}
        rows={3}
        onChange={(e) => {
          setText(e.target.value)
          setArmed(false)
        }}
        className={cn(
          'w-full resize-y rounded-md border border-[var(--cc-border)] bg-[var(--cc-panel)] px-2 py-1 text-[12px] text-[var(--cc-text)]',
          FOCUS
        )}
      />
      <div className='flex items-center justify-end gap-1.5'>
        <button type='button' onClick={onDone} className={cn(BUTTON, FOCUS)}>
          Cancel
        </button>
        <button
          type='button'
          disabled={!text.trim() || send.isPending}
          onClick={() => (armed ? send.mutate() : setArmed(true))}
          className={cn(
            BUTTON,
            FOCUS,
            armed && 'border-nvr-cyan bg-nvr-cyan text-white hover:bg-nvr-cyan'
          )}
        >
          {send.isPending ? 'Sending…' : armed ? `Confirm — send to ${ids.length}` : 'Send'}
        </button>
      </div>
    </div>
  )
}
