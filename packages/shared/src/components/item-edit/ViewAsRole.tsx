import { useQuery } from '@tanstack/react-query'
import { Eye, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { AsyncUserPicker } from '../panels/AsyncUserPicker'
import { SimpleSelectXs } from '../ui/SimpleSelect'
import { ViewAsPersonButton } from '../ViewAsPersonButton'

/**
 * "View as role" (#8, admin only) — renders the form exactly as a member of a
 * chosen role would see it, WITHOUT masquerading: the server's preview-as-role
 * evaluator (the same pickBestLayout + getAllowedFields the live path uses)
 * names the hidden fields, the read-only fields and the layout that role
 * resolves; the form hides / locks accordingly, pins the layout by slug when
 * it has one, and asks the pipeline for that role's transitions. Nothing is
 * written as the role — Save stays disabled while previewing.
 *
 * "View as person" (Rob 2026-11-13): a role cannot own a step, so owner-only
 * moves need a person. Picking one previews the form as their role AND asks
 * the pipeline `?as_user=` — their buttons, their blocked moves with the
 * reason ("Only the owner of Warehouse Submission can make this move"), their
 * edit lock. Still a preview: nothing is saved or moved from it.
 */
export interface RolePreview {
  role: { id: string; name: string; admin_access: boolean }
  can_read: boolean
  can_update: boolean
  layout: { id: number; name: string; is_active: boolean; slug?: string | null } | null
  hidden_fields: string[]
  readonly_fields: string[]
  record_conditional_layouts: string[]
  note: string | null
}

export interface PreviewPersonRow {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  role: string | null
}

export function personName(p: PreviewPersonRow | null | undefined): string {
  if (!p) return ''
  return [p.first_name, p.last_name].filter(Boolean).join(' ').trim() || p.email || 'This person'
}

export function useViewAsRole(collection: string, enabled: boolean) {
  const client = useNivaroClient()
  const [pickedRoleId, setPickedRoleId] = useState<string | null>(null)
  const [personId, setPersonIdState] = useState<string | null>(null)
  const { data: roles } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['nvr-roles-lite'],
    queryFn: () =>
      client
        .request<{ data: Array<{ id: string; name: string }> }>(get('/roles'))
        .then((r) => (r.data ?? []).map((x) => ({ id: String(x.id), name: String(x.name) }))),
    enabled,
    staleTime: 5 * 60_000
  })
  // The person's own row (admin read): their role drives the form preview.
  const { data: person, isFetching: personLoading } = useQuery<PreviewPersonRow | null>({
    queryKey: ['nvr-view-as-person', personId],
    queryFn: () =>
      client
        .request<{ data: Record<string, unknown> | null }>(
          get(`/users/${encodeURIComponent(personId ?? '')}`)
        )
        .then((r) => {
          const d = r.data
          if (!d) return null
          const role = d.role as unknown
          return {
            id: String(d.id),
            first_name: (d.first_name as string | null) ?? null,
            last_name: (d.last_name as string | null) ?? null,
            email: (d.email as string | null) ?? null,
            role:
              role && typeof role === 'object'
                ? String((role as { id?: unknown }).id ?? '') || null
                : role
                  ? String(role)
                  : null
          }
        }),
    enabled: enabled && !!personId,
    staleTime: 60_000
  })
  // A person preview evaluates the form as their role; a role preview as the picked role.
  const roleId = personId ? (person?.role ?? null) : pickedRoleId
  const { data: preview, isFetching } = useQuery<RolePreview | null>({
    queryKey: ['nvr-role-preview', collection, roleId],
    queryFn: () =>
      client
        .request<{ data: RolePreview }>(
          get(
            `/collection-layouts/preview-as-role?collection=${encodeURIComponent(collection)}&role_id=${encodeURIComponent(roleId ?? '')}`
          )
        )
        .then((r) => r.data ?? null),
    enabled: enabled && !!roleId,
    staleTime: 60_000
  })
  const hidden = useMemo(() => new Set(preview?.hidden_fields ?? []), [preview])
  const readonly = useMemo(() => new Set(preview?.readonly_fields ?? []), [preview])
  return {
    /** The role the form is previewed as (the person's role in person mode). */
    roleId,
    setRoleId: (id: string | null) => {
      setPersonIdState(null)
      setPickedRoleId(id)
    },
    /** The person the pipeline is judged as (`?as_user=`), null in role mode. */
    personId,
    setPersonId: (id: string | null) => {
      setPickedRoleId(null)
      setPersonIdState(id)
    },
    person: personId ? (person ?? null) : null,
    roles: roles ?? [],
    preview: roleId ? (preview ?? null) : null,
    loading: (!!personId && personLoading && !person) || (!!roleId && isFetching && !preview),
    hidden,
    readonly,
    active: !!roleId || !!personId
  }
}

