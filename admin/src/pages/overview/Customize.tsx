import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { overviewKeys } from './api'
import {
  layoutOf,
  moveSection,
  type ResolvedSection,
  resolveSections,
  type StoredLayout,
  setVisible
} from './layout'
import { availableSectionKeys } from './registry'
import { SECTION_META } from './sections-meta'

/**
 * Customize — reorder and hide the Overview's sections (buttons and switches, all keyboard
 * reachable; no drag needed). Administrators can also set the starting layout per role, which
 * everyone in that role sees until they customise their own.
 */

function SectionOrderEditor({
  sections,
  onChange
}: {
  sections: ResolvedSection[]
  onChange: (next: ResolvedSection[]) => void
}) {
  const columns: Array<{ key: 'main' | 'side'; label: string }> = [
    { key: 'main', label: 'Main column' },
    { key: 'side', label: 'Side column' }
  ]
  return (
    <div className='grid gap-4 md:grid-cols-2'>
      {columns.map((col) => {
        const list = sections.filter((s) => s.column === col.key)
        if (list.length === 0) return null
        return (
          <div key={col.key}>
            <p className='mb-1.5 text-[12px] font-medium text-slate-600 dark:text-slate-300'>
              {col.label}
            </p>
            <ol className='divide-y divide-slate-100 rounded-md border border-slate-200 bg-white dark:divide-border dark:border-border dark:bg-card'>
              {list.map((s, i) => (
                <li key={s.key} className='flex items-center gap-2 px-2.5 py-2'>
                  <div className='min-w-0 flex-1'>
                    <p
                      className={cn(
                        'truncate text-[12.5px] font-medium',
                        s.visible
                          ? 'text-slate-800 dark:text-slate-100'
                          : 'text-slate-500 dark:text-slate-400'
                      )}
                    >
                      {s.meta.title}
                    </p>
                    <p className='truncate text-[11px] text-slate-500 dark:text-slate-400'>
                      {s.meta.hint}
                    </p>
                  </div>
                  <button
                    type='button'
                    disabled={i === 0}
                    onClick={() => onChange(moveSection(sections, s.key, -1))}
                    aria-label={`Move ${s.meta.title} up`}
                    className='rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 disabled:opacity-30 dark:hover:bg-white/[0.06] dark:hover:text-white'
                  >
                    <ArrowUp className='h-3.5 w-3.5' aria-hidden />
                  </button>
                  <button
                    type='button'
                    disabled={i === list.length - 1}
                    onClick={() => onChange(moveSection(sections, s.key, 1))}
                    aria-label={`Move ${s.meta.title} down`}
                    className='rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan/60 disabled:opacity-30 dark:hover:bg-white/[0.06] dark:hover:text-white'
                  >
                    <ArrowDown className='h-3.5 w-3.5' aria-hidden />
                  </button>
                  <Switch
                    checked={s.visible}
                    onCheckedChange={(v) => onChange(setVisible(sections, s.key, v))}
                    aria-label={`Show ${s.meta.title}`}
                  />
                </li>
              ))}
            </ol>
          </div>
        )
      })}
    </div>
  )
}

export function CustomizePanel({
  sections,
  onChange,
  onDone,
  onReset,
  canReset,
  hasRoleDefault,
  isAdmin
}: {
  sections: ResolvedSection[]
  onChange: (next: ResolvedSection[]) => void
  onDone: () => void
  onReset: () => void
  canReset: boolean
  hasRoleDefault: boolean
  isAdmin: boolean
}) {
  const [rolesOpen, setRolesOpen] = useState(false)
  return (
    <section
      aria-label='Customize your Overview'
      className='border-b border-slate-200 bg-slate-50 px-4 py-4 duration-200 animate-in fade-in sm:px-6 lg:px-8 dark:border-border dark:bg-background'
    >
      <div className='mb-3 flex flex-wrap items-center justify-between gap-2'>
        <p className='text-[12.5px] text-slate-600 dark:text-slate-300'>
          Order and show the sections you want. Changes save as you make them.
        </p>
        <div className='flex flex-wrap items-center gap-2'>
          {isAdmin && (
            <Button
              size='sm'
              variant='ghost'
              className='h-7 text-[12px]'
              onClick={() => setRolesOpen(true)}
            >
              Role starter layouts
            </Button>
          )}
          <Button
            size='sm'
            variant='ghost'
            className='h-7 text-[12px]'
            disabled={!canReset}
            onClick={onReset}
          >
            {hasRoleDefault ? 'Reset to my role’s default' : 'Reset to the default'}
          </Button>
          <Button size='sm' className='h-7 bg-nvr-cyan text-[12px] text-white' onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
      <SectionOrderEditor sections={sections} onChange={onChange} />
      {isAdmin && <RoleStartersSheet open={rolesOpen} onOpenChange={setRolesOpen} />}
    </section>
  )
}

