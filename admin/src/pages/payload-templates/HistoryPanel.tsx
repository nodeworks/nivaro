import { ArrowLeft, ChevronRight, RotateCcw } from 'lucide-react'
import { useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  type DraftBody,
  errorMessage,
  formatEt,
  publishedOf,
  sameBody,
  type TemplateDetail
} from './api'
import { usePayloadEditor } from './editor-context'
import {
  personName,
  usePeople,
  useRestoreVersion,
  useVersion,
  useVersions,
  type VersionSummary,
  versionBody
} from './panel-api'
import {
  Bars,
  BodyCompare,
  InlineError,
  OUTLINE_BTN,
  PanelFrame,
  SECTION_LABEL,
  Segmented,
  STRONG_BTN
} from './panel-parts'

/** What restoring `v` does to a draft in `draftMode`, in words (mode switches said out loud). */
export function restoreCopy(
  v: number,
  versionMode: DraftBody['mode'],
  draftMode: DraftBody['mode']
) {
  const base = `Your current draft is replaced by v${v}. Nothing goes live until you publish.`
  if (versionMode === draftMode) return base
  return versionMode === 'map'
    ? `${base} v${v} is a field map, so this payload switches back from Liquid to the field map.`
    : `${base} v${v} is Liquid, so the draft becomes Liquid and the field map goes away (restoring a field-map version brings it back).`
}

function VersionRow({
  v,
  live,
  who,
  onOpen
}: {
  v: VersionSummary
  live: boolean
  who: string | null
  onOpen: () => void
}) {
  return (
    <li>
      <button
        type='button'
        onClick={onOpen}
        className='flex w-full items-start gap-3 px-4 py-2.5 text-left hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan dark:hover:bg-muted dark:focus-visible:bg-muted'
        data-payload-version={v.version}
      >
        <span className='mt-px w-9 shrink-0 font-mono text-[12px] font-semibold text-slate-800 dark:text-slate-100'>
          v{v.version}
        </span>
        <span className='min-w-0 flex-1'>
          <span className='flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] text-slate-500 dark:text-muted-foreground'>
            {live && (
              <span className='rounded bg-emerald-50 px-1.5 py-px text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'>
                Live
              </span>
            )}
            {v.mode === 'code' && (
              <span className='rounded bg-slate-100 px-1.5 py-px text-[11px] font-medium text-slate-600 dark:bg-muted dark:text-muted-foreground'>
                Liquid
              </span>
            )}
            <span className='text-slate-700 dark:text-slate-200'>{who ?? 'Someone'}</span>
            <span aria-hidden>·</span>
            <span>{formatEt(v.published_at)}</span>
          </span>
          <span className='mt-0.5 line-clamp-2 block break-words text-[12.5px] text-slate-700 dark:text-slate-200'>
            {v.note || <span className='text-slate-400'>No note</span>}
          </span>
        </span>
        <ChevronRight className='mt-1 h-3.5 w-3.5 shrink-0 text-slate-300 dark:text-slate-600' />
      </button>
    </li>
  )
}

