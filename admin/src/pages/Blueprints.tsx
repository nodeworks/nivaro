import { useMutation, useQuery } from '@tanstack/react-query'
import { Check, Download, FileUp, Loader2, Package } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

type InstallReport = Record<string, { created?: number; skipped?: number } | string[] | number>

interface Manifest {
  name: string
  description: string | null
  version: string | null
  exported_at: string
  nivaro_version: string
  collections: string[]
  counts: Record<string, number>
}

interface BlueprintDiff {
  collections: Array<{ collection: string; exists: boolean; new_fields: string[] }>
  workflows: { new: number; existing: number }
  layouts: { new: number; existing: number }
  queues: { new: number; existing: number }
  rules: { new: number; existing: number }
}

export function BlueprintsPage() {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [version, setVersion] = useState('')
  const [artifact, setArtifact] = useState<Record<string, unknown> | null>(null)
  const [fileName, setFileName] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const { data: collections = [] } = useQuery({
    queryKey: ['collections', 'tables_only'],
    queryFn: () =>
      api
        .get<{ data: Array<{ collection: string }> }>('/collections?tables_only=true')
        .then((r) => r.data.data)
  })
  const filtered = collections.filter(
    (c) =>
      !c.collection.startsWith('nivaro_') &&
      c.collection.toLowerCase().includes(search.toLowerCase())
  )

  const publishMut = useMutation({
    mutationFn: () =>
      api
        .post<{ data: { manifest: Manifest } & Record<string, unknown> }>('/blueprints/publish', {
          name: name.trim(),
          description: description.trim() || undefined,
          version: version.trim() || undefined,
          collections: [...selected]
        })
        .then((r) => r.data.data),
    onSuccess: (data) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      const base = data.manifest.name.replace(/[^a-zA-Z0-9_-]/g, '_')
      a.download = `${base}${data.manifest.version ? `-${data.manifest.version}` : ''}.blueprint.json`
      a.click()
      URL.revokeObjectURL(a.href)
      toast.success('Blueprint published and downloaded')
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      toast.error(msg ?? 'Publish failed')
    }
  })

  // Manifest + diff preview of an uploaded bundle, before install is offered
  const manifestMut = useMutation({
    mutationFn: (bundle: Record<string, unknown>) =>
      api
        .post<{ data: { manifest: Manifest; diff: BlueprintDiff; wrapped: boolean } }>(
          '/blueprints/manifest-of',
          { bundle }
        )
        .then((r) => r.data.data),
    onError: () => toast.error('Could not read bundle manifest')
  })

  const installMut = useMutation({
    mutationFn: () =>
      api
        .post<{ data: InstallReport }>('/blueprints/install', { blueprint: artifact })
        .then((r) => r.data.data),
    onSuccess: () => toast.success('Blueprint installed'),
    onError: () => toast.error('Install failed')
  })

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    e.target.value = ''
    f.text().then((text) => {
      try {
        const parsed = JSON.parse(text)
        if (parsed?.type !== 'nivaro-blueprint' && parsed?.type !== 'nivaro-blueprint-package') {
          toast.error('Not a Nivaro blueprint')
          return
        }
        setArtifact(parsed)
        setFileName(f.name)
        installMut.reset()
        manifestMut.mutate(parsed)
      } catch {
        toast.error('Invalid JSON file')
      }
    })
  }

  const toggle = (c: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(c)) next.delete(c)
      else next.add(c)
      return next
    })

  const report = installMut.data
  const preview = manifestMut.data

  return (
    <div className='flex flex-1 min-h-0 flex-col'>
      <header className='shrink-0 border-b border-slate-200 bg-white px-8 py-5 dark:border-border dark:bg-card'>
        <div className='flex items-center gap-2.5'>
          <Package className='h-4.5 w-4.5 text-nvr-cyan' />
          <div>
            <h1 className='text-[18px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-foreground'>
              App Blueprints
            </h1>
            <p className='text-[12px] text-muted-foreground'>
              Package schema, workflows, layouts, queues and rules into one installable artifact.
              Data rows are not included — use Content Promotion for those.
            </p>
          </div>
        </div>
      </header>

      <div className='flex flex-1 min-h-0 overflow-y-auto'>
        <div className='grid w-full max-w-4xl grid-cols-1 gap-6 p-8 md:grid-cols-2'>
          {/* Publish */}
          <section className='rounded-lg border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'>
            <h2 className='mb-1 text-[14px] font-semibold text-slate-900 dark:text-foreground'>
              Publish blueprint
            </h2>
            <p className='mb-3 text-[12px] text-muted-foreground'>
              Everything attached to the chosen collections comes along, wrapped with a manifest
              (name, description, version) so the receiving instance can review it before install.
            </p>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder='Blueprint name, e.g. Procurement'
              className='mb-2 h-8 text-[13px]'
            />
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder='Description (optional)'
              className='mb-2 h-8 text-[13px]'
            />
            <Input
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              placeholder='Version, e.g. 1.0.0 (optional)'
              className='mb-2 h-8 w-[180px] text-[13px]'
            />
            <input
              type='text'
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder='Filter collections…'
              className='mb-2 h-8 w-full rounded-md border border-slate-200 px-2 text-[12px] focus:outline-none focus:ring-1 focus:ring-[#00ceff] dark:border-border dark:bg-background'
            />
            <div className='mb-3 max-h-56 overflow-y-auto rounded-md border border-slate-100 dark:border-border'>
              {filtered.map((c) => (
                <button
                  key={c.collection}
                  type='button'
                  onClick={() => toggle(c.collection)}
                  className='flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px] hover:bg-slate-50 dark:hover:bg-muted/50'
                >
                  <span
                    className={cn(
                      'flex h-3.5 w-3.5 items-center justify-center rounded border',
                      selected.has(c.collection)
                        ? 'border-[#00ceff] bg-[#00ceff] text-white'
                        : 'border-slate-300'
                    )}
                  >
                    {selected.has(c.collection) && <Check className='h-2.5 w-2.5' />}
                  </span>
                  <span className='truncate text-slate-700 dark:text-slate-300'>
                    {c.collection}
                  </span>
                </button>
              ))}
            </div>
            <Button
              size='sm'
              disabled={selected.size === 0 || !name.trim() || publishMut.isPending}
              onClick={() => publishMut.mutate()}
            >
              {publishMut.isPending ? (
                <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' />
              ) : (
                <Download className='mr-1.5 h-3.5 w-3.5' />
              )}
              Publish blueprint
            </Button>
          </section>

          {/* Install */}
          <section className='rounded-lg border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'>
            <h2 className='mb-1 text-[14px] font-semibold text-slate-900 dark:text-foreground'>
              Install from file
            </h2>
            <p className='mb-3 text-[12px] text-muted-foreground'>
              Load a blueprint or published package — you see its manifest and a diff against this
              instance before anything installs. Idempotent: existing pieces are skipped.
            </p>
            <input
              ref={fileRef}
              type='file'
              accept='.json'
              className='hidden'
              onChange={handleFile}
            />
            <Button size='sm' variant='outline' onClick={() => fileRef.current?.click()}>
              <FileUp className='mr-1.5 h-3.5 w-3.5' />
              {fileName || 'Choose blueprint file…'}
            </Button>

            {manifestMut.isPending && (
              <p className='mt-3 flex items-center gap-1.5 text-[12px] text-slate-500'>
                <Loader2 className='h-3 w-3 animate-spin' /> Reading manifest…
              </p>
            )}

            {artifact && preview && (
              <div className='mt-3 space-y-2'>
                {/* Manifest */}
                <div className='rounded-md bg-slate-50 p-2.5 text-[12px] text-slate-600 dark:bg-muted dark:text-slate-300'>
                  <p className='font-semibold'>
                    {preview.manifest.name}
                    {preview.manifest.version && (
                      <span className='ml-1.5 rounded bg-[#00ceff]/15 px-1.5 py-0.5 text-[10px] font-medium text-[#0088aa] dark:text-nvr-cyan'>
                        v{preview.manifest.version}
                      </span>
                    )}
                  </p>
                  {preview.manifest.description && (
                    <p className='mt-0.5 text-slate-500 dark:text-slate-400'>
                      {preview.manifest.description}
                    </p>
                  )}
                  <p className='mt-1'>
                    {preview.manifest.counts.collections} collections ·{' '}
                    {preview.manifest.counts.fields} fields · {preview.manifest.counts.workflows}{' '}
                    workflows · {preview.manifest.counts.layouts} layouts ·{' '}
                    {preview.manifest.counts.queues} queues · {preview.manifest.counts.rules} rules
                  </p>
                  <p className='mt-0.5 text-[11px] text-slate-400'>
                    Exported {new Date(preview.manifest.exported_at).toLocaleString()}
                    {preview.manifest.nivaro_version !== 'unknown' &&
                      ` · Nivaro ${preview.manifest.nivaro_version}`}
                    {!preview.wrapped && ' · bare blueprint (no manifest — synthesized)'}
                  </p>
                </div>

                {/* Diff vs this instance */}
                <div className='rounded-md border border-slate-100 p-2.5 text-[12px] dark:border-border'>
                  <p className='mb-1 text-[11px] font-medium uppercase tracking-wide text-slate-400'>
                    Against this instance
                  </p>
                  {preview.diff.collections.map((c) => (
                    <p key={c.collection} className='text-slate-600 dark:text-slate-300'>
                      <span className='font-mono'>{c.collection}</span>{' '}
                      {c.exists ? (
                        c.new_fields.length > 0 ? (
                          <span className='text-amber-600'>
                            exists — adds {c.new_fields.length} field(s):{' '}
                            {c.new_fields.slice(0, 6).join(', ')}
                            {c.new_fields.length > 6 && ` +${c.new_fields.length - 6} more`}
                          </span>
                        ) : (
                          <span className='text-slate-400'>exists — no field changes</span>
                        )
                      ) : (
                        <span className='text-green-600'>new collection</span>
                      )}
                    </p>
                  ))}
                  <p className='mt-1 text-slate-500'>
                    Workflows: {preview.diff.workflows.new} new / {preview.diff.workflows.existing}{' '}
                    existing · Layouts: {preview.diff.layouts.new} new /{' '}
                    {preview.diff.layouts.existing} existing · Queues: {preview.diff.queues.new} new
                    / {preview.diff.queues.existing} existing · Rules: {preview.diff.rules.new} new
                    / {preview.diff.rules.existing} existing
                  </p>
                </div>

                {report ? (
                  <div className='rounded-md bg-green-50 p-2.5 text-[12px] text-green-800 dark:bg-green-900/20 dark:text-green-300'>
                    {(['collections', 'workflows', 'layouts', 'queues', 'rules'] as const).map(
                      (k) => {
                        const r = report[k] as { created?: number; skipped?: number } | undefined
                        return (
                          <p key={k}>
                            {k}: {r?.created ?? 0} created, {r?.skipped ?? 0} skipped
                          </p>
                        )
                      }
                    )}
                    {Array.isArray(report.errors) && report.errors.length > 0 && (
                      <p className='text-red-600'>errors: {report.errors[0]}</p>
                    )}
                  </div>
                ) : (
                  <Button
                    size='sm'
                    disabled={installMut.isPending}
                    onClick={() => installMut.mutate()}
                  >
                    {installMut.isPending ? (
                      <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' />
                    ) : (
                      <Package className='mr-1.5 h-3.5 w-3.5' />
                    )}
                    Install into this instance
                  </Button>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
}
