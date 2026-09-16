import { useMutation, useQuery } from '@tanstack/react-query'
import { Circle, Copy, Download, FolderInput, Square, Trash2, Video } from 'lucide-react'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { api } from '@/lib/api'
import {
  addExpectStep,
  clearRecording,
  getRecorderState,
  type RecordedStep,
  removeStep,
  renderSpec,
  startRecording,
  stopRecording,
  subscribeRecorder
} from '@/lib/e2e-recorder'
import { cn } from '@/lib/utils'

/**
 * Golden-path e2e recorder (#73): press Record, walk the path through the
 * admin (the recorder follows you across routes — a badge in the sidebar
 * footer says it is still on), come back, review the steps, and save the
 * Playwright spec straight into an extension's tests/e2e dir (dev machines)
 * or download it.
 */

function describeStep(s: RecordedStep): string {
  switch (s.kind) {
    case 'goto':
      return `Open ${s.path}`
    case 'click':
      return `Click “${s.label}”`
    case 'fill':
      return `Type “${s.value.length > 30 ? `${s.value.slice(0, 27)}…` : s.value}” into ${s.label}`
    case 'press':
      return `Press ${s.key} in ${s.label}`
    case 'select':
      return `Select “${s.value}” in ${s.label}`
    case 'expect':
      return `Expect “${s.text}”`
  }
}

