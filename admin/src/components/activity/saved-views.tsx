import { CronBuilder, describeCron } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bookmark, Check, ChevronsUpDown, Mail, Users, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator
} from '@/components/ui/command'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { UserCombobox } from '@/components/user-combobox'
import { api } from '@/lib/api'
import { cn, formatRelative } from '@/lib/utils'
import { type ActivityFilters, cleanFilters, sameFilters } from './activity-search'

/**
 * #11 — saved audit views on the Activity page: pick one to apply its filters, save the current
 * filters as a view (personal, or shared with every administrator), and email it on a schedule
 * (CSV + summary, sent per recipient — non-admins only ever get their own trail). Backed by
 * /api/activity-views (migration 517).
 */

export interface ActivityView {
  id: number
  name: string
  owner: string | null
  filters: ActivityFilters
  shared: boolean
  schedule: string | null
  recipients: string[]
  last_sent_at: string | null
  last_send_status: string | null
  editable?: boolean
  system?: boolean
}

const VIEWS_KEY = ['activity-views'] as const

export function useActivityViews() {
  return useQuery<ActivityView[]>({
    queryKey: VIEWS_KEY,
    queryFn: () => api.get('/activity-views').then((r) => r.data.data as ActivityView[]),
    staleTime: 30_000
  })
}

function errText(err: unknown): string {
  const e = err as { response?: { data?: { error?: string } }; message?: string }
  return e?.response?.data?.error ?? e?.message ?? 'Something went wrong'
}

