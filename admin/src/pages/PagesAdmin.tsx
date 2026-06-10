import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  ChevronsUpDown,
  ExternalLink,
  LayoutDashboard,
  Pencil,
  Plus,
  Trash2
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PageWidget {
  id: string
  type: 'table' | 'kpi' | 'markdown' | 'iframe' | 'recent-activity'
  x: number
  y: number
  w: number
  h: number
  config: Record<string, unknown>
}

export interface PageLayout {
  columns: number
  widgets: PageWidget[]
}

export interface CmsPage {
  id: number
  name: string
  slug: string
  icon: string | null
  layout: PageLayout
  is_shared: boolean
  role: string | null
  sort: number
  created_by: string
  created_at: string
  updated_at: string
}

interface CmsRole {
  id: string
  name: string
}

interface PageForm {
  name: string
  slug: string
  icon: string
  is_shared: boolean
  role: string | null
  sort: number
}

const FORM_DEFAULTS: PageForm = {
  name: '',
  slug: '',
  icon: '',
  is_shared: true,
  role: null,
  sort: 0
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
}

// ─── Role combobox ────────────────────────────────────────────────────────────

function RoleCombobox({
  roles,
  value,
  onChange
}: {
  roles: CmsRole[]
  value: string | null
  onChange: (role: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const selected = roles.find((r) => r.id === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type='button'
          variant='outline'
          role='combobox'
          aria-expanded={open}
          className='w-full justify-between font-normal'
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected ? selected.name : 'Any role'}
          </span>
          <ChevronsUpDown className='ml-2 h-4 w-4 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[260px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search roles…' className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              No roles
            </CommandEmpty>
            <CommandGroup>
              <CommandItem
                value='__any__'
                onSelect={() => {
                  onChange(null)
                  setOpen(false)
                }}
                className='text-[12.5px]'
              >
                <Check
                  className={cn('mr-2 h-3 w-3', value == null ? 'opacity-100' : 'opacity-0')}
                />
                Any role
              </CommandItem>
              {roles.map((r) => (
                <CommandItem
                  key={r.id}
                  value={r.name}
                  onSelect={() => {
                    onChange(r.id)
                    setOpen(false)
                  }}
                  className='text-[12.5px]'
                >
                  <Check
                    className={cn('mr-2 h-3 w-3', value === r.id ? 'opacity-100' : 'opacity-0')}
                  />
                  {r.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

// ─── Meta form (create + edit) ────────────────────────────────────────────────

function PageMetaForm({
  initial,
  roles,
  saving,
  submitLabel,
  onSubmit,
  onCancel
}: {
  initial: PageForm
  roles: CmsRole[]
  saving: boolean
  submitLabel: string
  onSubmit: (form: PageForm) => void
  onCancel?: () => void
}) {
  const [form, setForm] = useState<PageForm>(initial)
  const [slugTouched, setSlugTouched] = useState(
    !!initial.slug && initial.slug !== slugify(initial.name)
  )

  useEffect(() => {
    setForm(initial)
    setSlugTouched(!!initial.slug && initial.slug !== slugify(initial.name))
  }, [initial])

  const set = <K extends keyof PageForm>(k: K, v: PageForm[K]) => setForm((p) => ({ ...p, [k]: v }))

  return (
    <div className='space-y-4'>
      <div className='grid grid-cols-2 gap-3'>
        <div className='space-y-1.5'>
          <Label htmlFor='page-name'>
            Name <span className='text-red-500'>*</span>
          </Label>
          <Input
            id='page-name'
            value={form.name}
            onChange={(e) => {
              const name = e.target.value
              setForm((p) => ({
                ...p,
                name,
                slug: slugTouched ? p.slug : slugify(name)
              }))
            }}
            placeholder='e.g. Sales Overview'
          />
        </div>
        <div className='space-y-1.5'>
          <Label htmlFor='page-slug'>
            Slug <span className='text-red-500'>*</span>
          </Label>
          <Input
            id='page-slug'
            value={form.slug}
            onChange={(e) => {
              setSlugTouched(true)
              set('slug', slugify(e.target.value))
            }}
            placeholder='sales-overview'
            className='font-mono text-[13px]'
          />
          <p className='text-[11px] text-slate-400'>
            Page URL: <code className='font-mono'>/p/{form.slug || '…'}</code>
          </p>
        </div>
      </div>

      <div className='grid grid-cols-2 gap-3'>
        <div className='space-y-1.5'>
          <Label htmlFor='page-icon'>Icon</Label>
          <Input
            id='page-icon'
            value={form.icon}
            onChange={(e) => set('icon', e.target.value)}
            placeholder='e.g. layout-dashboard'
          />
          <p className='text-[11px] text-slate-400'>Lucide icon name (optional)</p>
        </div>
        <div className='space-y-1.5'>
          <Label htmlFor='page-sort'>Sort</Label>
          <Input
            id='page-sort'
            type='number'
            value={form.sort}
            onChange={(e) => set('sort', Number(e.target.value) || 0)}
          />
        </div>
      </div>

      <div className='space-y-1.5'>
        <div className='flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50/70 px-4 py-2.5 dark:border-slate-800 dark:bg-slate-900/70'>
          <div>
            <p className='text-[13px] font-medium text-slate-800 dark:text-slate-200'>Shared</p>
            <p className='text-[11px] text-slate-400'>
              Visible to other users (otherwise only the creator and admins see it)
            </p>
          </div>
          <Switch checked={form.is_shared} onCheckedChange={(v) => set('is_shared', v)} />
        </div>
      </div>

      {form.is_shared && (
        <div className='space-y-1.5'>
          <Label>Restrict to role (optional)</Label>
          <RoleCombobox roles={roles} value={form.role} onChange={(r) => set('role', r)} />
        </div>
      )}

      <div className='flex justify-end gap-2 pt-1'>
        {onCancel && (
          <Button type='button' variant='outline' size='sm' onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button
          type='button'
          size='sm'
          disabled={!form.name.trim() || !form.slug.trim() || saving}
          onClick={() => onSubmit(form)}
        >
          {saving ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function PagesAdminPage() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const { data: pages = [], isLoading } = useQuery({
    queryKey: ['pages'],
    queryFn: () => api.get<{ data: CmsPage[] }>('/pages').then((r) => r.data.data)
  })

  const { data: roles = [] } = useQuery({
    queryKey: ['roles-for-pages'],
    queryFn: () => api.get<{ data: CmsRole[] }>('/roles').then((r) => r.data.data)
  })

  const selected = pages.find((p) => p.id === selectedId) ?? null

  const invalidate = () => qc.invalidateQueries({ queryKey: ['pages'] })

  const createMut = useMutation({
    mutationFn: (form: PageForm) =>
      api
        .post<{ data: CmsPage }>('/pages', {
          ...form,
          icon: form.icon || null,
          layout: { columns: 12, widgets: [] }
        })
        .then((r) => r.data.data),
    onSuccess: (page) => {
      invalidate()
      setCreating(false)
      setSelectedId(page.id)
      toast.success('Page created')
    },
    onError: (err: unknown) =>
      toast.error(
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
          'Failed to create page'
      )
  })

  const updateMut = useMutation({
    mutationFn: ({ id, form }: { id: number; form: PageForm }) =>
      api.patch(`/pages/${id}`, { ...form, icon: form.icon || null }),
    onSuccess: () => {
      invalidate()
      toast.success('Page saved')
    },
    onError: (err: unknown) =>
      toast.error(
        (err as { response?: { data?: { error?: string } } })?.response?.data?.error ??
          'Failed to save page'
      )
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => api.delete(`/pages/${id}`),
    onSuccess: () => {
      invalidate()
      setSelectedId(null)
      setConfirmDelete(false)
      toast.success('Page deleted')
    },
    onError: () => toast.error('Failed to delete page')
  })

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      {/* Header */}
      <header className='shrink-0 border-b border-slate-200 bg-white px-6 py-4 dark:border-slate-800 dark:bg-slate-950'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2.5'>
            <LayoutDashboard className='h-5 w-5 text-muted-foreground' />
            <div>
              <h1 className='text-lg font-semibold'>Pages</h1>
              <p className='text-[12px] text-slate-400'>
                Low-code pages built from widgets — published at /p/&lt;slug&gt;
              </p>
            </div>
          </div>
          <Button
            size='sm'
            onClick={() => {
              setCreating(true)
              setSelectedId(null)
              setConfirmDelete(false)
            }}
          >
            <Plus className='mr-1.5 h-4 w-4' />
            New Page
          </Button>
        </div>
      </header>

      <div className='flex flex-1 min-h-0 overflow-hidden'>
        {/* Left list */}
        <aside className='w-[272px] shrink-0 overflow-y-auto border-r border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950'>
          {isLoading ? (
            <div className='space-y-2 p-3'>
              {[1, 2, 3].map((k) => (
                <Skeleton key={k} className='h-12 w-full rounded-lg' />
              ))}
            </div>
          ) : pages.length === 0 ? (
            <div className='px-4 py-10 text-center text-[12px] text-slate-400'>
              No pages yet. Create your first page.
            </div>
          ) : (
            <div className='p-2'>
              {pages.map((p) => (
                <button
                  key={p.id}
                  type='button'
                  onClick={() => {
                    setSelectedId(p.id)
                    setCreating(false)
                    setConfirmDelete(false)
                  }}
                  className={cn(
                    'mb-1 flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left transition-colors',
                    selectedId === p.id
                      ? 'bg-nvr-cyan/10'
                      : 'hover:bg-slate-50 dark:hover:bg-slate-900'
                  )}
                >
                  <LayoutDashboard
                    className={cn(
                      'h-4 w-4 shrink-0',
                      selectedId === p.id ? 'text-nvr-cyan' : 'text-slate-300'
                    )}
                  />
                  <div className='min-w-0 flex-1'>
                    <div className='truncate text-[13px] font-medium text-slate-800 dark:text-slate-200'>
                      {p.name}
                    </div>
                    <div className='truncate font-mono text-[11px] text-slate-400'>/p/{p.slug}</div>
                  </div>
                  {p.is_shared && <Badge className='shrink-0 text-[10px]'>shared</Badge>}
                </button>
              ))}
            </div>
          )}
        </aside>

        {/* Right detail */}
        <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
          {creating ? (
            <div className='mx-auto max-w-2xl p-8'>
              <div className='rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-950'>
                <h2 className='mb-4 text-[13px] font-semibold text-slate-900 dark:text-slate-100'>
                  New Page
                </h2>
                <PageMetaForm
                  initial={FORM_DEFAULTS}
                  roles={roles}
                  saving={createMut.isPending}
                  submitLabel='Create Page'
                  onSubmit={(form) => createMut.mutate(form)}
                  onCancel={() => setCreating(false)}
                />
              </div>
            </div>
          ) : selected ? (
            <div className='mx-auto max-w-2xl space-y-5 p-8'>
              {/* Meta grid */}
              <div className='grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-border dark:bg-border'>
                <div className='bg-white px-4 py-3 dark:bg-card'>
                  <p className='text-[11px] text-slate-400'>Widgets</p>
                  <p className='text-[15px] font-semibold text-slate-800 dark:text-slate-200'>
                    {selected.layout?.widgets?.length ?? 0}
                  </p>
                </div>
                <div className='bg-white px-4 py-3 dark:bg-card'>
                  <p className='text-[11px] text-slate-400'>Visibility</p>
                  <p className='text-[15px] font-semibold text-slate-800 dark:text-slate-200'>
                    {selected.is_shared
                      ? selected.role
                        ? 'Role-restricted'
                        : 'Shared'
                      : 'Private'}
                  </p>
                </div>
                <div className='bg-white px-4 py-3 dark:bg-card'>
                  <p className='text-[11px] text-slate-400'>Updated</p>
                  <p className='text-[15px] font-semibold text-slate-800 dark:text-slate-200'>
                    {formatRelative(selected.updated_at)}
                  </p>
                </div>
              </div>

              {/* Actions */}
              <div className='flex items-center gap-2'>
                <Button size='sm' onClick={() => navigate(`/pages-admin/${selected.id}/edit`)}>
                  <Pencil className='mr-1.5 h-3.5 w-3.5' />
                  Open builder
                </Button>
                <Button size='sm' variant='outline' onClick={() => navigate(`/p/${selected.slug}`)}>
                  <ExternalLink className='mr-1.5 h-3.5 w-3.5' />
                  View page
                </Button>
                <div className='ml-auto'>
                  {confirmDelete ? (
                    <div className='flex items-center gap-2'>
                      <span className='text-[12px] text-slate-500'>Delete this page?</span>
                      <Button size='sm' variant='outline' onClick={() => setConfirmDelete(false)}>
                        Cancel
                      </Button>
                      <Button
                        size='sm'
                        variant='destructive'
                        disabled={deleteMut.isPending}
                        onClick={() => deleteMut.mutate(selected.id)}
                      >
                        {deleteMut.isPending ? 'Deleting…' : 'Delete'}
                      </Button>
                    </div>
                  ) : (
                    <Button
                      size='sm'
                      variant='ghost'
                      className='text-red-500 hover:text-red-600'
                      onClick={() => setConfirmDelete(true)}
                    >
                      <Trash2 className='mr-1.5 h-3.5 w-3.5' />
                      Delete
                    </Button>
                  )}
                </div>
              </div>

              {/* Meta form */}
              <div className='rounded-xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-950'>
                <h2 className='mb-4 text-[13px] font-semibold text-slate-900 dark:text-slate-100'>
                  Page Settings
                </h2>
                <PageMetaForm
                  key={selected.id}
                  initial={{
                    name: selected.name,
                    slug: selected.slug,
                    icon: selected.icon ?? '',
                    is_shared: selected.is_shared,
                    role: selected.role,
                    sort: selected.sort
                  }}
                  roles={roles}
                  saving={updateMut.isPending}
                  submitLabel='Save Settings'
                  onSubmit={(form) => updateMut.mutate({ id: selected.id, form })}
                />
              </div>
            </div>
          ) : (
            <div className='flex h-full flex-col items-center justify-center text-center'>
              <LayoutDashboard className='mb-3 h-10 w-10 text-slate-200 dark:text-slate-700' />
              <p className='mb-1 text-sm font-medium text-slate-600 dark:text-slate-300'>
                No page selected
              </p>
              <p className='text-xs text-slate-400'>
                Select a page on the left or create a new one.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
