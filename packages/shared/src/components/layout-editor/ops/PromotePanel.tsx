import { useQueryClient } from '@tanstack/react-query'
import { Download, Loader2, Minus, Pencil, Plus, Shuffle, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../../context'
import { cn } from '../../../lib/utils'
import { apiFailure } from '../overview/overview-api'
import { layoutDraftKeys } from '../useLayoutDraft'
import {
  applyPromotion,
  downloadLayout,
  type PromoteChange,
  type PromoteFrom,
  type PromotePreview,
  previewPromotion,
  trimUploadedFile,
  usePromoteSources
} from './ops-api'

/**
 * Compare one layout with another environment's copy and bring it here
 * (#2593). Pull only: the other copy is read (by this server, with the
 * registry's token) or uploaded as a file; nothing is sent from here. Apply
 * saves a version of this layout first — History → Restore undoes it.
 */

const chip =
  'inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-full border px-2.5 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50'
const chipOff =
  'border-slate-200 bg-white text-slate-700 hover:border-slate-300 dark:border-border dark:bg-card dark:text-foreground dark:hover:bg-muted'
const chipOn = 'border-nvr-cyan/60 bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
const btn =
  'inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-md border border-slate-200 bg-white px-2 text-[12px] font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-50 dark:border-border dark:bg-card dark:text-foreground dark:hover:bg-muted'
const btnSolid =
  'inline-flex h-7 items-center gap-1 whitespace-nowrap rounded-md bg-nvr-cyan px-2.5 text-[12px] font-semibold text-white hover:opacity-90 disabled:opacity-50'

const KIND_TITLE: Record<PromoteChange['kind'], string> = {
  setting: 'Settings',
  section: 'Sections and tabs',
  field: 'Fields',
  order: 'Order'
}

function ChangeIcon({ c }: { c: PromoteChange }) {
  const cls = 'mt-[3px] h-3 w-3 shrink-0'
  if (c.kind === 'order') return <Shuffle className={cls} />
  if (c.action === 'add')
    return <Plus className={cn(cls, 'text-emerald-600 dark:text-emerald-400')} />
  if (c.action === 'remove') return <Minus className={cn(cls, 'text-red-600 dark:text-red-400')} />
  return <Pencil className={cls} />
}

const show = (v: unknown) => {
  if (v == null || v === '') return 'empty'
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 60)
  return String(v)
}

