import { toast } from 'sonner'
import { copyErrorDetails, describeError, type ErrorDescription } from './error-message'

/**
 * Toast options for a failed request: the hint as the description and a
 * "Copy details" action (title, hint, code, request id, page, time) — for
 * `toast.error(userErrorMessage(err, …), errorToastOptions(err))` where the
 * title is already chosen, or through `toastError` below.
 */
export function errorToastOptions(
  input: unknown,
  opts: { action?: string } = {}
): {
  description?: string
  action: { label: string; onClick: () => void }
} {
  const d = isDescribed(input) ? input : describeError(input)
  return {
    ...(d.hint ? { description: d.hint } : {}),
    action: {
      label: 'Copy details',
      onClick: () => {
        void copyErrorDetails(d, opts).then((ok) =>
          ok ? toast.success('Details copied') : toast.error('Could not copy the details')
        )
      }
    }
  }
}

/** One error toast: what happened, what to do, and Copy details. Returns the reading. */
export function toastError(
  err: unknown,
  fallback?: string,
  opts: { action?: string } = {}
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
