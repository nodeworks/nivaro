import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, Sparkles } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { api, type Role } from '@/lib/api'

/**
 * Settings → AI Features → "Let AI do this" (#2866): whether the person a
 * task or a support ticket is assigned to may ask AI to do it, which roles
 * and request types, how many records a plan may change before a second
 * person must approve it, and a per-person daily cap. Off for both until an
 * administrator opts in. Saved on its own (PATCH /ai/task-do/settings) — the
 * block lives under the reserved `_task_do` key of ai_models, apart from the
 * model ids the section's Save button writes.
 */

interface TaskDoSettings {
  tasks_enabled: boolean
  tickets_enabled: boolean
  allowed_roles: string[]
  ticket_categories: number[]
  approval_threshold: number
  daily_cap: number
}

interface Category {
  id: number
  name: string
  is_active: boolean
}

function Row({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: (id: string) => React.ReactNode
}) {
  const id = useId()
  return (
    <div className='space-y-1.5'>
      <Label htmlFor={id} className='text-[12px] font-medium text-slate-700 dark:text-foreground'>
        {label}
      </Label>
      {children(id)}
      {hint && (
        <p className='max-w-[64ch] text-[11px] text-slate-500 dark:text-muted-foreground'>{hint}</p>
      )}
    </div>
  )
}

