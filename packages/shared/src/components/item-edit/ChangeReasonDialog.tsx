import { MessageSquareWarning } from 'lucide-react'
import { useEffect, useState } from 'react'
import { titleCase } from '../../lib/utils'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'

/** Shape of the 422 CHANGE_REASON_REQUIRED challenge from the items service. */
export interface ChangeReasonChallenge {
  fields_changed: string[]
  reasons: string[]
  allow_free_text: boolean
}

/**
 * Extract a change-reason challenge from a failed save, or null when the
 * error is anything else. Works on SDK errors (parsed body on `.response`)
 * and axios-style errors (`.response.data`).
 */
export function changeReasonChallenge(err: unknown): ChangeReasonChallenge | null {
  const e = err as {
    response?: { data?: { code?: string; violations?: ChangeReasonChallenge }; code?: string; violations?: ChangeReasonChallenge }
  }
  const body = e?.response?.data ?? e?.response
  if (body?.code === 'CHANGE_REASON_REQUIRED' && body.violations) return body.violations
  return null
}

/**
 * Justification prompt shown when a save touches a change-reason-flagged
 * field. Preset reasons render as a pick list; free text is allowed unless the
 * collection's config disables it. Submitting retries the save with
 * `_change_reason` on the payload.
 */
export function ChangeReasonDialog({
  challenge,
  fieldLabel,
  onSubmit,
  onCancel
}: {
  challenge: ChangeReasonChallenge | null
  fieldLabel?: (field: string) => string
  onSubmit: (reason: string) => void
  onCancel: () => void
}) {
  const [picked, setPicked] = useState<string | null>(null)
  const [freeText, setFreeText] = useState('')

  useEffect(() => {
    if (challenge) {
      setPicked(null)
      setFreeText('')
    }
  }, [challenge])

  if (!challenge) return null
  const labels = challenge.fields_changed.map((f) => (fieldLabel ? fieldLabel(f) : titleCase(f)))
  const reason = [picked, freeText.trim()].filter(Boolean).join(' — ')
  const canSubmit = reason.length > 0

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onCancel() }}>
      <DialogContent className='max-w-md'>
        <DialogHeader>
          <DialogTitle className='flex items-center gap-2 text-[15px]'>
            <MessageSquareWarning className='h-4 w-4 text-amber-500' />
            Reason for change
          </DialogTitle>
        </DialogHeader>
        <p className='text-[12.5px] text-slate-600 dark:text-slate-300'>
          You changed {labels.length === 1 ? <b>{labels[0]}</b> : <b>{labels.join(', ')}</b>} — a short
          justification is required and will be recorded in the change history.
        </p>
        {challenge.reasons.length > 0 && (
          <div className='flex flex-col gap-1.5' data-nvr-change-reasons>
            {challenge.reasons.map((r) => (
              <button
                key={r}
                type='button'
                onClick={() => setPicked(picked === r ? null : r)}
                className={
                  picked === r
                    ? 'rounded-md border border-nvr-cyan bg-nvr-cyan/10 px-3 py-1.5 text-left text-[12.5px] font-medium text-slate-800 dark:text-slate-100'
                    : 'rounded-md border border-slate-200 px-3 py-1.5 text-left text-[12.5px] text-slate-600 hover:border-slate-300 hover:bg-slate-50 dark:border-border dark:text-slate-300 dark:hover:bg-white/5'
                }
              >
                {r}
              </button>
            ))}
          </div>
        )}
        {challenge.allow_free_text && (
          <textarea
            value={freeText}
            onChange={(e) => setFreeText(e.target.value)}
            rows={2}
            placeholder={challenge.reasons.length > 0 ? 'Additional detail (optional unless no reason selected)…' : 'Why is this changing?'}
            className='w-full resize-none rounded-md border border-slate-200 bg-white px-3 py-2 text-[12.5px] text-slate-800 outline-none focus:border-nvr-cyan dark:border-border dark:bg-card dark:text-slate-100'
          />
        )}
        <DialogFooter>
          <Button variant='outline' size='sm' onClick={onCancel}>
            Cancel
          </Button>
          <Button size='sm' disabled={!canSubmit} onClick={() => onSubmit(reason)}>
            Save with reason
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
