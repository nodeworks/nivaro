import { isValidElement } from 'react'
import { toast } from 'sonner'
import { openSupportForError, runErrorAction } from './error-actions'
import { STATUS_HINTS } from './error-hints'
import { copyErrorDetails, describeError, type ErrorDescription } from './error-message'
import { isRawErrorText, plainErrorText, statusInText } from './safe-error'

interface ToastErrorOpts {
  /** What the person was doing ("Save record"), for the support copy. */
  action?: string
  /** Send it again: makes "Try again" the toast's button. */
  retry?: () => void
}

type ToastButton = { label: string; onClick: () => void }

/**
 * The one button a failed action's toast offers: the reading's own action
 * when a toast can run it (Try again needs the caller's retry; Sign in again;
 * Reload after someone else's change; Ask for access / Get help open Support
 * with the reference filled in), else "Copy details" when there is a
 * reference for support. Nothing for a refusal the person fixes in the form.
 */
function toastButton(d: ErrorDescription, opts: ToastErrorOpts): ToastButton | undefined {
  const a = d.action
  if (a?.kind === 'retry' && opts.retry) return { label: a.label, onClick: () => opts.retry?.() }
  if (a && (a.kind === 'sign-in' || a.kind === 'contact'))
    return { label: a.label, onClick: () => runErrorAction(a.kind, d, opts) }
  if (a?.kind === 'reload' && d.kind !== 'bug')
    return { label: a.label, onClick: () => runErrorAction('reload', d, opts) }
  // Something broke on our side and trying again is up to the person: help is one click away.
  if (d.kind === 'server' || d.kind === 'bug' || (d.kind === 'unknown' && d.action))
    return {
      label: 'Get help',
      onClick: () => openSupportForError(d, { action: opts.action })
    }
  if (d.requestId)
    return {
      label: 'Copy details',
      onClick: () => {
        void copyErrorDetails(d, opts).then((ok) =>
          ok ? toast.success('Details copied') : toast.error('Could not copy the details')
        )
      }
    }
  return undefined
}

/**
 * Toast options for a failed request: the hint as the description and the
 * one button that helps — for `toast.error(userErrorMessage(err, …),
 * errorToastOptions(err))` where the title is already chosen, or through
 * `toastError` below.
 */
export function errorToastOptions(
  input: unknown,
  opts: ToastErrorOpts = {}
): {
  description?: string
  action?: ToastButton
} {
  const d = isDescribed(input) ? input : describeError(input)
  const button = toastButton(d, opts)
  return {
    ...(d.hint ? { description: d.hint } : {}),
    ...(button ? { action: button } : {})
  }
}

/** One error toast: what happened, what to do, and the one button. Returns the reading. */
export function toastError(
  err: unknown,
  fallback?: string,
  opts: ToastErrorOpts = {}
): ErrorDescription {
  const d = describeError(err, fallback)
  toast.error(d.title, errorToastOptions(d, opts))
  return d
}

function isDescribed(v: unknown): v is ErrorDescription {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as { title?: unknown }).title === 'string' &&
    !(v instanceof Error) &&
    !('response' in (v as object))
  )
}

let guarded = false

/**
 * The last line of defence (installed once by the host at boot): an error
 * toast whose title or description is raw — "Request failed with status code
 * 500", "HTTP 403", SQL, a stack, a driver or JavaScript error, an internal
 * id — shows what it means instead, with the status's hint. An Error object
 * handed straight to `toast.error` is read through `describeError`. Plain
 * sentences pass through untouched. Call sites should still say it well
 * (`toastError`); this only makes sure nothing raw ever reaches a person.
 */
export function guardErrorToasts(target: { error: typeof toast.error } = toast): void {
  if (guarded) return
  guarded = true
  const original = target.error
  const wrapped = ((message: unknown, data?: Parameters<typeof toast.error>[1]) => {
    try {
      if (message && typeof message === 'object' && !isValidElement(message)) {
        const d = describeError(message)
        return original(d.title, { ...errorToastOptions(d), ...cleanData(data) })
      }
      if (typeof message === 'string' && isRawErrorText(message)) {
        const status = statusInText(message)
        const hint = status
          ? (STATUS_HINTS[status] ?? STATUS_HINTS[status >= 500 ? 500 : 400])
          : undefined
        const clean = cleanData(data)
        return original(plainErrorText(message), {
          ...(hint && !clean?.description ? { description: hint } : {}),
          ...clean
        })
      }
      return original(message as Parameters<typeof toast.error>[0], cleanData(data))
    } catch {
      return original(message as Parameters<typeof toast.error>[0], data)
    }
  }) as typeof toast.error
  target.error = wrapped
}

function cleanData<T extends { description?: unknown } | undefined>(data: T): T {
  if (!data || typeof data.description !== 'string' || !isRawErrorText(data.description))
    return data
  const { description: _raw, ...rest } = data
  return rest as T
}

/** Tests only: lets a test install the guard again on a fresh target. */
export function resetErrorToastGuardForTests(): void {
  guarded = false
}
