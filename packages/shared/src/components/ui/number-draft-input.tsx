import * as React from 'react'
import { Input, type InputProps } from './input'

// A number input that never rewrites what the person is typing (army 4,
// a01-15). The old pattern — `value={String(n)}` + `onChange(Number(text))` —
// turned "2.0" into 2, re-rendered "2" over the typed text, and the next key
// made 25 out of 2.05. Here the typed text is kept as a draft while the person
// types; the number is committed on every change that parses, and the draft is
// dropped on blur (the field then shows the stored value again).

/** Text a person may be part-way through typing, in a text-mode input. */
const PARTIAL_NUMBER = /^-?\d*\.?\d*$/

/** The stored value as a number, or null for "no value". */
export function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

/** What the input shows when nothing is being typed. */
export function formatNumberValue(value: unknown): string {
  if (value === null || value === undefined) return ''
  return String(value)
}

/**
 * What typed text commits: a number, null (the text was cleared), or
 * undefined (part-way text such as "-", "." or "1e" — nothing to commit yet).
 */
export function numberFromDraft(text: string): number | null | undefined {
  const t = text.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : undefined
}

/** Clean text-mode input: drop thousands separators, spaces and a currency sign. */
export function cleanNumberText(text: string): string {
  return text.replace(/[,\s$]/g, '')
}

function sameNumber(a: number | null, b: number | null): boolean {
  return a === b || (a !== null && b !== null && Object.is(a, b))
}

export interface NumberDraftOptions {
  value: unknown
  onValue: (n: number | null) => void
  /** false refuses a minus sign / negative number. Default true. */
  allowNegative?: boolean
  /** The input's type: 'number' trusts the browser's parsing; anything else filters the text. */
  type?: string
  onChange?: React.ChangeEventHandler<HTMLInputElement>
  onBlur?: React.FocusEventHandler<HTMLInputElement>
}

/** Props for an `<input>` that keep the typed text while the person types. */
export function useNumberDraft({
  value,
  onValue,
  allowNegative = true,
  type = 'number',
  onChange,
  onBlur
}: NumberDraftOptions) {
  const [draft, setDraft] = React.useState<string | null>(null)
  // The last number this input committed, or the last value it was given.
  const committed = React.useRef<number | null>(numberOrNull(value))
  const external = numberOrNull(value)

  // Changed from outside (a rule, a recalculation, someone else's save):
  // remember it, so the next commit compares against it. While the person is
  // typing their text stays; the new value shows once they leave the field.
  React.useEffect(() => {
    committed.current = external
  }, [external])

  const commit = (n: number | null) => {
    if (n !== null && n < 0 && !allowNegative) return
    if (sameNumber(n, committed.current)) return
    committed.current = n
    onValue(n)
  }

  const handleChange: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const el = e.target
    if (type === 'number') {
      // Text the browser cannot read yet ("-", "2." in some browsers) reads
      // as "" with badInput set: keep "" as the draft so React leaves the
      // visible text alone, and commit nothing.
      if (el.value === '' && el.validity?.badInput) {
        setDraft('')
        onChange?.(e)
        return
      }
      if (!allowNegative && el.value.includes('-')) {
        setDraft(draft ?? formatNumberValue(value))
        return
      }
      setDraft(el.value)
      const n = numberFromDraft(el.value)
      if (n !== undefined) commit(n)
      onChange?.(e)
      return
    }
    const text = cleanNumberText(el.value)
    if (!PARTIAL_NUMBER.test(text) || (!allowNegative && text.includes('-'))) return
    setDraft(text)
    const n = numberFromDraft(text)
    if (n !== undefined) commit(n)
    onChange?.(e)
  }

  // Every change that parses was committed already, so leaving the field only
  // drops the draft: the stored value shows again ("1.0" → "1", a part-way
  // "-" → the value it had), including one changed from outside meanwhile.
  const handleBlur: React.FocusEventHandler<HTMLInputElement> = (e) => {
    if (draft !== null) setDraft(null)
    onBlur?.(e)
  }

  return {
    value: draft ?? formatNumberValue(value),
    onChange: handleChange,
    onBlur: handleBlur,
    typing: draft !== null
  }
}

export interface NumberDraftInputProps
  extends Omit<InputProps, 'value' | 'defaultValue' | 'onChange'> {
  value: unknown
  /** Called with the number as soon as the typed text is one (null when cleared). */
  onValue: (n: number | null) => void
  onChange?: React.ChangeEventHandler<HTMLInputElement>
  allowNegative?: boolean
  /** A plain `<input>` without the form-input styling (grid cells). */
  bare?: boolean
}

export const NumberDraftInput = React.forwardRef<HTMLInputElement, NumberDraftInputProps>(
  (
    { value, onValue, onChange, onBlur, allowNegative, bare, type = 'number', inputMode, ...rest },
    ref
  ) => {
    const draft = useNumberDraft({ value, onValue, allowNegative, type, onChange, onBlur })
    const props = {
      ...rest,
      ref,
      type,
      inputMode: inputMode ?? (type === 'number' ? undefined : ('decimal' as const)),
      value: draft.value,
      onChange: draft.onChange,
      onBlur: draft.onBlur
    }
    return bare ? <input {...props} /> : <Input {...props} />
  }
)
NumberDraftInput.displayName = 'NumberDraftInput'
