import { Check, Copy } from 'lucide-react'
import { useId, useState } from 'react'
import { SimpleSelect } from '../ui/SimpleSelect'
import { useCreateKioskLink, useKioskLinks, useRevokeKioskLink } from './board-prefs'
import { formatAge } from './freshness'
import { useCc } from './state'
import { BUTTON, FAINT, FOCUS, MUTED } from './theme'
import type { KioskLink } from './types'

/**
 * Wallboard links (CC-23, administrators): a signed link that shows this board read-only in TV
 * mode on a screen nobody signs in to. It reads as the person who made it, works until its
 * expiry (at most 90 days) and stops at once when revoked or when its maker can no longer use
 * the board. The address is shown once — it is stored scrambled.
 */

const H3 = 'text-[13px] font-semibold text-[var(--cc-strong)]'
const INPUT =
  'h-8 w-full rounded-md border border-[var(--cc-border)] bg-[var(--cc-panel)] px-2.5 text-[12.5px] text-[var(--cc-text)] placeholder:text-[var(--cc-faint)]'

function expiryText(l: KioskLink, now: number): string {
  if (l.expired || !l.expires_at) return 'Expired'
  const days = Math.ceil((new Date(l.expires_at).getTime() - now) / 86_400_000)
  return days <= 1 ? 'Expires today' : `Expires in ${days} days`
}

function CopyField({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)
  const id = useId()
  return (
    <div className='space-y-1.5 rounded-md border border-nvr-cyan/40 bg-[var(--cc-chip)] p-2.5'>
      <label htmlFor={id} className='block text-[12px] font-medium text-[var(--cc-text)]'>
        Copy this address now — it won’t be shown again
      </label>
      <div className='flex items-center gap-2'>
        <input
          id={id}
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          className={`${INPUT} font-mono text-[11.5px] ${FOCUS}`}
        />
        <button
          type='button'
          className={`${BUTTON} inline-flex shrink-0 items-center gap-1 ${FOCUS}`}
          onClick={() => {
            void navigator.clipboard?.writeText(url).then(
              () => setCopied(true),
              () => setCopied(false)
            )
          }}
        >
          {copied ? (
            <Check className='h-3.5 w-3.5' aria-hidden />
          ) : (
            <Copy className='h-3.5 w-3.5' aria-hidden />
          )}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  )
}

export function KioskLinks() {
  const cc = useCc()
  const links = useKioskLinks(cc.isAdmin)
  const create = useCreateKioskLink()
  const revoke = useRevokeKioskLink()
  const [label, setLabel] = useState('')
  const [days, setDays] = useState('30')
  const [region, setRegion] = useState('')
  const [made, setMade] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const labelId = useId()
  const now = Date.now()
  const regions = cc.config?.regions ?? []
  const regionLabel = (id: string | null | undefined) =>
    id ? (regions.find((r) => r.id === id)?.label ?? 'A region') : 'Everywhere'

  const submit = () => {
    if (!label.trim()) return
    create.mutate(
      {
        label: label.trim(),
        expires_in_days: Number(days),
        region: region || null,
        map_collection: cc.mapCollection
      },
      {
        onSuccess: (l) => {
          setMade(`${window.location.origin}${l.url}`)
          setLabel('')
        }
      }
    )
  }

  return (
    <section
      className='space-y-2 border-t border-[var(--cc-border)] pt-4'
      aria-labelledby={`${labelId}-h`}
    >
      <h3 id={`${labelId}-h`} className={H3}>
        Wallboard links
      </h3>
      <p className={`text-[12px] ${MUTED}`}>
        Show this board on a screen without signing in. The screen sees what you can see, read only,
        in TV mode.
      </p>
      <form
        className='space-y-2'
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <label htmlFor={labelId} className='sr-only'>
          Which screen is this link for
        </label>
        <input
          id={labelId}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder='Which screen? e.g. Dispatch wall'
          maxLength={80}
          className={`${INPUT} ${FOCUS}`}
        />
        <div className='grid grid-cols-2 gap-2'>
          <SimpleSelect
            ariaLabel='How long the link works'
            value={days}
            onChange={setDays}
            className='h-8 text-[12.5px]'
            options={[
              { value: '1', label: 'Works for 1 day' },
              { value: '7', label: 'Works for 7 days' },
              { value: '30', label: 'Works for 30 days' },
              { value: '90', label: 'Works for 90 days' }
            ]}
          />
          <SimpleSelect
            ariaLabel='Region the screen shows'
            value={region}
            onChange={setRegion}
            className='h-8 text-[12.5px]'
            options={[
              { value: '', label: 'Everywhere' },
              ...regions.map((r) => ({ value: r.id, label: r.label }))
            ]}
          />
        </div>
        <div className='flex justify-end'>
          <button
            type='submit'
            disabled={!label.trim() || create.isPending}
            className={`rounded-md bg-nvr-cyan px-2.5 py-1 text-[11.5px] font-medium text-white disabled:opacity-50 ${FOCUS}`}
          >
            {create.isPending ? 'Making the link…' : 'Make a link'}
          </button>
        </div>
        {create.isError && (
          <p role='alert' className='text-[12px] text-[var(--cc-bad-text)]'>
            Couldn’t make the link. Try again.
          </p>
        )}
      </form>
      {made && <CopyField url={made} />}
      {(links.data ?? []).length > 0 && (
        <ul className='divide-y divide-[var(--cc-border)] rounded-md border border-[var(--cc-border)]'>
          {(links.data ?? []).map((l) => (
            <li key={l.id} className='flex items-center gap-2 px-2.5 py-2'>
              <div className='min-w-0 flex-1'>
                <p className='truncate text-[12.5px] font-medium text-[var(--cc-text)]'>
                  {l.label}
                </p>
                <p
                  className={`truncate text-[11.5px] ${l.expired ? 'text-[var(--cc-warn-text)]' : FAINT}`}
                >
                  {[
                    regionLabel(l.region),
                    expiryText(l, now),
                    l.created_by_name ? `made by ${l.created_by_name}` : null,
                    // A screen showing the link checks in every few minutes.
                    l.last_viewed_at
                      ? `last on screen ${formatAge(now - new Date(l.last_viewed_at).getTime())}`
                      : 'not opened yet'
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
              {confirming === l.id ? (
                <>
                  <button
                    type='button'
                    className={`${BUTTON} ${FOCUS}`}
                    onClick={() => setConfirming(null)}
                  >
                    Keep
                  </button>
                  <button
                    type='button'
                    className={`rounded-md bg-[var(--cc-bad-bg)] px-2.5 py-1 text-[11.5px] font-medium text-[var(--cc-bad-text)] ${FOCUS}`}
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(l.id, { onSettled: () => setConfirming(null) })}
                  >
                    Turn off
                  </button>
                </>
              ) : (
                <button
                  type='button'
                  className={`${BUTTON} ${FOCUS}`}
                  aria-label={`Turn off the link for ${l.label}`}
                  onClick={() => setConfirming(l.id)}
                >
                  Turn off
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {links.isError && (
        <p className={`text-[12px] ${FAINT}`}>Couldn’t load the wallboard links.</p>
      )}
    </section>
  )
}