type Mode = 'role' | 'person'

export function ViewAsRoleBar({
  roles,
  roleId,
  onChange,
  preview,
  loading,
  personId,
  person,
  onPersonChange
}: {
  roles: Array<{ id: string; name: string }>
  roleId: string | null
  onChange: (id: string | null) => void
  preview: RolePreview | null
  loading: boolean
  /** Person mode (optional: a host without it gets the role picker only). */
  personId?: string | null
  person?: PreviewPersonRow | null
  onPersonChange?: (id: string | null) => void
}) {
  const [mode, setMode] = useState<Mode>(personId ? 'person' : 'role')
  const facts: string[] = []
  if (preview) {
    if (!preview.can_read) facts.push('cannot open this collection at all')
    else {
      if (preview.hidden_fields.length)
        facts.push(
          `${preview.hidden_fields.length} field${preview.hidden_fields.length === 1 ? '' : 's'} hidden`
        )
      if (preview.readonly_fields.length) facts.push(`${preview.readonly_fields.length} read-only`)
      if (!preview.can_update) facts.push('no edit permission')
      if (preview.layout) facts.push(`layout “${preview.layout.name}”`)
    }
  }
  const name = personName(person)
  // Closes the bar (the host closes it on a cleared role); clears the person too.
  const stop = () => onChange(null)
  const idle =
    mode === 'person'
      ? 'Pick a person: their moves and owner checks are judged as them. Nothing is saved or moved.'
      : 'Nothing is saved as the role; Save is disabled while previewing.'
  const summary = `${
    loading
      ? mode === 'person'
        ? `Resolving what ${name || 'this person'} sees…`
        : 'Resolving what this role sees…'
      : mode === 'person' && person
        ? [`Moves and owner checks judged as ${name}`, ...(person.role ? facts : ['no role'])].join(
            ' · '
          )
        : facts.length
          ? facts.join(' · ')
          : roleId
            ? 'Same as you — no differences'
            : idle
  }${preview?.note ? ` ${preview.note}` : ''}`
  return (
    <div
      data-view-as-role
      data-view-as-mode={mode}
      className='mb-2 flex flex-wrap items-center gap-2 rounded-md border border-violet-300 bg-violet-50 px-3 py-1.5 text-[12px] text-violet-900 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-100'
    >
      <Eye className='h-3.5 w-3.5 shrink-0 text-violet-600 dark:text-violet-300' />
      <span className='font-semibold'>Viewing as</span>
      {onPersonChange && (
        <fieldset
          aria-label='Preview as'
          className='m-0 flex min-w-0 shrink-0 overflow-hidden rounded border border-violet-300 p-0 dark:border-violet-500/40'
        >
          {(['role', 'person'] as const).map((m) => (
            <button
              key={m}
              type='button'
              aria-pressed={mode === m}
              data-view-as-mode-pick={m}
              onClick={() => {
                if (mode === m) return
                setMode(m)
                // Clears the role and the person without closing the bar.
                onPersonChange?.(null)
              }}
              className={cn(
                'h-6 px-2 text-[11px] font-medium transition-colors',
                mode === m
                  ? 'bg-violet-600 text-white dark:bg-violet-500'
                  : 'text-violet-800 hover:bg-violet-100 dark:text-violet-200 dark:hover:bg-violet-500/20'
              )}
            >
              {m === 'role' ? 'Role' : 'Person'}
            </button>
          ))}
        </fieldset>
      )}
      {mode === 'person' && onPersonChange ? (
        <div className='w-56 shrink-0' data-view-as-person-picker>
          <AsyncUserPicker value={personId ?? ''} onChange={(v) => onPersonChange(v || null)} />
        </div>
      ) : (
        <SimpleSelectXs
          value={roleId ?? ''}
          onChange={(v) => onChange(v || null)}
          ariaLabel='Role to preview'
          options={[
            { value: '', label: 'Pick a role…' },
            ...roles.map((r) => ({ value: r.id, label: r.name }))
          ]}
        />
      )}
      <span
        className='min-w-0 flex-1 truncate text-violet-800/80 dark:text-violet-200/80'
        data-tip={summary}
      >
        {summary}
      </span>
      {mode === 'person' && person && (
        <ViewAsPersonButton
          variant='text'
          person={{ id: person.id, name, firstName: person.first_name }}
        />
      )}
      <button
        type='button'
        onClick={stop}
        aria-label='Stop previewing'
        className='shrink-0 rounded p-0.5 text-violet-500 hover:bg-violet-100 hover:text-violet-900 dark:hover:bg-violet-500/20'
      >
        <X className='h-3.5 w-3.5' />
      </button>
    </div>
  )
}