export function E2eRecorderPage() {
  const state = useSyncExternalStore(subscribeRecorder, getRecorderState, getRecorderState)
  const [name, setName] = useState('golden-path')
  const [title, setTitle] = useState('')
  const [extension, setExtension] = useState('')
  const [expectSel, setExpectSel] = useState('')
  const [expectText, setExpectText] = useState('')
  const origin = window.location.origin

  const { data: targets } = useQuery({
    queryKey: ['e2e-spec-targets'],
    queryFn: () =>
      api
        .get<{
          data: {
            writable: boolean
            targets: Array<{ extension: string; dir: string; specs: string[] }>
          }
        }>('/dev-tools/e2e-specs/targets')
        .then((r) => r.data.data),
    staleTime: 60_000
  })
  useEffect(() => {
    if (!extension && targets?.targets?.[0]) setExtension(targets.targets[0].extension)
  }, [targets, extension])

  const spec = useMemo(
    () => renderSpec({ name: name || 'golden-path', title, origin, steps: state.steps }),
    [name, title, origin, state.steps]
  )

  const save = useMutation({
    mutationFn: (overwrite: boolean) =>
      api
        .post<{ data: { path: string; run: string } }>('/dev-tools/e2e-specs', {
          extension,
          name,
          body: spec,
          overwrite
        })
        .then((r) => r.data.data),
    onSuccess: (d) => toast.success(`Saved ${d.path}`, { description: d.run, duration: 8000 }),
    onError: (err: { response?: { status?: number; data?: { error?: string } } }) => {
      const msg = err?.response?.data?.error ?? 'Save failed'
      if (err?.response?.status === 409) {
        toast.error(msg, {
          action: { label: 'Overwrite', onClick: () => save.mutate(true) },
          duration: 10000
        })
      } else toast.error(msg)
    }
  })

  const download = () => {
    const blob = new Blob([spec], { type: 'text/typescript' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${name || 'golden-path'}.spec.ts`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <div className='flex flex-1 min-h-0 flex-col' data-e2e-recorder>
      <header className='flex shrink-0 flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-6 py-4 dark:border-border dark:bg-card'>
        <Video className='h-4 w-4 text-nvr-navy dark:text-nvr-cyan' />
        <div>
          <h1 className='text-[15px] font-semibold text-slate-900 dark:text-foreground'>
            Golden-path recorder
          </h1>
          <p className='mt-0.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
            Record a click path through the admin, then save it as a Playwright spec. Passwords are
            never captured; the spec signs in with a static token.
          </p>
        </div>
        <div className='ml-auto flex items-center gap-2'>
          {state.recording ? (
            <Button size='sm' variant='destructive' onClick={() => stopRecording()} data-e2e-stop>
              <Square className='mr-1 h-3.5 w-3.5' /> Stop recording
            </Button>
          ) : (
            <Button size='sm' onClick={() => startRecording()} data-e2e-start>
              <Circle className='mr-1 h-3.5 w-3.5 fill-current text-red-500' /> Record
            </Button>
          )}
          {state.steps.length > 0 && !state.recording && (
            <Button size='sm' variant='outline' onClick={() => clearRecording()}>
              <Trash2 className='mr-1 h-3.5 w-3.5' /> Clear
            </Button>
          )}
        </div>
      </header>

      <div className='flex min-h-0 flex-1 overflow-hidden'>
        <aside className='flex w-[380px] shrink-0 flex-col border-r border-slate-200 bg-white dark:border-border dark:bg-card'>
          <div className='border-b border-slate-100 px-4 py-2.5 dark:border-border/60'>
            <p className='text-[11px] font-semibold uppercase tracking-wide text-slate-400'>
              Steps ({state.steps.length})
              {state.recording && (
                <span className='ml-2 inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-[10px] font-medium normal-case tracking-normal text-red-600 dark:bg-red-500/10 dark:text-red-300'>
                  <span className='h-1.5 w-1.5 animate-pulse rounded-full bg-red-500' /> recording —
                  walk the path, then come back
                </span>
              )}
            </p>
          </div>
          <ol className='flex-1 overflow-y-auto p-2' data-e2e-steps>
            {state.steps.length === 0 && (
              <li className='px-2 py-6 text-center text-[12px] text-slate-400'>
                {state.recording
                  ? 'Nothing recorded yet — open a page, click through the path.'
                  : 'Press Record, then use the admin as you normally would.'}
              </li>
            )}
            {state.steps.map((s, i) => (
              <li
                key={`${s.at}-${i}`}
                className='group flex items-start gap-2 rounded-md px-2 py-1.5 text-[12px] hover:bg-slate-50 dark:hover:bg-muted/50'
                data-e2e-step={s.kind}
              >
                <span className='mt-px w-5 shrink-0 text-right font-mono text-[10.5px] text-slate-400'>
                  {i + 1}
                </span>
                <span className='min-w-0 flex-1'>
                  <span className='block text-slate-800 dark:text-slate-100'>
                    {describeStep(s)}
                  </span>
                  {s.kind !== 'goto' && (
                    <span className='block truncate font-mono text-[10.5px] text-slate-400'>
                      {s.kind === 'click' && s.role
                        ? `getByRole(${s.role.role}, "${s.role.name}")`
                        : s.selector}
                    </span>
                  )}
                </span>
                <button
                  type='button'
                  onClick={() => removeStep(i)}
                  className='invisible shrink-0 text-slate-400 hover:text-red-500 group-hover:visible'
                  aria-label='Remove step'
                >
                  <Trash2 className='h-3.5 w-3.5' />
                </button>
              </li>
            ))}
          </ol>
          <div className='border-t border-slate-100 p-3 dark:border-border/60'>
            <p className='mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400'>
              Add an assertion
            </p>
            <div className='flex gap-1.5'>
              <Input
                value={expectSel}
                onChange={(e) => setExpectSel(e.target.value)}
                placeholder='selector, e.g. h1'
                className='h-7 flex-1 font-mono text-[11px]'
              />
              <Input
                value={expectText}
                onChange={(e) => setExpectText(e.target.value)}
                placeholder='contains text'
                className='h-7 flex-1 text-[11.5px]'
              />
              <Button
                size='sm'
                variant='outline'
                className='h-7'
                disabled={!expectSel.trim() || !expectText.trim()}
                onClick={() => {
                  addExpectStep(expectSel.trim(), expectText.trim())
                  setExpectText('')
                }}
              >
                Add
              </Button>
            </div>
          </div>
        </aside>

        <div className='flex min-w-0 flex-1 flex-col overflow-hidden bg-slate-50 dark:bg-background'>
          <div className='flex flex-wrap items-end gap-3 border-b border-slate-200 bg-white px-5 py-3 dark:border-border dark:bg-card'>
            <label className='text-[11.5px] text-slate-500'>
              Spec name
              <Input
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
                className='mt-0.5 h-8 w-48 font-mono text-[12px]'
                data-e2e-name
              />
            </label>
            <label className='text-[11.5px] text-slate-500'>
              Title
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder='what this path proves'
                className='mt-0.5 h-8 w-64 text-[12px]'
              />
            </label>
            <label className='text-[11.5px] text-slate-500'>
              Save into
              <select
                value={extension}
                onChange={(e) => setExtension(e.target.value)}
                className='mt-0.5 block h-8 rounded-md border border-slate-200 bg-white px-2 text-[12px] dark:border-border dark:bg-card'
                data-e2e-target
              >
                {(targets?.targets ?? []).map((t) => (
                  <option key={t.extension} value={t.extension}>
                    api/extensions/{t.extension}/tests/e2e ({t.specs.length})
                  </option>
                ))}
                {(targets?.targets?.length ?? 0) === 0 && (
                  <option value=''>No extensions on disk</option>
                )}
              </select>
            </label>
            <div className='ml-auto flex items-center gap-2'>
              <Button
                size='sm'
                variant='outline'
                onClick={() => {
                  void navigator.clipboard.writeText(spec)
                  toast.success('Spec copied')
                }}
                disabled={state.steps.length === 0}
              >
                <Copy className='mr-1 h-3.5 w-3.5' /> Copy
              </Button>
              <Button
                size='sm'
                variant='outline'
                onClick={download}
                disabled={state.steps.length === 0}
              >
                <Download className='mr-1 h-3.5 w-3.5' /> Download
              </Button>
              <Button
                size='sm'
                onClick={() => save.mutate(false)}
                disabled={
                  state.steps.length === 0 || !extension || !targets?.writable || save.isPending
                }
                title={
                  targets && !targets.writable
                    ? 'Saving into the source tree only works on a development machine — download instead'
                    : undefined
                }
                data-e2e-save
              >
                <FolderInput className='mr-1 h-3.5 w-3.5' /> Save to extension
              </Button>
            </div>
          </div>
          <pre
            className={cn(
              'flex-1 overflow-auto px-5 py-4 font-mono text-[11.5px] leading-relaxed text-slate-800 dark:text-slate-200',
              state.steps.length === 0 && 'opacity-50'
            )}
            data-e2e-spec
          >
            {spec}
          </pre>
        </div>
      </div>
    </div>
  )
}

export default E2eRecorderPage
