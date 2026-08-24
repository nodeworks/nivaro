import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Plus, Sparkles, Trash2, Zap } from 'lucide-react'
import { useRef, useEffect, useState } from 'react'
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
import { formatSql } from '@/lib/format-sql'

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
  const [publishedUrl, setPublishedUrl] = useState<string | null>(null)

  // Scratchpad promotion (#115): a one-shot sessionStorage handoff prefills
  // SQL, name, and detected :params on the NEW-query form.
  const prefillConsumedRef = useRef(false)
  useEffect(() => {
    if (prefillConsumedRef.current || !isNew) return
    prefillConsumedRef.current = true
    try {
      const raw = sessionStorage.getItem('nvr-cq-prefill')
      if (!raw) return
      sessionStorage.removeItem('nvr-cq-prefill')
      const p = JSON.parse(raw) as { sql_text?: string; name?: string; params?: string[] }
      setForm((prev) => ({
        ...prev,
        sql_text: p.sql_text ?? prev.sql_text,
        name: p.name ?? prev.name,
        slug: (p.name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        params: (p.params ?? []).map((name) => ({ name, type: 'string' as ParamType, required: false, default: '' }))
      }))
    } catch {
      /* malformed handoff — blank form */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // SQL copilot (#54)
  const [aiPrompt, setAiPrompt] = useState('')
  const [lastRunError, setLastRunError] = useState<string | null>(null)
  const [aiText, setAiText] = useState<string | null>(null)
  const aiSql = useMutation({
    mutationFn: ({ mode }: { mode: 'generate' | 'explain' | 'fix' }) =>
      api
        .post('/ai/sql', {
          mode,
          prompt: aiPrompt.trim() || undefined,
          current_sql: form.sql_text.trim() || undefined,
          error: lastRunError ?? undefined
        })
        .then((r) => r.data.data as { sql: string | null; text: string }),
    onSuccess: (d, vars) => {
      if (d.sql && vars.mode !== 'explain') {
        setForm((p) => ({ ...p, sql_text: d.sql ?? p.sql_text }))
      }
      setAiText(d.text || null)
    },
    onError: (e: { response?: { data?: { error?: string } } }) =>
      toast.error(e.response?.data?.error ?? 'AI call failed')
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
      setPublishedUrl(
        (data as { public_token?: string | null }).public_token
          ? `/api/custom-queries/public/${(data as { public_token?: string }).public_token}`
          : null
      )
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
      // Draft execution: runs the SQL AS TYPED (unsaved edits, new queries),
      // bypassing the saved row and the Redis result cache — testing by slug
      // used to run the OLD saved SQL until the cache TTL expired.
      return api
        .post('/custom-queries/test-execute', {
          sql_text: form.sql_text,
          params: form.params,
          values: params
        })
        .then((r) => r.data)
    },
    onSuccess: (res) => {
      setLastRunError(null)
      setTestResult(JSON.stringify(res, null, 2))
      toast.success('Query executed')
    },
    onError: (err: unknown) => {
      setLastRunError(((err as { response?: { data?: { error?: string } } })?.response?.data?.error) ?? String(err))
      const e = err as { response?: { data?: unknown } }
      setTestResult(JSON.stringify(e.response?.data ?? String(err), null, 2))
      toast.error('Execution failed')
    }
  })

  interface PlanData {
    operators: Array<{ op: string; object: string | null; est_rows: number; cost: number }>
    missing_indexes: string[]
    plan_xml: string
  }
  const [plan, setPlan] = useState<PlanData | null>(null)
  const explain = useMutation({
    mutationFn: () => {
      const params: Record<string, unknown> = {}
      for (const p of form.params) {
        const raw = testValues[p.name] ?? ''
        if (raw === '' && !p.required) continue
        if (p.type === 'number') params[p.name] = Number(raw)
        else if (p.type === 'boolean') params[p.name] = raw === 'true'
        else params[p.name] = raw
      }
      return api
        .post<{ data: PlanData }>('/custom-queries/explain', {
          sql_text: form.sql_text,
          params: form.params,
          values: params
        })
        .then((r) => r.data.data)
    },
    onSuccess: (d) => setPlan(d),
    onError: (err: { response?: { data?: { error?: string } } }) =>
      toast.error(err.response?.data?.error ?? 'Explain failed')
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
      <div className='sticky top-0 z-10 border-b border-slate-200 bg-white px-8 py-4 dark:border-border dark:bg-card'>
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
                  {/* SQL copilot (#54): describe → generate with live schema
                      context; explain what's there; fix on error. Always a
                      DRAFT into the editor — nothing executes here. */}
                  <div className='flex flex-wrap items-center gap-1.5 rounded-md border border-[#00ceff33] bg-[#00ceff0a] p-1.5'>
                    <Sparkles className='ml-1 h-3.5 w-3.5 shrink-0 text-[#00a5cc]' />
                    <input
                      value={aiPrompt}
                      onChange={(e) => setAiPrompt(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && aiPrompt.trim() && !aiSql.isPending) {
                          aiSql.mutate({ mode: 'generate' })
                        }
                      }}
                      placeholder='Describe the query… (e.g. total requisition amount per zone for a funding year)'
                      className='h-7 min-w-[240px] flex-1 rounded border-0 bg-transparent px-1.5 text-[12.5px] outline-none placeholder:text-slate-400'
                    />
                    <Button
                      type='button'
                      size='sm'
                      className='h-7 text-[12px]'
                      disabled={!aiPrompt.trim() || aiSql.isPending}
                      onClick={() => aiSql.mutate({ mode: 'generate' })}
                    >
                      {aiSql.isPending ? 'Thinking…' : 'Generate'}
                    </Button>
                    <Button
                      type='button'
                      size='sm'
                      variant='outline'
                      className='h-7 text-[12px]'
                      disabled={!form.sql_text.trim() || aiSql.isPending}
                      onClick={() => aiSql.mutate({ mode: 'explain' })}
                    >
                      Explain
                    </Button>
                    <Button
                      type='button'
                      size='sm'
                      variant='outline'
                      className='h-7 text-[12px]'
                      disabled={!form.sql_text.trim() || aiSql.isPending}
                      onClick={() => aiSql.mutate({ mode: 'fix' })}
                    >
                      Fix
                    </Button>
                  </div>
                  {aiText && (
                    <p className='whitespace-pre-wrap rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-[12px] leading-relaxed text-slate-600 dark:border-border dark:bg-muted/40 dark:text-muted-foreground'>
                      {aiText}
                    </p>
                  )}
                  <Textarea
                    id='cq-sql'
                    value={form.sql_text}
                    onChange={(e) => setForm((p) => ({ ...p, sql_text: e.target.value }))}
                    placeholder='SELECT * FROM orders WHERE region = :region'
                    rows={8}
                    className='font-mono text-[12px]'
                    spellCheck={false}
                  />
                  <div className='flex items-center gap-2'>
                    <Button
                      type='button'
                      variant='outline'
                      size='sm'
                      className='h-7 text-[11.5px]'
                      disabled={!form.sql_text.trim()}
                      onClick={() => setForm((p) => ({ ...p, sql_text: formatSql(p.sql_text) }))}
                    >
                      Prettify
                    </Button>
                    {!isNew && (form.cache_ttl ?? 0) > 0 && (
                      <Button
                        type='button'
                        variant='outline'
                        size='sm'
                        className='h-7 text-[11.5px]'
                        onClick={() => {
                          // Cache bust (#254): drop every cached result for
                          // this slug — after a SQL edit, same-params runs
                          // otherwise serve the stale shape until TTL expiry.
                          void api
                            .post<{ data: { dropped: number } }>(`/custom-queries/${id}/bust-cache`)
                            .then((r) => toast.success(`${r.data.data.dropped} cached result(s) dropped`))
                            .catch(() => toast.error('Cache bust failed'))
                        }}
                      >
                        Bust cache
                      </Button>
                    )}
                  </div>
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

                {/* Query-as-endpoint (#340) */}
                {id && id !== 'new' && (
                  <div className='rounded-lg border border-slate-100 bg-slate-50/70 px-4 py-3 dark:border-border dark:bg-muted/30'>
                    <p className='text-[13px] font-medium text-slate-800 dark:text-slate-100'>
                      Public endpoint
                    </p>
                    <p className='text-[11px] text-slate-400'>
                      Publish this query behind an unguessable token — a plain GET URL with params
                      in the querystring, for spreadsheets and partners with no account.
                    </p>
                    {publishedUrl ? (
                      <div className='mt-2 flex items-center gap-2'>
                        <code className='min-w-0 flex-1 truncate rounded bg-white px-2 py-1 font-mono text-[11px] dark:bg-background'>
                          {publishedUrl}
                        </code>
                        <button
                          type='button'
                          onClick={() => {
                            void navigator.clipboard?.writeText(
                              `${window.location.origin}${publishedUrl}`
                            )
                            toast.success('URL copied')
                          }}
                          className='shrink-0 rounded-md border border-slate-200 px-2 py-1 text-[11.5px] hover:bg-white dark:border-border'
                        >
                          Copy
                        </button>
                        <button
                          type='button'
                          onClick={() => {
                            void api.delete(`/custom-queries/${id}/publish-token`).then(() => {
                              setPublishedUrl(null)
                              toast.success('Endpoint revoked')
                            })
                          }}
                          className='shrink-0 rounded-md border border-red-200 px-2 py-1 text-[11.5px] text-red-600 hover:bg-red-50 dark:border-red-500/40'
                        >
                          Revoke
                        </button>
                      </div>
                    ) : (
                      <button
                        type='button'
                        onClick={() => {
                          void api
                            .post<{ data: { url: string } }>(`/custom-queries/${id}/publish-token`)
                            .then((r) => {
                              setPublishedUrl(r.data.data.url)
                              toast.success('Published — copy the URL')
                            })
                        }}
                        className='mt-2 rounded-md border border-slate-200 px-2.5 py-1 text-[12px] hover:bg-white dark:border-border'
                      >
                        Publish as endpoint…
                      </button>
                    )}
                  </div>
                )}

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

            {/* Test execute — runs the CURRENT editor SQL (draft execution),
                so it works before saving and on brand-new queries. */}
            {(
              <div className='rounded-xl border border-slate-200 bg-white p-6'>
                <div className='mb-4 flex items-center justify-between'>
                  <div>
                    <h2 className='text-[13px] font-semibold text-slate-900'>Test Execute</h2>
                    <p className='mt-0.5 text-[11px] text-slate-400'>
                      Runs the SQL as typed above — unsaved edits included, cache bypassed.
                    </p>
                  </div>
                  <div className='flex items-center gap-2'>
                    <Button
                      variant='outline'
                      onClick={() => explain.mutate()}
                      disabled={explain.isPending}
                      className='gap-2'
                    >
                      {explain.isPending ? 'Planning…' : 'Explain plan'}
                    </Button>
                    <Button
                      onClick={() => testExecute.mutate()}
                      disabled={testExecute.isPending}
                      className='gap-2'
                    >
                      <Zap className='h-3.5 w-3.5' />
                      {testExecute.isPending ? 'Running…' : 'Execute'}
                    </Button>
                  </div>
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
                {plan && (
                  <div className='mt-3 rounded-lg border border-slate-200 dark:border-border'>
                    <div className='flex items-center justify-between border-b border-slate-100 px-3 py-2 dark:border-border/60'>
                      <p className='text-[11px] font-semibold uppercase tracking-wide text-slate-500'>
                        Estimated plan · {plan.operators.length} operator
                        {plan.operators.length === 1 ? '' : 's'}
                      </p>
                      <button
                        type='button'
                        className='text-[11px] text-slate-400 hover:text-slate-600'
                        onClick={() => setPlan(null)}
                      >
                        Dismiss
                      </button>
                    </div>
                    {plan.missing_indexes.length > 0 && (
                      <div className='border-b border-amber-100 bg-amber-50 px-3 py-2 text-[11.5px] text-amber-800 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-400'>
                        <span className='font-semibold'>Missing index suggestion:</span>{' '}
                        {plan.missing_indexes.join(' · ')}
                      </div>
                    )}
                    <table className='w-full text-[11.5px] tabular-nums'>
                      <thead>
                        <tr className='text-left text-[10px] uppercase tracking-wide text-slate-400'>
                          <th className='px-3 py-1.5 font-semibold'>Operator</th>
                          <th className='px-3 py-1.5 font-semibold'>Object</th>
                          <th className='px-3 py-1.5 text-right font-semibold'>Est. rows</th>
                          <th className='px-3 py-1.5 text-right font-semibold'>Subtree cost</th>
                        </tr>
                      </thead>
                      <tbody className='divide-y divide-slate-50 dark:divide-border/40'>
                        {plan.operators.map((o, i) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: plan rows are positional
                          <tr key={i} className={o.op.includes('Scan') ? 'bg-amber-50/50 dark:bg-amber-500/5' : ''}>
                            <td className='px-3 py-1.5 font-medium text-slate-700 dark:text-foreground'>
                              {o.op}
                            </td>
                            <td className='px-3 py-1.5 font-mono text-[11px] text-slate-500'>
                              {o.object ?? '—'}
                            </td>
                            <td className='px-3 py-1.5 text-right'>{o.est_rows.toLocaleString()}</td>
                            <td className='px-3 py-1.5 text-right'>{o.cost.toFixed(4)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  )
}
