import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Plus, Trash2, Zap } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useGoBack } from '@/lib/nav'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'

// ─── Types ────────────────────────────────────────────────────────────────────

type ParamType = 'string' | 'number' | 'boolean' | 'date'

type ParamDef = {
  name: string
  type: ParamType
  required: boolean
  default: string
}

type QueryForm = {
  name: string
  description: string
  slug: string
  sql_text: string
  access: 'admin' | 'authenticated'
  cache_ttl: number
  enabled: boolean
  params: ParamDef[]
  scope_params: string
}

type CustomQuery = {
  id: string
  name: string
  description: string | null
  slug: string
  sql_text: string
  access: 'admin' | 'authenticated'
  cache_ttl: number
  enabled: boolean
  params: ParamDef[] | null
  scope_params: string | null
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function CustomQueryEditPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const goBack = useGoBack('/custom-queries')
  const queryClient = useQueryClient()
  const isNew = id === 'new'

  const [form, setForm] = useState<QueryForm>({
    name: '',
    description: '',
    slug: '',
    sql_text: '',
    access: 'authenticated',
    cache_ttl: 0,
    enabled: true,
    params: [],
    scope_params: ''
  })
  const [slugTouched, setSlugTouched] = useState(false)
  const [testValues, setTestValues] = useState<Record<string, string>>({})
  const [testResult, setTestResult] = useState<string | null>(null)
  const [showResolvedSql, setShowResolvedSql] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['custom-queries', id],
    queryFn: () => api.get(`/custom-queries/${id}`).then((r) => r.data.data as CustomQuery),
    enabled: !isNew && !!id
  })

  useEffect(() => {
    if (data) {
      setSlugTouched(true)
      setForm({
        name: data.name ?? '',
        description: data.description ?? '',
        slug: data.slug ?? '',
        sql_text: data.sql_text ?? '',
        access: data.access ?? 'authenticated',
        cache_ttl: data.cache_ttl ?? 0,
        enabled: data.enabled ?? true,
        params: data.params ?? [],
        scope_params: data.scope_params ?? ''
      })
    }
  }, [data])

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      isNew
        ? api.post('/custom-queries', body).then((r) => r.data)
        : api.patch(`/custom-queries/${id}`, body).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['custom-queries'] })
      toast.success(isNew ? 'Query created' : 'Query saved')
      navigate('/custom-queries')
    },
    onError: () => toast.error('Failed to save query')
  })

  function buildResolvedSql(): string {
    let sql = form.sql_text
    for (const p of form.params) {
      const raw = testValues[p.name] ?? p.default ?? ''
      let replacement: string
      if (raw === '') {
        replacement = 'NULL'
      } else if (p.type === 'number') {
        replacement = raw
      } else if (p.type === 'boolean') {
        replacement = raw === 'true' ? '1' : '0'
      } else if (p.type === 'date') {
        replacement = `'${raw.replace(/'/g, "''")}'`
      } else {
        replacement = `'${raw.replace(/'/g, "''")}'`
      }
      sql = sql.replace(new RegExp(`:${p.name}(?=\\W|$)`, 'g'), replacement)
    }
    return sql
  }

  const testExecute = useMutation({
    mutationFn: () => {
      const params: Record<string, unknown> = {}
      for (const p of form.params) {
        const raw = testValues[p.name] ?? ''
        if (raw === '' && !p.required) continue
        if (p.type === 'number') params[p.name] = Number(raw)
        else if (p.type === 'boolean') params[p.name] = raw === 'true'
        else params[p.name] = raw // string and date both sent as string; server handles date cast
      }
      return api.post(`/custom-queries/${form.slug}/execute`, { params }).then((r) => r.data)
    },
    onSuccess: (res) => {
      setTestResult(JSON.stringify(res, null, 2))
      toast.success('Query executed')
    },
    onError: (err: unknown) => {
      const e = err as { response?: { data?: unknown } }
      setTestResult(JSON.stringify(e.response?.data ?? String(err), null, 2))
      toast.error('Execution failed')
    }
  })

  function setName(name: string) {
    setForm((p) => ({ ...p, name, slug: slugTouched ? p.slug : slugify(name) }))
  }

  function updateParam(i: number, patch: Partial<ParamDef>) {
    setForm((p) => {
      const params = [...p.params]
      params[i] = { ...params[i], ...patch }
      return { ...p, params }
    })
  }

  function handleSave() {
    if (!form.name.trim() || !form.slug.trim() || !form.sql_text.trim()) {
      toast.error('Name, slug, and SQL are required')
      return
    }
    save.mutate({
      name: form.name,
      description: form.description || null,
      slug: form.slug,
      sql_text: form.sql_text,
      access: form.access,
      cache_ttl: form.cache_ttl,
      scope_params: form.scope_params.trim() ? form.scope_params.trim() : null,
      enabled: form.enabled,
      params: form.params
    })
  }

  return (
    <>
      <div className='sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-4'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2'>
            <button
              type='button'
              onClick={goBack}
              className='flex items-center gap-1.5 rounded-lg p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700'
            >
              <ArrowLeft className='h-4 w-4' />
            </button>
            <span className='text-[13px] text-slate-400'>/</span>
            <span className='text-[13px] font-medium text-slate-500'>Custom Queries</span>
            <span className='text-[13px] text-slate-400'>/</span>
            <span className='text-[13px] font-semibold text-slate-900'>
              {isNew ? 'New Query' : (data?.name ?? 'Query')}
            </span>
          </div>
          <Button size='sm' onClick={handleSave} disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </div>

      <div className='p-8'>
        {!isNew && isLoading ? (
          <div className='mx-auto max-w-2xl space-y-4'>
            <Skeleton className='h-40 w-full rounded-xl' />
            <Skeleton className='h-48 w-full rounded-xl' />
          </div>
        ) : (
          <div className='mx-auto max-w-2xl space-y-5'>
            {/* Settings */}
            <div className='rounded-xl border border-slate-200 bg-white p-6'>
              <h2 className='mb-4 text-[13px] font-semibold text-slate-900'>Query Settings</h2>
              <div className='space-y-4'>
                <div className='space-y-1.5'>
                  <Label htmlFor='cq-name'>
                    Name <span className='text-red-500'>*</span>
                  </Label>
                  <Input
                    id='cq-name'
                    value={form.name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder='e.g. Active orders by region'
                  />
                </div>

                <div className='space-y-1.5'>
                  <Label htmlFor='cq-slug'>
                    Slug <span className='text-red-500'>*</span>
                  </Label>
                  <Input
                    id='cq-slug'
                    value={form.slug}
                    onChange={(e) => {
                      setSlugTouched(true)
                      setForm((p) => ({ ...p, slug: e.target.value }))
                    }}
                    placeholder='active-orders'
                    className='font-mono text-[13px]'
                  />
                  <p className='text-[11px] text-slate-400'>
                    Used in the endpoint URL. Auto-derived from the name.
                  </p>
                </div>

                <div className='space-y-1.5'>
                  <Label htmlFor='cq-description'>Description</Label>
                  <Textarea
                    id='cq-description'
                    value={form.description}
                    onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
                    placeholder='What does this query return?'
                    rows={2}
                  />
                </div>

                <div className='space-y-1.5'>
                  <Label htmlFor='cq-sql'>
                    SQL <span className='text-red-500'>*</span>
                  </Label>
                  <Textarea
                    id='cq-sql'
                    value={form.sql_text}
                    onChange={(e) => setForm((p) => ({ ...p, sql_text: e.target.value }))}
                    placeholder='SELECT * FROM orders WHERE region = :region'
                    rows={8}
                    className='font-mono text-[12px]'
                    spellCheck={false}
                  />
                </div>

                <div className='grid grid-cols-2 gap-3'>
                  <div className='space-y-1.5'>
                    <Label htmlFor='cq-access'>Access</Label>
                    <Select
                      value={form.access}
                      onValueChange={(v) =>
                        setForm((p) => ({ ...p, access: v as 'admin' | 'authenticated' }))
                      }
                    >
                      <SelectTrigger id='cq-access'>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value='authenticated'>Authenticated</SelectItem>
                        <SelectItem value='admin'>Admin</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className='space-y-1.5'>
                    <Label htmlFor='cq-cache'>Cache TTL (seconds, 0=disabled)</Label>
                    <Input
                      id='cq-cache'
                      type='number'
                      min={0}
                      value={form.cache_ttl}
                      onChange={(e) =>
                        setForm((p) => ({ ...p, cache_ttl: Number(e.target.value) || 0 }))
                      }
                    />
                  </div>
                </div>

                <div className='space-y-1.5'>
                  <Label htmlFor='cq-scope'>Scoped parameters (JSON, optional)</Label>
                  <textarea
                    id='cq-scope'
                    value={form.scope_params}
                    onChange={(e) => setForm((p) => ({ ...p, scope_params: e.target.value }))}
                    rows={3}
                    spellCheck={false}
                    placeholder='{"divisions": {"dimension": "division", "translate": "display"}}'
                    className='w-full rounded-md border border-slate-200 bg-white px-2.5 py-2 font-mono text-[12px] focus:outline-none focus:ring-1 focus:ring-nvr-cyan dark:border-border dark:bg-background'
                  />
                  <p className='text-[11px] text-slate-400'>
                    Maps an execute-param to a User Scope dimension. A restrict-scoped user's
                    allowance is injected (or intersected with their request) before the SQL runs —
                    this is how a raw-SQL query honors User Scopes. translate: "id" passes target
                    ids, "display" passes the dimension's display values (e.g. zone short names).
                  </p>
                </div>

                <div className='flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50/70 px-4 py-3'>
                  <div>
                    <p className='text-[13px] font-medium text-slate-800'>Enabled</p>
                    <p className='text-[11px] text-slate-400'>
                      Query is callable only when enabled.
                    </p>
                  </div>
                  <Switch
                    checked={form.enabled}
                    onCheckedChange={(v) => setForm((p) => ({ ...p, enabled: v }))}
                  />
                </div>
              </div>
            </div>

            {/* Params */}
            <div className='rounded-xl border border-slate-200 bg-white p-6'>
              <h2 className='mb-4 text-[13px] font-semibold text-slate-900'>Parameters</h2>
              <div className='space-y-2'>
                {form.params.length === 0 && (
                  <p className='text-[12px] text-slate-400'>No parameters defined.</p>
                )}
                {form.params.map((p, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: param rows have no stable id
                  <div key={i} className='flex items-center gap-2'>
                    <Input
                      value={p.name}
                      onChange={(e) => updateParam(i, { name: e.target.value })}
                      placeholder='name'
                      className='font-mono text-[12px]'
                    />
                    <Select
                      value={p.type}
                      onValueChange={(v) => updateParam(i, { type: v as ParamType })}
                    >
                      <SelectTrigger className='w-32'>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value='string'>string</SelectItem>
                        <SelectItem value='number'>number</SelectItem>
                        <SelectItem value='boolean'>boolean</SelectItem>
                        <SelectItem value='date'>date</SelectItem>
                      </SelectContent>
                    </Select>
                    <Input
                      value={p.default}
                      onChange={(e) => updateParam(i, { default: e.target.value })}
                      placeholder='default'
                      className='text-[12px]'
                    />
                    <label className='flex shrink-0 items-center gap-1.5 text-[11px] text-slate-600'>
                      <input
                        type='checkbox'
                        className='h-3.5 w-3.5 accent-nvr-cyan'
                        checked={p.required}
                        onChange={(e) => updateParam(i, { required: e.target.checked })}
                      />
                      req
                    </label>
                    <button
                      type='button'
                      className='rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-red-50 hover:text-red-500'
                      onClick={() =>
                        setForm((prev) => ({
                          ...prev,
                          params: prev.params.filter((_, j) => j !== i)
                        }))
                      }
                      aria-label='Remove parameter'
                    >
                      <Trash2 className='h-3.5 w-3.5' />
                    </button>
                  </div>
                ))}
              </div>
              <button
                type='button'
                onClick={() =>
                  setForm((p) => ({
                    ...p,
                    params: [
                      ...p.params,
                      { name: '', type: 'string', required: false, default: '' }
                    ]
                  }))
                }
                className='mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-slate-300 py-2 text-[12px] font-medium text-slate-500 transition-colors hover:border-nvr-cyan/50 hover:bg-slate-50 hover:text-nvr-cyan'
              >
                <Plus className='h-3.5 w-3.5' /> Add Parameter
              </button>
            </div>

            {/* Test execute */}
            {!isNew && (
              <div className='rounded-xl border border-slate-200 bg-white p-6'>
                <div className='mb-4 flex items-center justify-between'>
                  <div>
                    <h2 className='text-[13px] font-semibold text-slate-900'>Test Execute</h2>
                    <p className='mt-0.5 text-[11px] text-slate-400'>
                      Run the query with sample parameter values.
                    </p>
                  </div>
                  <Button
                    onClick={() => testExecute.mutate()}
                    disabled={testExecute.isPending}
                    className='gap-2'
                  >
                    <Zap className='h-3.5 w-3.5' />
                    {testExecute.isPending ? 'Running…' : 'Execute'}
                  </Button>
                </div>
                {form.params.length > 0 && (
                  <div className='mb-4 space-y-2'>
                    {form.params.map((p) => (
                      <div key={p.name} className='grid grid-cols-[140px_1fr] items-center gap-2'>
                        <Label className='font-mono text-[12px]'>
                          {p.name}
                          {p.required && <span className='text-red-500'> *</span>}
                        </Label>
                        <Input
                          type={p.type === 'date' ? 'date' : p.type === 'number' ? 'number' : 'text'}
                          value={testValues[p.name] ?? p.default ?? ''}
                          onChange={(e) =>
                            setTestValues((prev) => ({ ...prev, [p.name]: e.target.value }))
                          }
                          placeholder={p.type === 'boolean' ? 'true / false' : p.type}
                          className='text-[12px]'
                        />
                      </div>
                    ))}
                  </div>
                )}
                <div className='mb-3'>
                  <button
                    type='button'
                    className='mb-1.5 flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
                    onClick={() => setShowResolvedSql((v) => !v)}
                  >
                    <span>{showResolvedSql ? '▾' : '▸'}</span>
                    Resolved query
                  </button>
                  {showResolvedSql && (
                    <pre className='max-h-48 overflow-auto rounded-lg border border-slate-200 bg-slate-50 p-3 font-mono text-[11px] leading-relaxed text-slate-700 dark:border-border dark:bg-muted/30 dark:text-slate-300'>
                      {buildResolvedSql()}
                    </pre>
                  )}
                </div>
                {testResult && (
                  <pre className='max-h-72 overflow-auto rounded-lg bg-slate-900 p-3 font-mono text-[11px] text-slate-100'>
                    {testResult}
                  </pre>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  )
}