export function PromotePanel({
  layoutId,
  layoutName,
  onApplied,
  className
}: {
  layoutId: number
  layoutName: string
  onApplied?: () => void
  className?: string
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const sources = usePromoteSources()
  const fileInput = useRef<HTMLInputElement>(null)
  const [from, setFrom] = useState<{ key: string; body: PromoteFrom; label: string } | null>(null)
  const [remoteId, setRemoteId] = useState<number | null>(null)
  const [preview, setPreview] = useState<PromotePreview | null>(null)
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const compare = async (
    next: { key: string; body: PromoteFrom; label: string },
    rid?: number | null
  ) => {
    setFrom(next)
    setRemoteId(rid ?? null)
    setPreview(null)
    setConfirming(false)
    setError(null)
    setBusy('preview')
    try {
      setPreview(await previewPromotion(client, layoutId, next.body, rid ?? null))
    } catch (err) {
      setError(apiFailure(err, 'Could not compare').message)
    } finally {
      setBusy(null)
    }
  }

  const pickFile = async (f: File | undefined) => {
    if (!f) return
    try {
      const body = trimUploadedFile(await f.text())
      void compare({ key: `file:${f.name}`, body: { file: body }, label: f.name })
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const apply = async () => {
    if (!from || !preview) return
    setBusy('apply')
    setError(null)
    try {
      const r = await applyPromotion(client, layoutId, from.body, preview.base_rev, remoteId)
      toast.success(
        r.applied
          ? `Brought over from ${preview.source.label}. History has the version from before.`
          : 'Already the same'
      )
      void qc.invalidateQueries({ queryKey: layoutDraftKeys.bundle(layoutId) })
      void qc.invalidateQueries({ queryKey: layoutDraftKeys.versions(layoutId) })
      void qc.invalidateQueries({ queryKey: ['layout-editor', 'overview'] })
      setConfirming(false)
      setPreview(null)
      setFrom(null)
      onApplied?.()
    } catch (err) {
      const f = apiFailure(err, 'Could not apply')
      setError(f.message)
      setConfirming(false)
    } finally {
      setBusy(null)
    }
  }

  const changes = preview?.plan?.changes ?? []
  const real = changes.filter((c) => c.action !== 'skip')
  const skipped = changes.filter((c) => c.action === 'skip')
  const groups = (['setting', 'section', 'field', 'order'] as const)
    .map((k) => ({ k, list: real.filter((c) => c.kind === k) }))
    .filter((g) => g.list.length)

  return (
    <div className={cn('space-y-3 text-[12.5px]', className)} data-promote-panel={layoutId}>
      <div>
        <p className='font-semibold text-slate-900 dark:text-foreground'>
          Compare with another environment
        </p>
        <p className='mt-0.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
          Reads that environment’s copy of this layout and shows what would change here. Nothing is
          sent from here.
        </p>
      </div>

      <div className='flex flex-wrap items-center gap-1.5' data-promote-sources>
        {sources.isLoading && <Loader2 className='h-3.5 w-3.5 animate-spin text-slate-400' />}
        {(sources.data ?? []).map((s) => {
          const key = `env:${s.id}`
          return (
            <button
              key={s.id}
              type='button'
              disabled={!s.has_token || busy != null}
              data-tip={
                s.has_token ? undefined : 'Add an API token to this component on Environments'
              }
              data-promote-source={s.id}
              aria-pressed={from?.key === key}
              onClick={() =>
                void compare({
                  key,
                  body: { component_id: s.id },
                  label: `${s.environment ?? 'Environment'} · ${s.name}`
                })
              }
              className={cn(chip, from?.key === key ? chipOn : chipOff)}
            >
              {s.environment ? `${s.environment} · ${s.name}` : s.name}
            </button>
          )
        })}
        <button
          type='button'
          className={cn(chip, from?.key.startsWith('file:') ? chipOn : chipOff)}
          disabled={busy != null}
          onClick={() => fileInput.current?.click()}
          data-promote-upload
        >
          <Upload className='h-3 w-3' />
          {from?.key.startsWith('file:') ? from.label : 'Upload a file…'}
        </button>
        <input
          ref={fileInput}
          type='file'
          accept='.json,application/json'
          className='hidden'
          onChange={(e) => {
            void pickFile(e.target.files?.[0])
            e.target.value = ''
          }}
        />
      </div>
      {!sources.isLoading && (sources.data ?? []).length === 0 && (
        <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          No other environment is registered with an API address. Upload a layout file or a Config
          Diff snapshot instead.
        </p>
      )}
      <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
        For an environment that cannot reach this one:{' '}
        <button
          type='button'
          className='inline-flex items-center gap-1 font-medium text-[#0089ad] hover:underline dark:text-nvr-cyan'
          onClick={() =>
            void downloadLayout(client, layoutId, layoutName).catch((err) =>
              toast.error(apiFailure(err, 'Could not download').message)
            )
          }
          data-promote-download
        >
          <Download className='h-3 w-3' />
          download this layout
        </button>{' '}
        and upload it there.
      </p>

      {busy === 'preview' && (
        <p className='flex items-center gap-1.5 text-slate-500 dark:text-muted-foreground'>
          <Loader2 className='h-3.5 w-3.5 animate-spin' />
          Comparing…
        </p>
      )}
      {error && (
        <p className='text-[12px] text-red-600 dark:text-red-400' role='alert'>
          {error}
        </p>
      )}

      {preview && !preview.theirs && from && (
        <div data-promote-nomatch className='space-y-1.5'>
          <p className='text-slate-700 dark:text-foreground'>
            {preview.source.label} has no layout with this link name or name. Pick the one to
            compare with:
          </p>
          <div className='flex flex-wrap gap-1.5'>
            {preview.candidates.length === 0 && (
              <span className='text-slate-500 dark:text-muted-foreground'>
                It has no layouts for this collection.
              </span>
            )}
            {preview.candidates.map((c) => (
              <button
                key={c.id}
                type='button'
                className={cn(chip, chipOff)}
                onClick={() => void compare(from, c.id)}
              >
                {c.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {preview?.theirs && preview.plan && (
        <div
          className='space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-border dark:bg-background'
          data-promote-diff
        >
          <p className='text-slate-700 dark:text-foreground'>
            <span className='font-semibold'>“{preview.theirs.name}”</span> in {preview.source.label}
            {preview.source.version ? ` (${preview.source.version})` : ''}
            {preview.candidates.length > 1 && (
              <>
                {' · '}
                <span className='text-slate-500 dark:text-muted-foreground'>compare with </span>
                {preview.candidates
                  .filter((c) => c.id !== preview.theirs?.id)
                  .slice(0, 6)
                  .map((c, i) => (
                    <span key={c.id}>
                      {i > 0 ? ', ' : ''}
                      <button
                        type='button'
                        className='text-[#0089ad] hover:underline dark:text-nvr-cyan'
                        onClick={() => from && void compare(from, c.id)}
                      >
                        {c.name}
                      </button>
                    </span>
                  ))}
              </>
            )}
          </p>
          {real.length === 0 ? (
            <p className='text-slate-600 dark:text-muted-foreground' data-promote-same>
              The same as here — nothing to bring over.
            </p>
          ) : (
            groups.map((g) => (
              <div key={g.k}>
                <p className='mb-0.5 text-[11.5px] font-medium text-slate-500 dark:text-muted-foreground'>
                  {KIND_TITLE[g.k]} · {g.list.length}
                </p>
                <ul className='space-y-0.5'>
                  {g.list.slice(0, 40).map((c, i) => (
                    <li
                      key={`${c.kind}:${c.target}:${c.where ?? ''}:${i}`}
                      className='flex items-start gap-1.5 text-slate-700 dark:text-foreground'
                    >
                      <ChangeIcon c={c} />
                      <span className='min-w-0 break-words'>
                        {c.kind === 'setting' ? (
                          <>
                            <code className='font-mono text-[11.5px]'>{c.target}</code>:{' '}
                            <span className='text-slate-500 dark:text-muted-foreground'>
                              {show(c.from)}
                            </span>
                            {' → '}
                            {show(c.to)}
                          </>
                        ) : (
                          c.text
                        )}
                      </span>
                    </li>
                  ))}
                  {g.list.length > 40 && (
                    <li className='text-slate-500 dark:text-muted-foreground'>
                      and {g.list.length - 40} more
                    </li>
                  )}
                </ul>
              </div>
            ))
          )}
          {skipped.length > 0 && (
            <div
              className='rounded-md border border-amber-300 bg-amber-50 p-2 text-[12px] text-amber-900 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-200'
              data-promote-skipped
            >
              {skipped.map((c, i) => (
                <p key={`${c.target}:${i}`}>
                  {c.kind === 'setting' ? <code className='font-mono'>{c.target}</code> : null}
                  {c.kind === 'setting' ? ' — ' : ''}
                  {c.text}
                </p>
              ))}
            </div>
          )}
          <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            Which layout is the default, and its place in the list, stay as they are here.
          </p>
          {real.length > 0 &&
            (confirming ? (
              <div className='flex flex-wrap items-center gap-2' data-promote-confirm>
                <span className='text-slate-700 dark:text-foreground'>
                  Save a version of this layout, then apply {real.length}{' '}
                  {real.length === 1 ? 'change' : 'changes'}? History → Restore undoes it.
                </span>
                <button
                  type='button'
                  className={btnSolid}
                  disabled={busy != null}
                  onClick={() => void apply()}
                  data-promote-apply-confirm
                >
                  {busy === 'apply' && <Loader2 className='h-3 w-3 animate-spin' />}
                  Apply here
                </button>
                <button type='button' className={btn} onClick={() => setConfirming(false)}>
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type='button'
                className={btnSolid}
                onClick={() => setConfirming(true)}
                data-promote-apply
              >
                Apply here…
              </button>
            ))}
        </div>
      )}
    </div>
  )
}
