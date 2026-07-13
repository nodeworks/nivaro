import { useMutation, useQuery } from '@tanstack/react-query'
import { Check, Download, FileUp, Loader2, Package } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'

type InstallReport = Record<string, { created?: number; skipped?: number } | string[] | number>

interface BlueprintArtifact {
  type: string
  name: string
  collections: unknown[]
  relations: unknown[]
  workflows: unknown[]
  layouts: unknown[]
  queues: unknown[]
  rules: unknown[]
}

export function BlueprintsPage() {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [name, setName] = useState('')
  const [artifact, setArtifact] = useState<BlueprintArtifact | null>(null)
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

  const exportMut = useMutation({
    mutationFn: () =>
      api
        .post<{ data: BlueprintArtifact }>('/blueprints/export', {
          name: name.trim(),
          collections: [...selected]
        })
        .then((r) => r.data.data),
    onSuccess: (data) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `${data.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.blueprint.json`
      a.click()
      URL.revokeObjectURL(a.href)
      toast.success('Blueprint downloaded')
    },
    onError: (err: unknown) => {
      const msg = (err as { response?: { data?: { error?: string } } })?.response?.data?.error
      toast.error(msg ?? 'Export failed')
    }
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
        if (parsed?.type !== 'nivaro-blueprint') {
          toast.error('Not a Nivaro blueprint')
          return
        }
        setArtifact(parsed)
        setFileName(f.name)
        installMut.reset()
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
          {/* Export */}
          <section className='rounded-lg border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'>
            <h2 className='mb-1 text-[14px] font-semibold text-slate-900 dark:text-foreground'>
              Export blueprint
            </h2>
            <p className='mb-3 text-[12px] text-muted-foreground'>
              Everything attached to the chosen collections comes along: fields, relations, bound
              workflows, layouts, queues built on them, and automation rules.
            </p>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder='Blueprint name, e.g. Procurement'
              className='mb-2 h-8 text-[13px]'
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
              disabled={selected.size === 0 || !name.trim() || exportMut.isPending}
              onClick={() => exportMut.mutate()}
            >
              {exportMut.isPending ? (
                <Loader2 className='mr-1.5 h-3.5 w-3.5 animate-spin' />
              ) : (
                <Download className='mr-1.5 h-3.5 w-3.5' />
              )}
              Export blueprint
            </Button>
          </section>

          {/* Install */}
          <section className='rounded-lg border border-slate-200 bg-white p-5 dark:border-border dark:bg-card'>
            <h2 className='mb-1 text-[14px] font-semibold text-slate-900 dark:text-foreground'>
              Install blueprint
            </h2>
            <p className='mb-3 text-[12px] text-muted-foreground'>
              Idempotent: existing collections, workflows, layouts and queues are skipped; missing
              tables and columns are created.
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

            {artifact && (
              <div className='mt-3 space-y-2'>
                <div className='rounded-md bg-slate-50 p-2.5 text-[12px] text-slate-600 dark:bg-muted dark:text-slate-300'>
                  <p className='font-semibold'>{artifact.name}</p>
                  <p>
                    {artifact.collections.length} collections · {artifact.workflows.length}{' '}
                    workflows · {artifact.layouts.length} layouts · {artifact.queues.length} queues
                    · {artifact.rules.length} rules
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