interface RoleRow {
  id: string
  name: string
}

function RoleStartersSheet({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const qc = useQueryClient()
  const roles = useQuery({
    queryKey: ['overview', 'roles-list'],
    queryFn: () => api.get<{ data: RoleRow[] }>('/roles').then((r) => r.data.data),
    enabled: open,
    staleTime: 60_000
  })
  const defaults = useQuery({
    queryKey: overviewKeys.roleDefaults,
    queryFn: () =>
      api
        .get<{ data: Record<string, StoredLayout> }>('/overview/role-defaults')
        .then((r) => r.data.data),
    enabled: open
  })
  const [roleId, setRoleId] = useState('')
  const [draft, setDraft] = useState<ResolvedSection[] | null>(null)
  const available = useMemo(() => availableSectionKeys(), [])

  useEffect(() => {
    if (!roleId) {
      setDraft(null)
      return
    }
    const stored = defaults.data?.[roleId.toUpperCase()] ?? null
    setDraft(resolveSections({ meta: SECTION_META, roleDefault: stored, isAdmin: true, available }))
  }, [roleId, defaults.data, available])

  const save = useMutation({
    mutationFn: (map: Record<string, StoredLayout>) =>
      api.put('/overview/role-defaults', { defaults: map }).then((r) => r.data.data),
    onSuccess: (data) => {
      qc.setQueryData(overviewKeys.roleDefaults, data)
      void qc.invalidateQueries({ queryKey: overviewKeys.prefs })
      toast.success('Role starter layout saved')
    },
    onError: (e: unknown) =>
      toast.error(
        (e as { response?: { data?: { error?: string } } })?.response?.data?.error ??
          'Could not save the role layout'
      )
  })

  const map = defaults.data ?? {}
  const key = roleId.toUpperCase()
  const persist = (layout: StoredLayout | null) => {
    const next = { ...map }
    if (layout) next[key] = layout
    else delete next[key]
    save.mutate(next)
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side='right' className='flex w-full flex-col sm:max-w-xl'>
        <SheetHeader>
          <SheetTitle>Role starter layouts</SheetTitle>
          <p className='text-[12.5px] text-slate-600 dark:text-slate-300'>
            The Overview a role’s people start from. Anyone who customises their own keeps theirs
            and can reset back to this.
          </p>
        </SheetHeader>
        <div className='mt-4 flex-1 space-y-4 overflow-y-auto'>
          <SimpleSelect
            ariaLabel='Role'
            value={roleId}
            onChange={setRoleId}
            className='h-8 text-[12.5px]'
            options={[
              { value: '', label: roles.isLoading ? 'Loading roles…' : 'Choose a role' },
              ...(roles.data ?? []).map((r) => ({
                value: String(r.id),
                label: `${r.name}${map[String(r.id).toUpperCase()] ? ' (customised)' : ''}`
              }))
            ]}
          />
          {draft ? (
            <SectionOrderEditor sections={draft} onChange={setDraft} />
          ) : (
            <p className='text-[12.5px] text-slate-600 dark:text-slate-300'>
              Choose a role to set the sections its people see first.
            </p>
          )}
        </div>
        <SheetFooter className='mt-4 gap-2'>
          <Button
            variant='ghost'
            size='sm'
            disabled={!roleId || !map[key] || save.isPending}
            onClick={() => persist(null)}
          >
            Back to the built-in default
          </Button>
          <Button
            size='sm'
            className='bg-nvr-cyan text-white'
            disabled={!draft || save.isPending}
            onClick={() => draft && persist(layoutOf(draft))}
          >
            Save for this role
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  )
}
