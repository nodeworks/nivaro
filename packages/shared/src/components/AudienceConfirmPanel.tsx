import { cn } from '../lib/utils'

/**
 * Audience preview before sending (#3080). A save route of a config that sends to people
 * answers 409 AUDIENCE_CONFIRM_REQUIRED (with the preview) when the save reaches more than the
 * instance threshold, a whole role or everyone. Editors show this panel inline, beside their
 * Save button — never a modal — and save again with `confirm_audience: true`.
 */

export interface AudiencePreview {
  kind: string
  count: number
  sample: Array<{ id: string; name: string }>
  includes_roles: Array<{ id: string; name: string; members: number }>
  includes_everyone: boolean
  external_addresses: number
  over_threshold: boolean
  threshold: number
  active: boolean
  confirm_required: boolean
  notes: string[]
}

/** The preview carried by a 409 AUDIENCE_CONFIRM_REQUIRED (axios or SDK error), else null. */
export function audienceConfirmFromError(err: unknown): AudiencePreview | null {
  const e = err as {
    status?: number
    response?: { status?: number; data?: unknown; code?: string; audience?: unknown }
  } | null
  // axios: err.response = { status, data: body }; SDK client: err.status + err.response = body
  const body = (e?.response && 'data' in e.response ? e.response.data : e?.response) as
    | { code?: string; audience?: AudiencePreview }
    | undefined
  const status = e?.response?.status ?? e?.status
  if (status !== 409 || body?.code !== 'AUDIENCE_CONFIRM_REQUIRED' || !body.audience) return null
  return body.audience
}

export function audienceSummary(p: AudiencePreview): string {
  if (p.includes_everyone) return `Saving this tells everyone (${p.count} people).`
  const people = `${p.count} ${p.count === 1 ? 'person' : 'people'}`
  if (p.includes_roles.length > 0) {
    const roles = p.includes_roles.map((r) => r.name).join(', ')
    return `Saving this tells ${people}, including the whole ${roles} role${p.includes_roles.length > 1 ? 's' : ''}.`
  }
  return `Saving this tells ${people} — more than ${p.threshold}.`
}

export function AudienceConfirmPanel({
  preview,
  onConfirm,
  onCancel,
  busy = false,
  confirmLabel = 'Confirm and save',
  className
}: {
  preview: AudiencePreview
  onConfirm: () => void
  onCancel: () => void
  busy?: boolean
  confirmLabel?: string
  className?: string
}) {
  const more = Math.max(0, preview.count - preview.external_addresses - preview.sample.length)
  return (
    <div
      role='alert'
      data-audience-confirm
      className={cn(
        'rounded-lg border border-amber-200 bg-amber-50 px-3.5 py-3 text-[12.5px] text-amber-900 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-200',
        className
      )}
    >
      <p className='font-semibold'>{audienceSummary(preview)}</p>
      {preview.includes_roles.length > 0 && (
        <div className='mt-2 flex flex-wrap gap-1.5'>
          {preview.includes_roles.map((r) => (
            <span
              key={r.id}
              className='rounded-full border border-amber-300 bg-white px-2 py-0.5 text-[11.5px] font-medium text-amber-800 dark:border-amber-400/40 dark:bg-amber-400/10 dark:text-amber-200'
            >
              Whole role: {r.name} ({r.members})
            </span>
          ))}
        </div>
      )}
      {preview.sample.length > 0 && (
        <p className='mt-2 leading-relaxed text-amber-800 dark:text-amber-200/90'>
          {preview.sample.map((s) => s.name).join(', ')}
          {more > 0 && <span className='font-medium'> and {more} more</span>}
          {preview.external_addresses > 0 && (
            <span>
              {' '}
              (+ {preview.external_addresses} outside address
              {preview.external_addresses === 1 ? '' : 'es'})
            </span>
          )}
        </p>
      )}
      {preview.notes.length > 0 && (
        <ul className='mt-2 list-disc space-y-0.5 pl-4 text-[11.5px] text-amber-700 dark:text-amber-300/80'>
          {preview.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      <div className='mt-3 flex flex-wrap items-center gap-2'>
        <button
          type='button'
          disabled={busy}
          onClick={onConfirm}
          className='h-8 rounded-md bg-nvr-cyan px-3 text-[12.5px] font-medium text-white disabled:opacity-50'
        >
          {busy ? 'Saving…' : confirmLabel}
        </button>
        <button
          type='button'
          disabled={busy}
          onClick={onCancel}
          className='h-8 rounded-md border border-amber-300 bg-white px-3 text-[12.5px] font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-400/40 dark:bg-transparent dark:text-amber-200 dark:hover:bg-amber-400/15'
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
