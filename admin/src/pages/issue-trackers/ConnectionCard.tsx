import { describeError, toastError, useUnsavedWork } from '@nivaro/shared'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  ChevronsUpDown,
  CircleAlert,
  CircleCheck,
  Loader2,
  PlugZap,
  Trash2,
  TriangleAlert
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
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
import { Switch } from '@/components/ui/switch'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import {
  accessLevelName,
  type ConnectionForm,
  type CreatedConnection,
  connectionBody,
  fetchProjects,
  formOf,
  needsTokenForNewUrl,
  type TestResult,
  TOKEN_MASK,
  type TrackerConnection,
  trackerKeys
} from './api'

const REPORTER = 20

function ProjectPicker({
  connectionId,
  value,
  path,
  onChange
}: {
  connectionId: number
  value: number | null
  path: string | null
  onChange: (id: number | null, path: string | null) => void
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250)
    return () => clearTimeout(t)
  }, [search])
  const projects = useQuery({
    queryKey: trackerKeys.projects(connectionId, debounced),
    queryFn: () => fetchProjects(connectionId, debounced),
    enabled: open,
    staleTime: 60_000
  })
  const failed = projects.isError ? describeError(projects.error, 'Could not list projects') : null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id='tracker-project'
          type='button'
          variant='outline'
          role='combobox'
          aria-expanded={open}
          className='h-8 w-full justify-between px-2 text-[12px] font-normal'
        >
          <span className={cn('truncate', !path && 'text-muted-foreground')}>
            {path ?? 'Pick a project…'}
          </span>
          <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[340px] p-0' align='start'>
        <Command shouldFilter={false}>
          <CommandInput
            value={search}
            onValueChange={setSearch}
            placeholder='Search your GitLab projects…'
            className='h-8 text-[12px]'
          />
          <CommandList>
            {projects.isFetching && (
              <p className='flex items-center gap-1.5 px-3 py-2 text-[11.5px] text-muted-foreground'>
                <Loader2 className='h-3 w-3 animate-spin' />
                Asking GitLab…
              </p>
            )}
            {failed && (
              <p className='px-3 py-2 text-[11.5px] text-red-700 dark:text-red-400'>
                {failed.title}
                {failed.hint ? ` ${failed.hint}` : ''}
              </p>
            )}
            {!projects.isFetching && !failed && (
              <CommandEmpty className='px-3 py-4 text-center text-[12px] text-muted-foreground'>
                No project matches — the token sees only projects it is a member of.
              </CommandEmpty>
            )}
            {(projects.data ?? []).length > 0 && (
              <CommandGroup>
                {(projects.data ?? []).map((p) => (
                  <CommandItem
                    key={p.id}
                    value={String(p.id)}
                    onSelect={() => {
                      onChange(p.id, p.path_with_namespace)
                      setOpen(false)
                    }}
                  >
                    <span className='flex-1 truncate font-mono text-[11.5px]'>
                      {p.path_with_namespace}
                    </span>
                    <Check
                      className={cn(
                        'h-3.5 w-3.5 text-nvr-cyan',
                        value === p.id ? 'opacity-100' : 'opacity-0'
                      )}
                    />
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function TestOutcome({ result }: { result: TestResult }) {
  if (!result.ok)
    return (
      <div className='flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] dark:border-red-500/30 dark:bg-red-500/10'>
        <CircleAlert className='mt-0.5 h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400' />
        <div className='min-w-0 space-y-0.5'>
          <p className='font-medium text-red-900 dark:text-red-200'>{result.hint}</p>
          <p className='break-words text-[11.5px] text-red-800/80 dark:text-red-300/80'>
            {result.error}
          </p>
        </div>
      </div>
    )
  const low = result.project && (result.access_level ?? 0) < REPORTER
  return (
    <div
      className={cn(
        'flex items-start gap-2 rounded-md border px-3 py-2 text-[12px]',
        low
          ? 'border-amber-300 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/10'
          : 'border-emerald-200 bg-emerald-50 dark:border-emerald-500/30 dark:bg-emerald-500/10'
      )}
    >
      {low ? (
        <TriangleAlert className='mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400' />
      ) : (
        <CircleCheck className='mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400' />
      )}
      <dl className='grid min-w-0 grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-slate-800 dark:text-slate-100'>
        <dt className='text-slate-500 dark:text-muted-foreground'>Signed in as</dt>
        <dd className='truncate'>
          {result.user.name}{' '}
          <span className='text-slate-500 dark:text-muted-foreground'>@{result.user.username}</span>
        </dd>
        {result.project ? (
          <>
            <dt className='text-slate-500 dark:text-muted-foreground'>Project</dt>
            <dd className='truncate font-mono text-[11.5px]'>
              {result.project.path_with_namespace}
            </dd>
            <dt className='text-slate-500 dark:text-muted-foreground'>Access</dt>
            <dd>{accessLevelName(result.access_level)}</dd>
          </>
        ) : (
          <dd className='col-span-2 text-slate-500 dark:text-muted-foreground'>
            No default project picked yet.
          </dd>
        )}
        {low && (
          <dd className='col-span-2 text-amber-900 dark:text-amber-200'>
            The token needs Reporter or higher on this project to open issues and add labels.
          </dd>
        )}
      </dl>
    </div>
  )
}

export function ConnectionCard({
  connection,
  onCreated,
  onDeleted,
  onCancel
}: {
  connection: TrackerConnection | null
  onCreated: (c: CreatedConnection) => void
  onDeleted: () => void
  onCancel?: () => void
}) {
  const qc = useQueryClient()
  const [form, setForm] = useState<ConnectionForm>(() => formOf(connection))
  const [test, setTest] = useState<TestResult | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const set = <K extends keyof ConnectionForm>(k: K, v: ConnectionForm[K]) =>
    setForm((f) => ({ ...f, [k]: v }))

  const creating = !connection
  const body = connectionBody(form, connection)
  const dirty = creating || Object.keys(body).length > 0
  // A reload (force refresh, minimum build) asks first while something typed is unsaved: an
  // edited connection, or a new one with anything filled in.
  useUnsavedWork(
    creating ? JSON.stringify(form) !== JSON.stringify(formOf(null)) : Object.keys(body).length > 0,
    'GitLab connection'
  )
  const tokenAgain = needsTokenForNewUrl(form, connection)
  const valid =
    form.name.trim() !== '' &&
    /^https?:\/\/\S+$/i.test(form.base_url.trim()) &&
    (!creating || (form.token.trim() !== '' && form.token !== TOKEN_MASK)) &&
    !tokenAgain

  const save = useMutation({
    mutationFn: async () => {
      if (creating)
        return (await api.post<{ data: CreatedConnection }>('/trackers', body)).data.data
      return (await api.patch<{ data: TrackerConnection }>(`/trackers/${connection.id}`, body)).data
        .data
    },
    onSuccess: (saved) => {
      void qc.invalidateQueries({ queryKey: trackerKeys.connections() })
      // A new address, token or default project: the label and project lists change with it.
      if (connection) {
        void qc.invalidateQueries({ queryKey: ['trackers', 'labels', connection.id] })
        void qc.invalidateQueries({ queryKey: ['trackers', 'projects', connection.id] })
      }
      if (creating) {
        onCreated(saved as CreatedConnection)
        return
      }
      setForm(formOf(saved))
      setTest(null)
      toast.success('Connection saved')
    },
    onError: (err) => toastError(err, 'Could not save the connection')
  })

  const runTest = useMutation({
    mutationFn: () => api.post<TestResult>(`/trackers/${connection?.id}/test`).then((r) => r.data),
    onSuccess: (r) => {
      setTest(r)
      void qc.invalidateQueries({ queryKey: trackerKeys.connections() })
      if (connection) void qc.invalidateQueries({ queryKey: trackerKeys.health(connection.id) })
    },
    onError: (err) => toastError(err, 'Could not test the connection')
  })

  const remove = useMutation({
    mutationFn: () => api.delete(`/trackers/${connection?.id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: trackerKeys.connections() })
      toast.success('Connection removed')
      onDeleted()
    },
    onError: (err) => {
      setConfirmDelete(false)
      toastError(err, 'Could not remove the connection')
    }
  })

  return (
    <section
      aria-labelledby='tracker-connection'
      className='space-y-4 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'
    >
      <div className='flex flex-wrap items-start justify-between gap-3'>
        <div>
          <h3
            id='tracker-connection'
            className='text-[13px] font-semibold text-slate-900 dark:text-foreground'
          >
            {creating ? 'Connect GitLab' : 'Connection'}
          </h3>
          <p className='mt-0.5 max-w-[68ch] text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            A GitLab access token with the <span className='font-mono'>api</span> scope and Reporter
            (or higher) on the project. A project or group access token keeps it off a person's
            account.
          </p>
        </div>
        {!creating && (
          <div className='flex items-center gap-2'>
            <Label htmlFor='tracker-active' className='cursor-pointer text-[12px]'>
              {form.is_active ? 'Syncing' : 'Paused'}
            </Label>
            <Switch
              id='tracker-active'
              checked={form.is_active}
              onCheckedChange={(v) => set('is_active', v)}
            />
          </div>
        )}
      </div>

      <div className='grid gap-4 md:grid-cols-2'>
        <div className='space-y-1.5'>
          <Label htmlFor='tracker-name' className='text-[12px]'>
            Name
          </Label>
          <Input
            id='tracker-name'
            value={form.name}
            maxLength={200}
            onChange={(e) => set('name', e.target.value)}
            className='h-8 text-[13px]'
          />
        </div>
        <div className='space-y-1.5'>
          <Label htmlFor='tracker-url' className='text-[12px]'>
            GitLab address
          </Label>
          <Input
            id='tracker-url'
            value={form.base_url}
            maxLength={500}
            placeholder='https://gitlab.example.com'
            onChange={(e) => set('base_url', e.target.value)}
            className='h-8 font-mono text-[12px]'
          />
        </div>
        <div className='space-y-1.5'>
          <Label htmlFor='tracker-token' className='text-[12px]'>
            Access token
          </Label>
          <Input
            id='tracker-token'
            type='password'
            autoComplete='new-password'
            value={form.token}
            placeholder={creating ? 'glpat-…' : 'Not set'}
            onFocus={(e) => {
              if (e.currentTarget.value === TOKEN_MASK) e.currentTarget.select()
            }}
            onChange={(e) => set('token', e.target.value)}
            className={cn(
              'h-8 font-mono text-[12px]',
              tokenAgain && 'border-amber-400 dark:border-amber-500/60'
            )}
          />
          {tokenAgain ? (
            <p className='text-[11px] text-amber-800 dark:text-amber-300'>
              Enter the token again for the new address — the saved one is never sent to another
              host.
            </p>
          ) : (
            !creating && (
              <p className='text-[11px] text-slate-500 dark:text-muted-foreground'>
                Saved and hidden. Type a new one to replace it.
              </p>
            )
          )}
        </div>
        <div className='space-y-1.5'>
          <Label htmlFor='tracker-project' className='text-[12px]'>
            Default project
          </Label>
          {connection?.token_set ? (
            <ProjectPicker
              connectionId={connection.id}
              value={form.default_project_id}
              path={form.default_project_path}
              onChange={(id, path) =>
                setForm((f) => ({ ...f, default_project_id: id, default_project_path: path }))
              }
            />
          ) : (
            <p className='flex h-8 items-center text-[11.5px] text-slate-500 dark:text-muted-foreground'>
              Connect first, then pick the project new issues go to.
            </p>
          )}
        </div>
      </div>

      {test && <TestOutcome result={test} />}

      <div className='flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 dark:border-border'>
        <Button
          type='button'
          size='sm'
          className='h-8 gap-1.5 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan/90'
          disabled={!dirty || !valid || save.isPending}
          onClick={() => save.mutate()}
        >
          {save.isPending ? (
            <Loader2 className='h-3.5 w-3.5 animate-spin' />
          ) : (
            creating && <PlugZap className='h-3.5 w-3.5' />
          )}
          {creating ? 'Connect GitLab' : 'Save connection'}
        </Button>
        {creating && onCancel && (
          <Button
            type='button'
            variant='ghost'
            size='sm'
            className='h-8 text-[12px]'
            onClick={onCancel}
          >
            Cancel
          </Button>
        )}
        {!creating && (
          <Button
            type='button'
            variant='outline'
            size='sm'
            className='h-8 gap-1.5 text-[12px]'
            disabled={runTest.isPending || dirty}
            data-tip={dirty ? 'Save your changes first' : undefined}
            onClick={() => runTest.mutate()}
          >
            {runTest.isPending && <Loader2 className='h-3.5 w-3.5 animate-spin' />}
            Test connection
          </Button>
        )}
        {!creating && (
          <div className='ml-auto flex items-center gap-2'>
            {confirmDelete ? (
              <>
                <span className='text-[11.5px] text-slate-600 dark:text-muted-foreground'>
                  Remove this connection?
                </span>
                <Button
                  type='button'
                  variant='destructive'
                  size='sm'
                  className='h-7 px-2.5 text-[11.5px]'
                  disabled={remove.isPending}
                  onClick={() => remove.mutate()}
                >
                  Remove
                </Button>
                <Button
                  type='button'
                  variant='ghost'
                  size='sm'
                  className='h-7 px-2 text-[11.5px]'
                  onClick={() => setConfirmDelete(false)}
                >
                  Keep it
                </Button>
              </>
            ) : (
              <Button
                type='button'
                variant='ghost'
                size='sm'
                className='h-7 gap-1 px-2 text-[11.5px] text-slate-500 hover:text-red-600 dark:text-muted-foreground dark:hover:text-red-400'
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 className='h-3 w-3' />
                Remove connection
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  )
}