function VersionDetailView({
  template,
  summary,
  who,
  draft,
  recordId,
  onRecordChange,
  onBack,
  onRestored
}: {
  template: TemplateDetail
  summary: VersionSummary
  who: string | null
  draft: DraftBody
  recordId: string | null
  onRecordChange: (id: string) => void
  onBack: () => void
  onRestored: () => void
}) {
  const ctx = usePayloadEditor()
  const ctxRef = useRef(ctx)
  ctxRef.current = ctx
  const vq = useVersion(template.key, summary.version)
  const restore = useRestoreVersion(template.key)
  const live = publishedOf(template)
  const isLive = summary.version === template.published_version
  const [against, setAgainst] = useState<'draft' | 'live'>('draft')
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const body = vq.data ? versionBody(vq.data) : null
  const matchesDraft = body ? sameBody(body, draft) : false
  const compareTo = against === 'live' && live ? live : draft

  const doRestore = async () => {
    setError(null)
    try {
      // The restore replaces the draft on the server; a queued autosave would 409 against it.
      await ctxRef.current.discardPending()
      await restore.mutateAsync(summary.version)
      await ctxRef.current.adoptServerDraft()
      toast.success(`Restored v${summary.version} as the draft`, {
        description: 'Nothing goes live until you publish.'
      })
      onRestored()
    } catch (e) {
      setError(errorMessage(e, `v${summary.version} was not restored`))
    }
  }

  return (
    <div className='space-y-3 px-4 py-3'>
      <button
        type='button'
        onClick={onBack}
        className='inline-flex items-center gap-1 text-[12px] font-medium text-slate-500 hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-muted-foreground dark:hover:text-foreground'
      >
        <ArrowLeft className='h-3 w-3' />
        All versions
      </button>
      <div>
        <p className='flex flex-wrap items-center gap-x-1.5 text-[13px] text-slate-900 dark:text-foreground'>
          <span className='font-mono font-semibold'>v{summary.version}</span>
          {isLive && (
            <span className='rounded bg-emerald-50 px-1.5 py-px text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300'>
              Live
            </span>
          )}
          <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
            {who ?? 'Someone'} · {formatEt(summary.published_at)}
            {summary.mode === 'code' ? ' · Liquid' : ' · Field map'}
          </span>
        </p>
        <p className='mt-1 whitespace-pre-wrap break-words text-[12.5px] text-slate-700 dark:text-slate-200'>
          {summary.note || 'No note'}
        </p>
      </div>

      {vq.isError ? (
        <InlineError
          title={`v${summary.version} could not load.`}
          error={vq.error}
          onRetry={() => void vq.refetch()}
        />
      ) : !body ? (
        <Bars />
      ) : (
        <>
          <div className='flex flex-wrap items-center gap-2'>
            <span className={SECTION_LABEL}>Compare with</span>
            <Segmented
              legend='Compare with'
              value={against}
              onChange={setAgainst}
              options={[
                { value: 'draft', label: 'Your draft' },
                {
                  value: 'live',
                  label: `Live v${template.published_version ?? ''}`,
                  off: !live ? 'Nothing is live' : isLive ? 'This is the live version' : undefined
                }
              ]}
            />
          </div>
          <BodyCompare
            templateKey={template.key}
            collection={template.collection}
            recordId={recordId}
            onRecordChange={onRecordChange}
            before={{
              label:
                against === 'live' && live ? `live v${template.published_version}` : 'your draft',
              body: compareTo
            }}
            after={{ label: `v${summary.version}`, body }}
            sameText={{
              payload: `v${summary.version} sends the same body as ${against === 'live' ? 'live' : 'your draft'} for this record.`,
              template: `v${summary.version} is the same template as ${against === 'live' ? 'live' : 'your draft'}.`
            }}
          />

          {confirming ? (
            <div
              className='space-y-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5 dark:border-border dark:bg-muted/40'
              data-payload-restore-confirm
            >
              <p className='text-[12.5px] font-medium text-slate-900 dark:text-foreground'>
                Restore v{summary.version} as the draft?
              </p>
              <p className='text-[12.5px] text-slate-600 dark:text-slate-300'>
                {restoreCopy(summary.version, body.mode, draft.mode)}
                {template.published_version != null && live && !sameBody(draft, live)
                  ? ' Your unpublished changes are not kept as a version.'
                  : ''}
              </p>
              {error && (
                <p className='text-[12px] text-red-700 dark:text-red-300' role='alert'>
                  {error}
                </p>
              )}
              <div className='flex flex-wrap gap-2'>
                <button
                  type='button'
                  onClick={() => void doRestore()}
                  disabled={restore.isPending}
                  className={STRONG_BTN}
                  data-payload-restore-go
                >
                  <RotateCcw className='h-3.5 w-3.5' />
                  {restore.isPending ? 'Restoring…' : `Restore v${summary.version}`}
                </button>
                <button
                  type='button'
                  onClick={() => setConfirming(false)}
                  disabled={restore.isPending}
                  className={OUTLINE_BTN}
                >
                  Keep my draft
                </button>
              </div>
            </div>
          ) : (
            <span
              data-tip={matchesDraft ? `The draft already matches v${summary.version}` : undefined}
            >
              <button
                type='button'
                onClick={() => setConfirming(true)}
                disabled={matchesDraft}
                className={OUTLINE_BTN}
                data-payload-restore
              >
                <RotateCcw className='h-3.5 w-3.5 text-slate-400' />
                Restore as draft
              </button>
            </span>
          )}
        </>
      )}
    </div>
  )
}

/**
 * History: every published version (vN · who · 9:45 PM ET · note), newest
 * first → one version's payload diff → Restore as draft.
 */
export function HistoryPanel({
  template,
  draft,
  recordId,
  onRecordChange,
  onOpenDefault,
  onClose
}: {
  template: TemplateDetail
  draft: DraftBody
  recordId: string | null
  onRecordChange: (id: string) => void
  onOpenDefault: () => void
  onClose: () => void
}) {
  const q = useVersions(template.key)
  const versions = q.data ?? []
  const people = usePeople(versions.filter((v) => !v.published_by_name).map((v) => v.published_by))
  const [selected, setSelected] = useState<number | null>(null)
  const summary = versions.find((v) => v.version === selected) ?? null
  const whoOf = (v: VersionSummary) => personName(people.data, v.published_by, v.published_by_name)

  return (
    <PanelFrame title='History' panel='history' onClose={onClose}>
      {summary ? (
        <VersionDetailView
          template={template}
          summary={summary}
          who={whoOf(summary)}
          draft={draft}
          recordId={recordId}
          onRecordChange={onRecordChange}
          onBack={() => setSelected(null)}
          onRestored={onClose}
        />
      ) : q.isLoading ? (
        <div className='px-4 py-3'>
          <Bars rows={[60, 80, 50, 70, 55]} />
        </div>
      ) : q.isError ? (
        <div className='px-4 py-3'>
          <InlineError
            title='History could not load.'
            error={q.error}
            onRetry={() => void q.refetch()}
          />
        </div>
      ) : (
        <>
          {versions.length === 0 ? (
            <p className='px-4 py-4 text-[12.5px] text-slate-500 dark:text-muted-foreground'>
              Nothing published yet. Each publish adds a version here with its note, and any version
              can be restored as the draft.
            </p>
          ) : (
            <ul className='divide-y divide-slate-100 dark:divide-border' data-payload-versions>
              {versions.map((v) => (
                <VersionRow
                  key={v.version}
                  v={v}
                  live={v.version === template.published_version}
                  who={whoOf(v)}
                  onOpen={() => setSelected(v.version)}
                />
              ))}
            </ul>
          )}
          {template.owner && (
            <p className='border-t border-slate-200 px-4 py-3 text-[12px] text-slate-500 dark:border-border dark:text-muted-foreground'>
              {template.owner} also ships a file default for this payload.{' '}
              <button
                type='button'
                onClick={onOpenDefault}
                className='font-medium text-slate-800 underline underline-offset-2 dark:text-foreground'
              >
                Reset to file default
              </button>
            </p>
          )}
        </>
      )}
    </PanelFrame>
  )
}