export function TaskDoSettingsBlock() {
  const qc = useQueryClient()
  const settings = useQuery({
    queryKey: ['task-do', 'settings'],
    queryFn: () =>
      api.get<{ data: TaskDoSettings }>('/ai/task-do/settings').then((r) => r.data.data)
  })
  const roles = useQuery<Role[]>({
    queryKey: ['roles'],
    queryFn: () => api.get<{ data: Role[] }>('/roles').then((r) => r.data.data)
  })
  const categories = useQuery<Category[]>({
    queryKey: ['support-categories', 'all'],
    queryFn: () =>
      api
        .get<{ data: Category[] }>('/support/categories', { params: { all: '1' } })
        .then((r) => r.data.data)
  })
  const [form, setForm] = useState<TaskDoSettings | null>(null)
  useEffect(() => {
    if (settings.data && !form) setForm(settings.data)
  }, [settings.data, form])

  const save = useMutation({
    mutationFn: (body: TaskDoSettings) =>
      api.patch<{ data: TaskDoSettings }>('/ai/task-do/settings', body).then((r) => r.data.data),
    onSuccess: (d) => {
      setForm(d)
      qc.setQueryData(['task-do', 'settings'], d)
      void qc.invalidateQueries({ queryKey: ['task-do', 'me'] })
      toast.success('Let AI do this settings saved')
    },
    onError: (e) =>
      toast.error(
        (e as { response?: { data?: { error?: string } } })?.response?.data?.error ??
          'Could not save'
      )
  })

  const toggle = <T extends string | number>(list: T[], v: T): T[] =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v]
  const dirty = !!form && !!settings.data && JSON.stringify(form) !== JSON.stringify(settings.data)

  return (
    <div
      className='space-y-4 border-t border-slate-100 pt-5 dark:border-border'
      data-task-do-settings
    >
      <div>
        <h3 className='flex items-center gap-1.5 text-[13px] font-semibold text-slate-900 dark:text-foreground'>
          <Sparkles className='h-3.5 w-3.5 text-slate-400' /> Let AI do this
        </h3>
        <p className='mt-1 max-w-[70ch] text-[12px] text-muted-foreground'>
          The person a task or support ticket is assigned to can ask AI to draft a plan that does it
          — built and previewed as them, approved before anything runs, reported on the thread, and
          undoable for seven days. Off until you turn it on.
        </p>
      </div>
      {settings.isError ? (
        <div className='flex flex-wrap items-center gap-3 text-[12px]'>
          <span className='text-rose-700 dark:text-rose-400'>
            Could not load these settings
            {(settings.error as { response?: { data?: { error?: string } } })?.response?.data?.error
              ? `: ${(settings.error as { response?: { data?: { error?: string } } }).response!.data!.error}`
              : '.'}
          </span>
          <Button
            size='sm'
            variant='outline'
            className='h-7'
            onClick={() => void settings.refetch()}
            disabled={settings.isFetching}
          >
            {settings.isFetching ? <Loader2 className='h-3 w-3 animate-spin' /> : null}
            Try again
          </Button>
        </div>
      ) : settings.isLoading || !form ? (
        <div className='space-y-2'>
          <Skeleton className='h-5 w-48' />
          <Skeleton className='h-5 w-64' />
          <Skeleton className='h-8 w-full' />
        </div>
      ) : (
        <>
          <div className='flex flex-wrap gap-6'>
            <div className='flex items-center gap-2'>
              <Switch
                id='task-do-tasks'
                checked={form.tasks_enabled}
                onCheckedChange={(v) => setForm({ ...form, tasks_enabled: v })}
              />
              <Label htmlFor='task-do-tasks' className='text-[12.5px] font-normal text-foreground'>
                On tasks
              </Label>
            </div>
            <div className='flex items-center gap-2'>
              <Switch
                id='task-do-tickets'
                checked={form.tickets_enabled}
                onCheckedChange={(v) => setForm({ ...form, tickets_enabled: v })}
              />
              <Label
                htmlFor='task-do-tickets'
                className='text-[12.5px] font-normal text-foreground'
              >
                On support tickets
              </Label>
            </div>
          </div>
          <Row
            label='Roles that may use it'
            hint='Nothing ticked = every role. The assignee (or their active delegate) must still be the one asking.'
          >
            {(id) => (
              <fieldset
                id={id}
                aria-label='Roles that may use it'
                className='flex flex-wrap gap-x-4 gap-y-1.5'
              >
                {(roles.data ?? []).map((r) => (
                  <div key={r.id} className='flex items-center gap-1.5'>
                    <Checkbox
                      id={`task-do-role-${r.id}`}
                      checked={form.allowed_roles.some(
                        (x) => x.toUpperCase() === r.id.toUpperCase()
                      )}
                      onCheckedChange={() =>
                        setForm({
                          ...form,
                          allowed_roles: form.allowed_roles.some(
                            (x) => x.toUpperCase() === r.id.toUpperCase()
                          )
                            ? form.allowed_roles.filter(
                                (x) => x.toUpperCase() !== r.id.toUpperCase()
                              )
                            : [...form.allowed_roles, r.id]
                        })
                      }
                    />
                    <Label
                      htmlFor={`task-do-role-${r.id}`}
                      className='text-[12px] font-normal text-foreground'
                    >
                      {r.name}
                    </Label>
                  </div>
                ))}
                {roles.data?.length === 0 && (
                  <span className='text-[12px] text-muted-foreground'>No roles yet.</span>
                )}
              </fieldset>
            )}
          </Row>
          <Row
            label='Support request types that allow it'
            hint='Nothing ticked = every type. Only matters when support tickets are on.'
          >
            {(id) => (
              <fieldset
                id={id}
                aria-label='Support request types that allow it'
                className='flex flex-wrap gap-x-4 gap-y-1.5'
              >
                {(categories.data ?? []).map((c) => (
                  <div key={c.id} className='flex items-center gap-1.5'>
                    <Checkbox
                      id={`task-do-cat-${c.id}`}
                      checked={form.ticket_categories.includes(c.id)}
                      onCheckedChange={() =>
                        setForm({
                          ...form,
                          ticket_categories: toggle(form.ticket_categories, c.id)
                        })
                      }
                    />
                    <Label
                      htmlFor={`task-do-cat-${c.id}`}
                      className={
                        c.is_active
                          ? 'text-[12px] font-normal text-foreground'
                          : 'text-[12px] font-normal text-muted-foreground'
                      }
                    >
                      {c.name}
                      {!c.is_active && ' (inactive)'}
                    </Label>
                  </div>
                ))}
                {categories.data?.length === 0 && (
                  <span className='text-[12px] text-muted-foreground'>No request types yet.</span>
                )}
              </fieldset>
            )}
          </Row>
          <div className='flex flex-wrap gap-x-8 gap-y-4'>
            <Row
              label='Second approval above'
              hint='Records a plan may change before the task creator (or an administrator) must also approve it. 0 = never.'
            >
              {(id) => (
                <Input
                  id={id}
                  type='number'
                  min={0}
                  max={100000}
                  value={form.approval_threshold}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      approval_threshold: Math.max(0, Number(e.target.value) || 0)
                    })
                  }
                  className='h-8 w-28 text-[13px] tabular-nums'
                />
              )}
            </Row>
            <Row label='Drafts per person per day' hint='0 = no limit.'>
              {(id) => (
                <Input
                  id={id}
                  type='number'
                  min={0}
                  max={1000}
                  value={form.daily_cap}
                  onChange={(e) =>
                    setForm({ ...form, daily_cap: Math.max(0, Number(e.target.value) || 0) })
                  }
                  className='h-8 w-28 text-[13px] tabular-nums'
                />
              )}
            </Row>
          </div>
          <div className='flex items-center gap-3'>
            <Button
              size='sm'
              variant='outline'
              onClick={() => save.mutate(form)}
              disabled={save.isPending || !dirty}
              data-task-do-settings-save
            >
              {save.isPending ? <Loader2 className='h-3 w-3 animate-spin' /> : null}
              Save Let AI do this settings
            </Button>
            {dirty && <span className='text-[11.5px] text-muted-foreground'>Unsaved changes</span>}
          </div>
        </>
      )}
    </div>
  )
}
