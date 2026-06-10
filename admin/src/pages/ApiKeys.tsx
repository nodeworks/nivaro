import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronsUpDown, Copy, KeyRound, Plus, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
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
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { cn, formatDate, formatRelative } from '@/lib/utils'

interface ApiKeyScope {
  collection: string
  actions: string[]
}

interface ApiKey {
  id: string | number
  name: string
  prefix: string
  user: string
  scopes: ApiKeyScope[]
  expires_at: string | null
  rate_limit_per_minute: number | null
  ip_allowlist: string[]
  last_used_at: string | null
  is_active: boolean
  created_at: string
}

const ACTIONS = ['create', 'read', 'update', 'delete'] as const
const ALL_COLLECTIONS = '*'

function CollectionCombobox({
  value,
  onChange,
  options
}: {
  value: string
  onChange: (v: string) => void
  options: string[]
}) {
  const [open, setOpen] = useState(false)
  const label =
    value === ALL_COLLECTIONS
      ? 'All collections (*)'
      : value === 'scim'
        ? 'SCIM provisioning'
        : value
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant='outline'
          role='combobox'
          aria-expanded={open}
          className='h-8 w-full justify-between px-2 font-mono text-[12px] font-normal'
        >
          <span className={cn('truncate', !value && 'text-muted-foreground')}>
            {value ? label : 'Select collection…'}
          </span>
          <ChevronsUpDown className='ml-1 h-3 w-3 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent className='w-[260px] p-0' align='start'>
        <Command>
          <CommandInput placeholder='Search collections…' className='h-8 text-[12px]' />
          <CommandList>
            <CommandEmpty className='py-3 text-center text-[12px] text-muted-foreground'>
              No results
            </CommandEmpty>
            <CommandGroup>
              {[ALL_COLLECTIONS, 'scim', ...options].map((opt) => (
                <CommandItem
                  key={opt}
                  value={opt}
                  onSelect={(current) => {
                    onChange(current)
                    setOpen(false)
                  }}
                  className='font-mono text-[12px]'
                >
                  <Check
                    className={cn('mr-2 h-3 w-3', value === opt ? 'opacity-100' : 'opacity-0')}
                  />
                  {opt === ALL_COLLECTIONS
                    ? 'All collections (*)'
                    : opt === 'scim'
                      ? 'SCIM provisioning'
                      : opt}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function ScopesEditor({
  scopes,
  onChange,
  collections
}: {
  scopes: ApiKeyScope[]
  onChange: (scopes: ApiKeyScope[]) => void
  collections: string[]
}) {
  const update = (idx: number, patch: Partial<ApiKeyScope>) =>
    onChange(scopes.map((s, i) => (i === idx ? { ...s, ...patch } : s)))

  return (
    <div className='space-y-2'>
      {scopes.map((scope, idx) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional
          key={idx}
          className='space-y-2 rounded-lg border border-slate-200 p-3 dark:border-border'
        >
          <div className='flex items-center gap-2'>
            <div className='flex-1'>
              <CollectionCombobox
                value={scope.collection}
                onChange={(v) => update(idx, { collection: v })}
                options={collections}
              />
            </div>
            <button
              type='button'
              onClick={() => onChange(scopes.filter((_, i) => i !== idx))}
              className='rounded p-1.5 text-slate-400 hover:bg-slate-100 hover:text-red-500 dark:hover:bg-slate-800'
              aria-label='Remove scope'
            >
              <X className='h-3.5 w-3.5' />
            </button>
          </div>
          <div className='flex flex-wrap items-center gap-4'>
            <div className='flex items-center gap-1.5'>
              <Checkbox
                id={`scope-${idx}-all`}
                checked={scope.actions.includes('*')}
                onCheckedChange={(c) => update(idx, { actions: c ? ['*'] : [] })}
              />
              <Label htmlFor={`scope-${idx}-all`} className='text-[12px] font-normal'>
                All actions
              </Label>
            </div>
            {!scope.actions.includes('*') &&
              ACTIONS.map((action) => (
                <div key={action} className='flex items-center gap-1.5'>
                  <Checkbox
                    id={`scope-${idx}-${action}`}
                    checked={scope.actions.includes(action)}
                    onCheckedChange={(c) =>
                      update(idx, {
                        actions: c
                          ? [...scope.actions, action]
                          : scope.actions.filter((a) => a !== action)
                      })
                    }
                  />
                  <Label
                    htmlFor={`scope-${idx}-${action}`}
                    className='text-[12px] font-normal capitalize'
                  >
                    {action}
                  </Label>
                </div>
              ))}
          </div>
        </div>
      ))}
      <Button
        type='button'
        variant='outline'
        size='sm'
        className='gap-1.5 text-[12px]'
        onClick={() => onChange([...scopes, { collection: '', actions: ['read'] }])}
      >
        <Plus className='h-3.5 w-3.5' />
        Add Scope
      </Button>
    </div>
  )
}

interface FormState {
  name: string
  expires_at: string
  scopes: ApiKeyScope[]
  ip_allowlist: string
  rate_limit_per_minute: string
}

const FORM_DEFAULTS: FormState = {
  name: '',
  expires_at: '',
  scopes: [{ collection: ALL_COLLECTIONS, actions: ['*'] }],
  ip_allowlist: '',
  rate_limit_per_minute: ''
}

function MetaCell({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className='bg-white p-3 dark:bg-card'>
      <p className='text-[10px] font-semibold uppercase tracking-wider text-slate-400'>{label}</p>
      <p className='mt-0.5 text-[13px] text-slate-700 dark:text-slate-200'>{value}</p>
    </div>
  )
}

export function ApiKeysPage() {
  const qc = useQueryClient()
  const [selectedId, setSelectedId] = useState<string | number | null>(null)
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState<FormState>(FORM_DEFAULTS)
  const [createdKey, setCreatedKey] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<'revoke' | 'delete' | null>(null)

  const { data: keys = [], isLoading } = useQuery<ApiKey[]>({
    queryKey: ['api-keys'],
    queryFn: () => api.get<{ data: ApiKey[] }>('/api-keys').then((r) => r.data.data)
  })

  const { data: collections = [] } = useQuery<string[]>({
    queryKey: ['collections-for-api-keys'],
    queryFn: () =>
      api
        .get<{ data: Array<{ collection: string }> }>('/collections')
        .then((r) => r.data.data.map((c) => c.collection))
  })

  const createMut = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<{ data: ApiKey & { key: string } }>('/api-keys', body).then((r) => r.data.data),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['api-keys'] })
      setCreating(false)
      setForm(FORM_DEFAULTS)
      setCreatedKey(data.key)
      setSelectedId(data.id)
      toast.success('API key created')
    },
    onError: () => toast.error('Failed to create API key')
  })

  const revokeMut = useMutation({
    mutationFn: (id: string | number) => api.post(`/api-keys/${id}/revoke`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['api-keys'] })
      setConfirm(null)
      toast.success('API key revoked')
    },
    onError: () => toast.error('Failed to revoke API key')
  })

  const deleteMut = useMutation({
    mutationFn: (id: string | number) => api.delete(`/api-keys/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['api-keys'] })
      setSelectedId(null)
      setConfirm(null)
      toast.success('API key deleted')
    },
    onError: () => toast.error('Failed to delete API key')
  })

  const selected = keys.find((k) => k.id === selectedId) ?? null

  const submitCreate = () => {
    const scopes = form.scopes.filter((s) => s.collection && s.actions.length > 0)
    if (!form.name.trim()) return toast.error('Name is required')
    if (scopes.length === 0) return toast.error('At least one scope is required')
    const allowlist = form.ip_allowlist
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    createMut.mutate({
      name: form.name.trim(),
      scopes,
      expires_at: form.expires_at || null,
      ip_allowlist: allowlist,
      rate_limit_per_minute: form.rate_limit_per_minute ? Number(form.rate_limit_per_minute) : null
    })
  }

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-8 py-5 dark:border-border dark:bg-background'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2.5'>
            <KeyRound className='h-5 w-5 text-muted-foreground' />
            <h1 className='text-[15px] font-semibold text-slate-900 dark:text-slate-100'>
              API Keys
            </h1>
          </div>
          <Button
            size='sm'
            onClick={() => {
              setCreating(true)
              setSelectedId(null)
              setCreatedKey(null)
              setConfirm(null)
              setForm(FORM_DEFAULTS)
            }}
          >
            <Plus className='mr-1.5 h-4 w-4' />
            New API Key
          </Button>
        </div>
      </header>

      <div className='flex flex-1 min-h-0 overflow-hidden'>
        {/* Left: key list */}
        <aside className='w-[272px] shrink-0 overflow-y-auto border-r border-slate-200 bg-white dark:border-border dark:bg-background'>
          {isLoading ? (
            <div className='space-y-2 p-3'>
              {[1, 2, 3].map((i) => (
                <div key={i} className='h-14 animate-pulse rounded-lg bg-muted' />
              ))}
            </div>
          ) : keys.length === 0 ? (
            <p className='p-4 text-[12px] text-slate-400'>No API keys yet.</p>
          ) : (
            <ul className='p-2'>
              {keys.map((key) => (
                <li key={key.id}>
                  <button
                    type='button'
                    onClick={() => {
                      setSelectedId(key.id)
                      setCreating(false)
                      setConfirm(null)
                    }}
                    className={cn(
                      'w-full rounded-lg px-3 py-2.5 text-left transition-colors',
                      selectedId === key.id && !creating
                        ? 'bg-[#00ceff]/10'
                        : 'hover:bg-slate-50 dark:hover:bg-slate-900'
                    )}
                  >
                    <div className='flex items-center justify-between gap-2'>
                      <span className='truncate text-[13px] font-medium text-slate-800 dark:text-slate-200'>
                        {key.name}
                      </span>
                      {key.is_active ? (
                        <Badge variant='success' className='h-4 shrink-0 px-1.5 text-[10px]'>
                          Active
                        </Badge>
                      ) : (
                        <Badge
                          variant='outline'
                          className='h-4 shrink-0 px-1.5 text-[10px] text-slate-400'
                        >
                          Revoked
                        </Badge>
                      )}
                    </div>
                    <div className='mt-0.5 flex items-center justify-between gap-2'>
                      <code className='font-mono text-[11px] text-slate-400'>{key.prefix}···</code>
                      <span className='text-[11px] text-slate-400'>
                        {key.last_used_at ? formatRelative(key.last_used_at) : 'Never used'}
                      </span>
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        {/* Right: detail / create */}
        <div className='flex-1 overflow-y-auto bg-slate-50 dark:bg-background'>
          {createdKey && (
            <div className='m-6 mb-0 rounded-lg border border-[#00ceff]/40 bg-[#00ceff]/10 p-4'>
              <p className='mb-2 text-[12px] font-medium text-slate-700 dark:text-slate-200'>
                Copy your new API key now — it will not be shown again.
              </p>
              <div className='flex items-center gap-2'>
                <code className='flex-1 break-all rounded-md border border-slate-200 bg-white px-3 py-2 font-mono text-[12px] text-slate-700 dark:border-border dark:bg-card dark:text-slate-200'>
                  {createdKey}
                </code>
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  className='shrink-0 gap-1.5 text-[12px]'
                  onClick={() => {
                    navigator.clipboard.writeText(createdKey)
                    toast.success('Copied')
                  }}
                >
                  <Copy className='h-3.5 w-3.5' />
                  Copy
                </Button>
                <Button
                  type='button'
                  variant='ghost'
                  size='sm'
                  className='shrink-0 text-[12px]'
                  onClick={() => setCreatedKey(null)}
                >
                  Dismiss
                </Button>
              </div>
            </div>
          )}

          {creating ? (
            <div className='mx-auto max-w-2xl space-y-5 p-6'>
              <h2 className='text-[14px] font-semibold text-slate-900 dark:text-slate-100'>
                New API Key
              </h2>

              <div className='space-y-1.5'>
                <Label htmlFor='key-name'>Name</Label>
                <Input
                  id='key-name'
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder='e.g. CI pipeline'
                />
              </div>

              <div className='grid gap-4 sm:grid-cols-2'>
                <div className='space-y-1.5'>
                  <Label htmlFor='key-expiry'>Expires (optional)</Label>
                  <Input
                    id='key-expiry'
                    type='date'
                    value={form.expires_at}
                    onChange={(e) => setForm((f) => ({ ...f, expires_at: e.target.value }))}
                  />
                </div>
                <div className='space-y-1.5'>
                  <Label htmlFor='key-rate-limit'>Rate limit / minute (optional)</Label>
                  <Input
                    id='key-rate-limit'
                    type='number'
                    min={1}
                    value={form.rate_limit_per_minute}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, rate_limit_per_minute: e.target.value }))
                    }
                    placeholder='e.g. 120'
                  />
                </div>
              </div>

              <div className='space-y-1.5'>
                <Label>Scopes</Label>
                <ScopesEditor
                  scopes={form.scopes}
                  onChange={(scopes) => setForm((f) => ({ ...f, scopes }))}
                  collections={collections}
                />
              </div>

              <div className='space-y-1.5'>
                <Label htmlFor='key-allowlist'>IP allowlist (one CIDR per line, optional)</Label>
                <Textarea
                  id='key-allowlist'
                  rows={3}
                  value={form.ip_allowlist}
                  onChange={(e) => setForm((f) => ({ ...f, ip_allowlist: e.target.value }))}
                  placeholder={'203.0.113.0/24\n198.51.100.7'}
                  className='font-mono text-[12px]'
                />
                <p className='text-[11px] text-slate-400'>
                  Leave empty to allow requests from any IP. IPv4 only.
                </p>
              </div>

              <div className='flex gap-2'>
                <Button size='sm' onClick={submitCreate} disabled={createMut.isPending}>
                  {createMut.isPending ? 'Creating…' : 'Create Key'}
                </Button>
                <Button
                  variant='outline'
                  size='sm'
                  onClick={() => setCreating(false)}
                  disabled={createMut.isPending}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : selected ? (
            <div className='mx-auto max-w-2xl space-y-5 p-6'>
              <div className='flex items-center justify-between'>
                <h2 className='text-[14px] font-semibold text-slate-900 dark:text-slate-100'>
                  {selected.name}
                </h2>
                {selected.is_active ? (
                  <Badge variant='success' className='h-5 px-2 text-[11px]'>
                    Active
                  </Badge>
                ) : (
                  <Badge variant='outline' className='h-5 px-2 text-[11px] text-slate-400'>
                    Revoked
                  </Badge>
                )}
              </div>

              <div className='grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-slate-200 bg-slate-200 dark:border-border dark:bg-border sm:grid-cols-3'>
                <MetaCell
                  label='Prefix'
                  value={<code className='font-mono'>{selected.prefix}···</code>}
                />
                <MetaCell label='Created' value={formatDate(selected.created_at)} />
                <MetaCell
                  label='Last used'
                  value={selected.last_used_at ? formatRelative(selected.last_used_at) : 'Never'}
                />
                <MetaCell
                  label='Expires'
                  value={selected.expires_at ? formatDate(selected.expires_at) : 'Never'}
                />
                <MetaCell
                  label='Rate limit'
                  value={
                    selected.rate_limit_per_minute
                      ? `${selected.rate_limit_per_minute}/min`
                      : 'Unlimited'
                  }
                />
                <MetaCell
                  label='IP allowlist'
                  value={
                    selected.ip_allowlist.length > 0
                      ? `${selected.ip_allowlist.length} entries`
                      : 'Any IP'
                  }
                />
              </div>

              <div>
                <h3 className='mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400'>
                  Scopes
                </h3>
                <div className='space-y-1.5'>
                  {selected.scopes.length === 0 ? (
                    <p className='text-[12px] text-slate-400'>No scopes — key has no access.</p>
                  ) : (
                    selected.scopes.map((scope) => (
                      <div
                        key={`${scope.collection}:${scope.actions.join(',')}`}
                        className='flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2 dark:border-border dark:bg-card'
                      >
                        <code className='font-mono text-[12px] text-slate-700 dark:text-slate-200'>
                          {scope.collection}
                        </code>
                        <div className='flex gap-1'>
                          {scope.actions.map((a) => (
                            <Badge key={a} className='h-4 px-1.5 text-[10px]'>
                              {a}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {selected.ip_allowlist.length > 0 && (
                <div>
                  <h3 className='mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400'>
                    IP Allowlist
                  </h3>
                  <div className='rounded-lg border border-slate-200 bg-white p-3 dark:border-border dark:bg-card'>
                    {selected.ip_allowlist.map((cidr) => (
                      <code
                        key={cidr}
                        className='block font-mono text-[12px] text-slate-600 dark:text-slate-300'
                      >
                        {cidr}
                      </code>
                    ))}
                  </div>
                </div>
              )}

              <div className='border-t border-slate-200 pt-4 dark:border-border'>
                {confirm ? (
                  <div className='flex items-center gap-3'>
                    <p className='text-[12px] text-slate-500'>
                      {confirm === 'revoke'
                        ? 'Revoke this key? Requests using it will stop working immediately.'
                        : 'Permanently delete this key? This cannot be undone.'}
                    </p>
                    <Button
                      variant='destructive'
                      size='sm'
                      className='text-[12px]'
                      disabled={revokeMut.isPending || deleteMut.isPending}
                      onClick={() =>
                        confirm === 'revoke'
                          ? revokeMut.mutate(selected.id)
                          : deleteMut.mutate(selected.id)
                      }
                    >
                      Confirm
                    </Button>
                    <Button
                      variant='outline'
                      size='sm'
                      className='text-[12px]'
                      onClick={() => setConfirm(null)}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <div className='flex gap-2'>
                    {selected.is_active && (
                      <Button
                        variant='outline'
                        size='sm'
                        className='gap-1.5 text-[12px]'
                        onClick={() => setConfirm('revoke')}
                      >
                        <X className='h-3.5 w-3.5' />
                        Revoke
                      </Button>
                    )}
                    <Button
                      variant='outline'
                      size='sm'
                      className='gap-1.5 text-[12px] text-red-500 hover:border-red-200 hover:bg-red-50 hover:text-red-600'
                      onClick={() => setConfirm('delete')}
                    >
                      <Trash2 className='h-3.5 w-3.5' />
                      Delete
                    </Button>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className='flex h-full flex-col items-center justify-center py-24 text-center'>
              <KeyRound className='mb-3 h-10 w-10 text-muted-foreground' />
              <p className='mb-1 text-sm font-medium'>No API key selected</p>
              <p className='text-xs text-muted-foreground'>
                Select a key from the list or create a new one.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