export function SavedViewsMenu({
  filters,
  activeId,
  onApply
}: {
  filters: ActivityFilters
  activeId: number | null
  onApply: (view: ActivityView | null) => void
}) {
  const qc = useQueryClient()
  const { data: views = [] } = useActivityViews()
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<ActivityView | 'new' | null>(null)
  const active = views.find((v) => v.id === activeId) ?? null
  const changed = !!active && !sameFilters(active.filters, filters)

  const updateFilters = useMutation({
    mutationFn: (v: ActivityView) =>
      api.patch(`/activity-views/${v.id}`, { filters: cleanFilters(filters) }),
    onSuccess: () => {
      toast.success('View updated')
      void qc.invalidateQueries({ queryKey: VIEWS_KEY })
    },
    onError: (e) => toast.error(errText(e))
  })
  const remove = useMutation({
    mutationFn: (v: ActivityView) => api.delete(`/activity-views/${v.id}`),
    onSuccess: () => {
      toast.success('View removed')
      onApply(null)
      void qc.invalidateQueries({ queryKey: VIEWS_KEY })
    },
    onError: (e) => toast.error(errText(e))
  })
  const sendNow = useMutation({
    mutationFn: (v: ActivityView) =>
      api
        .post(`/activity-views/${v.id}/run`)
        .then((r) => r.data.data as { sent: number; skipped: Array<{ reason: string }> }),
    onSuccess: (r) => {
      toast.success(
        `Sent to ${r.sent}${r.skipped.length ? ` · skipped ${r.skipped.length} (${[...new Set(r.skipped.map((s) => s.reason))].join(', ')})` : ''}`
      )
      void qc.invalidateQueries({ queryKey: VIEWS_KEY })
    },
    onError: (e) => toast.error(errText(e))
  })

  const mine = views.filter((v) => !v.shared && !v.system)
  const shared = views.filter((v) => v.shared || v.system)

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant='outline'
            size='sm'
            className='h-8 max-w-[220px] gap-1.5 text-[12px]'
            data-activity-views
          >
            <Bookmark className='h-3.5 w-3.5 shrink-0' />
            <span className='truncate'>{active ? active.name : 'Saved views'}</span>
            {changed && <span className='h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500' />}
            <ChevronsUpDown className='h-3 w-3 shrink-0 opacity-50' />
          </Button>
        </PopoverTrigger>
        <PopoverContent align='end' className='w-80 p-0'>
          <Command>
            <CommandInput placeholder='Find a view…' className='text-[12px]' />
            <CommandList>
              <CommandEmpty>No saved views yet.</CommandEmpty>
              {[
                ['Mine', mine],
                ['Shared with admins', shared]
              ].map(([label, list]) =>
                (list as ActivityView[]).length ? (
                  <CommandGroup key={label as string} heading={label as string}>
                    {(list as ActivityView[]).map((v) => (
                      <CommandItem
                        key={v.id}
                        value={`${v.name} ${v.id}`}
                        onSelect={() => {
                          onApply(v)
                          setOpen(false)
                        }}
                        className='text-[12px]'
                      >
                        <Check
                          className={cn(
                            'h-3.5 w-3.5',
                            v.id === activeId ? 'opacity-100' : 'opacity-0'
                          )}
                        />
                        <span className='min-w-0 flex-1 truncate'>{v.name}</span>
                        {v.schedule && (
                          <Mail
                            className='h-3 w-3 text-slate-400'
                            aria-label={`Emailed ${describeCron(v.schedule)}`}
                          />
                        )}
                        {v.shared && (
                          <Users className='h-3 w-3 text-slate-400' aria-label='Shared' />
                        )}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ) : null
              )}
              <CommandSeparator />
              <CommandGroup>
                <CommandItem
                  className='text-[12px]'
                  onSelect={() => {
                    setEditing('new')
                    setOpen(false)
                  }}
                >
                  Save current filters as a view…
                </CommandItem>
                {active?.editable && changed && (
                  <CommandItem
                    className='text-[12px]'
                    onSelect={() => {
                      updateFilters.mutate(active)
                      setOpen(false)
                    }}
                  >
                    Update “{active.name}” with these filters
                  </CommandItem>
                )}
                {active?.editable && (
                  <CommandItem
                    className='text-[12px]'
                    onSelect={() => {
                      setEditing(active)
                      setOpen(false)
                    }}
                  >
                    Sharing and email…
                  </CommandItem>
                )}
                {active?.editable && active.recipients.length > 0 && (
                  <CommandItem
                    className='text-[12px]'
                    onSelect={() => {
                      sendNow.mutate(active)
                      setOpen(false)
                    }}
                  >
                    Email it now
                  </CommandItem>
                )}
                {active?.editable && (
                  <CommandItem
                    className='text-[12px] text-red-600 dark:text-red-400'
                    onSelect={() => {
                      if (window.confirm(`Remove the view “${active.name}”?`)) remove.mutate(active)
                      setOpen(false)
                    }}
                  >
                    Remove view
                  </CommandItem>
                )}
                {active && (
                  <CommandItem
                    className='text-[12px]'
                    onSelect={() => {
                      onApply(null)
                      setOpen(false)
                    }}
                  >
                    Close view
                  </CommandItem>
                )}
              </CommandGroup>
            </CommandList>
          </Command>
          {active?.last_sent_at && (
            <p className='border-t px-3 py-2 text-[11px] text-slate-500 dark:border-border dark:text-slate-400'>
              Last emailed {formatRelative(active.last_sent_at)}
              {active.last_send_status ? ` — ${active.last_send_status}` : ''}
            </p>
          )}
        </PopoverContent>
      </Popover>
      {editing && (
        <SaveViewDialog
          view={editing === 'new' ? null : editing}
          filters={filters}
          onClose={() => setEditing(null)}
          onSaved={(v) => {
            setEditing(null)
            onApply(v)
            void qc.invalidateQueries({ queryKey: VIEWS_KEY })
          }}
        />
      )}
    </>
  )
}

function RecipientName({ id }: { id: string }) {
  const { data } = useQuery({
    queryKey: ['activity-view-recipient', id],
    queryFn: () =>
      api.get(`/users/${id}`, { params: { fields: 'id,first_name,last_name,email' } }).then((r) => {
        const u = r.data.data as { first_name?: string; last_name?: string; email?: string }
        return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || id
      }),
    staleTime: 300_000,
    retry: false
  })
  return <>{data ?? id.slice(0, 8)}</>
}

export function SaveViewDialog({
  view,
  filters,
  onClose,
  onSaved
}: {
  /** null = save the current filters as a new view. */
  view: ActivityView | null
  filters: ActivityFilters
  onClose: () => void
  onSaved: (v: ActivityView) => void
}) {
  const [name, setName] = useState(view?.name ?? '')
  const [shared, setShared] = useState(view?.shared ?? false)
  const [emailOn, setEmailOn] = useState(!!view?.schedule)
  const [schedule, setSchedule] = useState(view?.schedule ?? '0 8 * * 1')
  const [recipients, setRecipients] = useState<string[]>(view?.recipients ?? [])
  useEffect(() => {
    if (view) setRecipients(view.recipients)
  }, [view])

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: name.trim(),
        shared,
        schedule: emailOn ? schedule : null,
        recipients: emailOn ? recipients : [],
        ...(view ? {} : { filters: cleanFilters(filters) })
      }
      const r = view
        ? await api.patch(`/activity-views/${view.id}`, body)
        : await api.post('/activity-views', body)
      return r.data.data as ActivityView
    },
    onSuccess: (v) => {
      toast.success(view ? 'View saved' : 'View created')
      onSaved(v)
    },
    onError: (e) => toast.error(errText(e))
  })

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-lg'>
        <DialogHeader>
          <DialogTitle>{view ? 'Sharing and email' : 'Save as a view'}</DialogTitle>
          <DialogDescription>
            {view
              ? 'Who sees this view, and whether it is emailed on a schedule.'
              : 'Keeps the current filters under a name you can come back to.'}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className='space-y-4'>
          <div className='space-y-1.5'>
            <Label htmlFor='activity-view-name'>Name</Label>
            <Input
              id='activity-view-name'
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              placeholder='e.g. Invoice deletes this week'
              className='h-8 text-[13px]'
            />
          </div>
          <label htmlFor='activity-view-shared' className='flex items-start gap-3'>
            <Switch
              id='activity-view-shared'
              checked={shared}
              onCheckedChange={setShared}
              className='mt-0.5'
            />
            <span>
              <span className='block text-[13px] font-medium'>Share with all administrators</span>
              <span className='block text-[12px] text-slate-500 dark:text-slate-400'>
                They can open it; only you can change it.
              </span>
            </span>
          </label>
          <label htmlFor='activity-view-email' className='flex items-start gap-3'>
            <Switch
              id='activity-view-email'
              checked={emailOn}
              onCheckedChange={setEmailOn}
              className='mt-0.5'
            />
            <span>
              <span className='block text-[13px] font-medium'>Email it on a schedule</span>
              <span className='block text-[12px] text-slate-500 dark:text-slate-400'>
                A short summary with the matching entries as CSV. Each person gets it only if they
                may read the audit log (administrators, or their own trail).
              </span>
            </span>
          </label>
          {emailOn && (
            <div className='space-y-3 rounded-md border border-slate-200 p-3 dark:border-border'>
              <CronBuilder value={schedule} onChange={setSchedule} />
              <div className='space-y-1.5'>
                <Label>Recipients</Label>
                <div className='flex flex-wrap gap-1.5'>
                  {recipients.map((id) => (
                    <span
                      key={id}
                      className='inline-flex h-6 items-center gap-1 rounded-full border border-slate-200 bg-slate-50 pl-2 pr-1 text-[11.5px] dark:border-border dark:bg-muted/40'
                    >
                      <RecipientName id={id} />
                      <button
                        type='button'
                        aria-label='Remove recipient'
                        onClick={() => setRecipients((r) => r.filter((x) => x !== id))}
                        className='rounded-full p-0.5 hover:bg-muted'
                      >
                        <X className='h-3 w-3' />
                      </button>
                    </span>
                  ))}
                </div>
                <UserCombobox
                  value={null}
                  onChange={(id) => {
                    if (id) setRecipients((r) => (r.includes(id) ? r : [...r, id]))
                  }}
                  searchServer
                  hideNone
                  placeholder='Add a person…'
                  className='h-8 w-full text-[12px]'
                />
              </div>
            </div>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant='outline' size='sm' onClick={onClose}>
            Cancel
          </Button>
          <Button
            size='sm'
            className='bg-nvr-cyan text-white'
            disabled={!name.trim() || save.isPending || (emailOn && recipients.length === 0)}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
