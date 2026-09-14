import { useQuery } from '@tanstack/react-query'
import { Eye, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { SimpleSelectXs } from '../ui/SimpleSelect'

/**
 * "View as role" (#8, admin only) — renders the form exactly as a member of a
 * chosen role would see it, WITHOUT masquerading: the server's preview-as-role
 * evaluator (the same pickBestLayout + getAllowedFields the live path uses)
 * names the hidden fields, the read-only fields and the layout that role
 * resolves; the form hides / locks accordingly, pins the layout by slug when
 * it has one, and asks the pipeline for that role's transitions. Nothing is
 * written as the role — Save stays disabled while previewing.
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

export function useViewAsRole(collection: string, enabled: boolean) {
  const client = useNivaroClient()
  const [roleId, setRoleId] = useState<string | null>(null)
  const { data: roles } = useQuery<Array<{ id: string; name: string }>>({
    queryKey: ['nvr-roles-lite'],
    queryFn: () =>
      client
        .request<{ data: Array<{ id: string; name: string }> }>(get('/roles'))
        .then((r) => (r.data ?? []).map((x) => ({ id: String(x.id), name: String(x.name) }))),
    enabled,
    staleTime: 5 * 60_000
  })
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
    roleId,
    setRoleId,
    roles: roles ?? [],
    preview: roleId ? (preview ?? null) : null,
    loading: !!roleId && isFetching && !preview,
    hidden,
    readonly,
    active: !!roleId
  }
}

export function ViewAsRoleBar({
  roles,
  roleId,
  onChange,
  preview,
  loading
}: {
  roles: Array<{ id: string; name: string }>
  roleId: string | null
  onChange: (id: string | null) => void
  preview: RolePreview | null
  loading: boolean
}) {
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
  return (
    <div
      data-view-as-role
      className='mb-2 flex flex-wrap items-center gap-2 rounded-md border border-violet-300 bg-violet-50 px-3 py-1.5 text-[12px] text-violet-900 dark:border-violet-500/40 dark:bg-violet-500/10 dark:text-violet-100'
    >
      <Eye className='h-3.5 w-3.5 shrink-0 text-violet-600 dark:text-violet-300' />
      <span className='font-semibold'>Viewing as</span>
      <SimpleSelectXs
        value={roleId ?? ''}
        onChange={(v) => onChange(v || null)}
        ariaLabel='Role to preview'
        options={[
          { value: '', label: 'Pick a role…' },
          ...roles.map((r) => ({ value: r.id, label: r.name }))
        ]}
      />
      <span className='min-w-0 flex-1 truncate text-violet-800/80 dark:text-violet-200/80'>
        {loading
          ? 'Resolving what this role sees…'
          : facts.length
            ? facts.join(' · ')
            : roleId
              ? 'Same as you — no differences'
              : 'Nothing is saved as the role; Save is disabled while previewing.'}
        {preview?.note ? ` ${preview.note}` : ''}
      </span>
      <button
        type='button'
        onClick={() => onChange(null)}
        aria-label='Stop previewing'
        className='shrink-0 rounded p-0.5 text-violet-500 hover:bg-violet-100 hover:text-violet-900 dark:hover:bg-violet-500/20'
      >
        <X className='h-3.5 w-3.5' />
      </button>
    </div>
  )
}
