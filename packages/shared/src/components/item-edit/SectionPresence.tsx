import { useMemo } from 'react'
import {
  type CoViewer,
  sectionPresence,
  sectionPresenceText,
  useFieldEditors
} from '../../lib/co-edit'
import { cursorColor } from '../../lib/grid-cursors'
import type { CMSField, CMSRelation } from './types'

export function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .map((p) => p[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || '?'
  )
}

/** One small avatar ringed in the person's cursor colour (the same colour as their grid cell). */
export function CoViewerAvatar({ person, size = 18 }: { person: CoViewer; size?: number }) {
  return (
    <span
      className='inline-flex shrink-0 items-center justify-center rounded-full border-[1.5px] bg-slate-100 font-semibold text-slate-700 ring-2 ring-white dark:bg-slate-700 dark:text-slate-100 dark:ring-card'
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.45),
        borderColor: cursorColor(person.id)
      }}
      aria-hidden
    >
      {initialsOf(person.name)}
    </span>
  )
}

/**
 * Realtime round 7 #3 — "Beth is in Shipping": on a FOLDED section's header, small avatars of
 * the co-viewers whose focus is inside it (a field, or a row / cell of one of its line grids).
 * Only the section's fields on THIS viewer's form count, so a field the viewer may not read
 * never shows anyone. Calm/Off: nothing (useFieldEditors is empty there).
 */
export function SectionPresence({
  collection,
  itemId,
  fields,
  relations,
  label
}: {
  collection: string
  itemId: string
  fields: CMSField[]
  relations: CMSRelation[]
  label: string
}) {
  const editing = useFieldEditors(collection, itemId)
  const has = Object.keys(editing).length > 0
  const people = useMemo(() => {
    if (!has) return []
    const names = new Set(fields.map((f) => f.field))
    const lines = new Set(
      relations
        .filter(
          (r) =>
            r.one_collection === collection &&
            !!r.one_field &&
            names.has(r.one_field) &&
            !!r.many_collection
        )
        .map((r) => String(r.many_collection))
    )
    return sectionPresence(editing, names, lines)
  }, [has, editing, fields, relations, collection])
  const text = sectionPresenceText(people, label)
  if (!text) return null
  const shown = people.slice(0, 3)
  return (
    <span
      data-section-presence=''
      data-tip={text}
      role='img'
      aria-label={text}
      className='nvr-fade-in inline-flex shrink-0 items-center gap-1.5'
    >
      <span className='flex items-center pl-1' aria-hidden>
        {shown.map((p, i) => (
          // Each later face sits ON TOP of the one before, overlapping only 4 px of its 20 —
          // the 2 px surface-coloured ring cuts it out, so every pair of initials stays whole.
          <span
            key={p.id}
            className={i > 0 ? '-ml-1 flex' : 'flex'}
            style={{ zIndex: i + 1, position: 'relative' }}
          >
            <CoViewerAvatar person={p} size={20} />
          </span>
        ))}
        {people.length > shown.length && (
          <span
            style={{ zIndex: shown.length + 1 }}
            className='relative -ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-slate-100 px-1 text-[9px] font-semibold text-slate-600 ring-2 ring-white dark:bg-slate-700 dark:text-slate-200 dark:ring-card'
          >
            +{people.length - shown.length}
          </span>
        )}
      </span>
      <span aria-hidden className='hidden text-[11px] text-slate-500 sm:inline dark:text-slate-400'>
        {people.length === 1
          ? `${people[0].name} is here`
          : people.length === 2
            ? `${people[0].name.split(' ')[0]} and ${people[1].name.split(' ')[0]} are here`
            : `${people.length} people here`}
      </span>
    </span>
  )
}
