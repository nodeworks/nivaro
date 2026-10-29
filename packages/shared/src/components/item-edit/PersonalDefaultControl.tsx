import { Check, Undo2, UserRound, UserRoundPen, UserRoundPlus, UserRoundX } from 'lucide-react'
import { Fragment, type ReactElement, useInsertionEffect, useState } from 'react'
import { toast } from 'sonner'
import { type PersonalDefaultsApi, usePersonalDefaultsApi } from './usePersonalDefaults'

// The visible personal-default control in a field's label row (spec
// 2026-10-28-personal-field-defaults-design). One slot per allowed field, anchored at the RIGHT
// end of the label row: it grows leftward, so the label and the chips before it never move, and
// its minimum width is the Make default button's, so the common moment (a person fills an empty
// field and Make default appears) never re-wraps the row. The ⋯ menu keeps Save / Clear my
// default for right-click and keyboard people; this is the same save path and inline confirm.
//
// Two different things can be "cleared", and the copy keeps them apart everywhere:
//   Undo           empties THIS field on this new record (the saved default stays)
//   Clear default  forgets the SAVED default (the field keeps whatever it holds)

export type PersonalDefaultSlotState =
  /** A personal default prefilled this new record: Your default · Undo · Clear default. */
  | 'applied'
  /** The value is the saved default for the current parent values: ✓ Your default · Clear default. */
  | 'saved'
  /** A saved default exists here but the person changed the value: Update default · Clear default. */
  | 'update'
  /** A saved default exists here and the field is empty: Your default · Clear default. */
  | 'saved-empty'
  /** No saved default for the current parent values, the field has a value: Make default. */
  | 'offer'
  /** Nothing to offer yet (empty field, defaults still loading): the slot keeps its box. */
  | 'reserve'

export function personalDefaultSlotState(s: {
  allowed: boolean
  editable: boolean
  loaded: boolean
  hasValue: boolean
  /** A saved default fits the current parent values. */
  hasDefault: boolean
  isDefault: boolean
  applied: boolean
  /** The saved defaults could not be read: offer Make default on a value, else nothing (never
   *  an empty reserved box that waits forever). */
  failed?: boolean
}): PersonalDefaultSlotState | null {
  if (!s.allowed) return null
  // The prefilled marker and the default-state actions are ONE control while the value stands.
  // Once its saved default is cleared the value is just a value (Make default).
  if (s.applied && s.hasDefault) return 'applied'
  if (!s.editable) return null
  if (!s.loaded) return 'reserve'
  if (s.failed && !s.hasDefault) return s.hasValue ? 'offer' : null
  if (s.hasDefault) return !s.hasValue ? 'saved-empty' : s.isDefault ? 'saved' : 'update'
  return s.hasValue ? 'offer' : 'reserve'
}

/** The slot state for one field from the form's PersonalDefaultsContext (null = no slot). */
export function personalDefaultSlotFor(
  api: PersonalDefaultsApi | null,
  field: string,
  editable: boolean
): PersonalDefaultSlotState | null {
  if (!api?.allowed(field)) return null
  // Kept to the profile: the form only shows a default it filled in (with Undo), never the
  // save / update / clear controls.
  if (!api.manageable(field))
    return api.applied(field) && api.defaultFor(field) !== null ? 'applied' : null
  return personalDefaultSlotState({
    allowed: true,
    editable,
    loaded: api.loaded,
    hasValue: api.hasValue(field),
    hasDefault: api.defaultFor(field) !== null,
    isDefault: api.isDefault(field),
    applied: api.applied(field),
    failed: api.failed
  })
}

/** The server's refusal text (`{ error, code }`), else the thrown message. */
export function refusalText(e: unknown, fallback: string): string {
  const x = e as {
    response?: { data?: { error?: string } }
    data?: { error?: string }
    error?: string
    message?: string
  }
  return x?.response?.data?.error ?? x?.data?.error ?? x?.error ?? x?.message ?? fallback
}

/** Clears the field's saved default at once; the toast's Undo saves it back exactly.
 *  Shared by the ⋯ menu's Clear my default and the control's Clear default. */
export function clearPersonalDefault(api: PersonalDefaultsApi, field: string): Promise<boolean> {
  return api.clear(field).then(
    (removed) => {
      toast.success(
        'Your default was cleared',
        removed
          ? {
              action: {
                label: 'Undo',
                onClick: () => {
                  api.restore(removed).then(
                    () => toast.success('Your default is back'),
                    (e) => toast.error(refusalText(e, 'Could not put your default back'))
                  )
                }
              }
            }
          : undefined
      )
      return true
    },
    (e) => {
      toast.error(refusalText(e, 'Could not clear your default'))
      return false
    }
  )
}

// Width steps and touch sizes, as attribute rules this control owns: a host stylesheet that
// loads later (efp-new's global.css) re-declares plain utilities (`.h-7`, `.opacity-0`,
// `hidden`) and would beat responsive or media-variant classes (gotchas "Host CSS loads after
// full.css"), so every rule here outranks a single class. The label row of a field with a slot
// is the container (`data-pd-row`), so the steps follow the FIELD's width, not the viewport: a
// col_span 1 of 4 column on a wide desktop compacts exactly like a phone.
//   ≥ 320px   every label in words
//   < 320px   secondary pieces (Your default, Undo, Clear default) become icons with their tip;
//             Make / Update default keep their words (the one action worth reading)
//   < 192px   Make / Update default become their icon too
// Reserve: the slot always takes the width of the WIDEST state this field can reach at that
// step (Update default · Clear default; on a new record the prefilled Your default · Undo ·
// Clear default), so no state change ever re-wraps the label row. A container query sees the
// row's width, not the room a long label leaves, so "fold when crowded" would need per-field
// JS measuring; a fixed reserve is deterministic and costs nothing. A crowded row wraps the
// slot onto its own line once, at render, and it stays there.
// Touch (no hover + coarse pointer): every action's invisible hit area grows to 44px tall,
// reaching mostly upward (16px) and 8px down so it never covers the input below; the
// confirm's Cancel / Save grow to 44px; the ⋯ trigger is always shown.
export const PERSONAL_DEFAULT_CSS = `
[data-pd-row]{container-type:inline-size;container-name:nvrpd}
[data-personal-default-slot]{min-width:13rem}
[data-personal-default-slot][data-pd-new]{min-width:16rem}
[data-personal-default-slot] [data-pd-icon]{display:none}
@container nvrpd (max-width: 319px){
[data-personal-default-slot],[data-personal-default-slot][data-pd-new]{min-width:9rem}
[data-personal-default-slot] [data-pd-label]{display:none}
[data-personal-default-slot] [data-pd-icon]{display:inline-block}
}
@container nvrpd (max-width: 191px){
[data-personal-default-slot]{min-width:3.25rem}
[data-personal-default-slot][data-pd-new]{min-width:5rem}
[data-personal-default-slot] [data-pd-primary]{display:none}
}
@media (hover: none) and (pointer: coarse){
[data-pd-row] [data-pd-action]::before{top:-16px;bottom:-8px}
[data-personal-default-confirm] button{height:2.75rem;padding-inline:.875rem}
}
@media (hover: none){
button[data-field-menu-trigger]{opacity:1}
}
`
const STYLE_ID = 'nvr-personal-default-css'

/** Puts the width steps and touch sizes in the document once (the first slot or field menu). */
export function usePersonalDefaultCss() {
  useInsertionEffect(() => {
    if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
    const el = document.createElement('style')
    el.id = STYLE_ID
    el.textContent = PERSONAL_DEFAULT_CSS
    document.head.appendChild(el)
  }, [])
}

// Same scale and tone as Repeat last (10.5px, slate-500 → slate-800 on hover, muted in dark),
// which efp-new re-points consistently; a 20px box whose ::before reaches 2px further up and
// down gives a 24px-tall hit area without growing the label row. The focus ring is solid sky
// (≥3:1 on white and on dark cards), not the ⋯ button's 40% cyan.
const ACTION =
  'relative inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded px-1 text-[10.5px] font-medium text-slate-500 transition-colors duration-150 before:absolute before:inset-x-0 before:-inset-y-0.5 before:content-[""] hover:bg-muted hover:text-slate-800 active:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-600 disabled:cursor-not-allowed disabled:opacity-50 aria-expanded:bg-muted aria-expanded:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground dark:focus-visible:ring-sky-300 dark:aria-expanded:text-foreground'
/** Plain status text in the action tone (no hover, not a button). */
const STATUS =
  'inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap px-1 text-[10.5px] font-medium text-slate-500 dark:text-muted-foreground'
/** The prefilled marker: the document-autofill "derived" pill's sky tint, so a filled-in value
 *  is noticed and checked. sky-800 on sky-50 ≈ 7.7:1; sky-200 on the dark tint ≈ 9:1. */
const PREFILLED =
  'inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded bg-sky-50 px-1.5 text-[10.5px] font-medium text-sky-800 dark:bg-sky-900/30 dark:text-sky-200'

function Dot() {
  return (
    <span
      aria-hidden
      className='select-none px-px text-[10.5px] text-slate-400 dark:text-slate-500'
    >
      ·
    </span>
  )
}

export function PersonalDefaultSlot({
  field,
  label,
  state,
  confirmOpen,
  onConfirm,
  onUndo,
  onCleared
}: {
  field: string
  /** The field's label, for the controls' accessible names. */
  label: string
  state: PersonalDefaultSlotState
  /** Which inline confirm opened from this control is showing (drives aria-expanded). */
  confirmOpen: 'make' | 'update' | null
  /** Opens the inline confirm under the control: Make default or Update default. */
  onConfirm: (el: HTMLElement, mode: 'make' | 'update') => void
  /** The prefilled marker's Undo: empties this field (the saved default stays). */
  onUndo: () => void
  /** Clear default went through (its button is gone): where focus should go next. */
  onCleared?: () => void
}) {
  usePersonalDefaultCss()
  const api = usePersonalDefaultsApi()
  const [clearing, setClearing] = useState(false)
  const name = label || field
  const fieldKeeps = state !== 'saved-empty'

  const clearButton = (
    <button
      key='clear'
      type='button'
      data-personal-default-clear={field}
      aria-label={
        fieldKeeps
          ? `Clear your saved default for ${name} (the field keeps its value)`
          : `Clear your saved default for ${name}`
      }
      data-tip={
        fieldKeeps
          ? 'Forget your saved default — this field keeps its value'
          : 'Forget your saved default'
      }
      data-pd-action
      tabIndex={-1}
      disabled={clearing || !api}
      aria-busy={clearing || undefined}
      onClick={() => {
        if (!api) return
        setClearing(true)
        void clearPersonalDefault(api, field).then((ok) => {
          setClearing(false)
          if (ok) onCleared?.()
        })
      }}
      className={ACTION}
    >
      <UserRoundX data-pd-icon className='h-3 w-3' aria-hidden />
      <span data-pd-label>Clear default</span>
    </button>
  )
  const confirmButton = (mode: 'make' | 'update') => (
    <button
      key={mode}
      type='button'
      {...(mode === 'make'
        ? { 'data-personal-default-make': field }
        : { 'data-personal-default-update': field })}
      aria-label={
        mode === 'make'
          ? `Make this your default for ${name}`
          : `Update your saved default for ${name} to this value`
      }
      aria-haspopup='dialog'
      aria-expanded={confirmOpen === mode}
      data-tip={
        mode === 'make'
          ? 'Start your new records with this value'
          : 'Start your new records with this value instead'
      }
      data-pd-action
      // Pointer and touch only: keyboard people reach the same action through ⋯ (the tab order
      // stays what it was: ⋯, then Undo when a default was just filled in).
      tabIndex={-1}
      onClick={(e) => onConfirm(e.currentTarget, mode)}
      className={ACTION}
    >
      {mode === 'make' ? (
        <UserRoundPlus className='h-3 w-3' aria-hidden />
      ) : (
        <UserRoundPen className='h-3 w-3' aria-hidden />
      )}
      <span data-pd-primary>{mode === 'make' ? 'Make default' : 'Update default'}</span>
    </button>
  )

  let parts: ReactElement[] = []
  if (state === 'offer') parts = [confirmButton('make')]
  else if (state === 'update') parts = [confirmButton('update'), clearButton]
  else if (state === 'saved' || state === 'saved-empty')
    parts = [
      <span
        key='status'
        data-personal-default-saved={field}
        data-tip={
          state === 'saved'
            ? 'Your new records start with this value'
            : 'You have a saved default for this field — new records start with it'
        }
        className={STATUS}
      >
        {state === 'saved' ? (
          <Check className='h-3 w-3 text-sky-700 dark:text-sky-300' aria-hidden />
        ) : (
          <UserRound className='h-3 w-3' aria-hidden />
        )}
        {/* Read by screen readers at every width; the visible words may fold to the icon. */}
        <span className='sr-only'>Your default</span>
        <span data-pd-label aria-hidden>
          Your default
        </span>
      </span>,
      clearButton
    ]
  else if (state === 'applied')
    parts = [
      <span
        key='status'
        data-personal-default={field}
        data-tip='Filled in from your saved default'
        className={PREFILLED}
      >
        <UserRound className='h-3 w-3' aria-hidden />
        {/* Read by screen readers at every width; the visible words may fold to the icon. */}
        <span className='sr-only'>Your default</span>
        <span data-pd-label aria-hidden>
          Your default
        </span>
      </span>,
      <button
        key='undo'
        type='button'
        data-personal-default-undo={field}
        aria-label={`Undo: empty ${name} (your saved default stays)`}
        data-tip='Empty this field — your saved default stays'
        data-pd-action
        onClick={onUndo}
        className={ACTION}
      >
        <Undo2 className='h-3 w-3' aria-hidden />
        <span data-pd-label>Undo</span>
      </button>,
      ...(api?.manageable(field) === false ? [] : [clearButton])
    ]

  return (
    <span
      data-personal-default-slot={field}
      data-state={state}
      data-pd-new={api?.isNew ? '' : undefined}
      aria-hidden={state === 'reserve' ? true : undefined}
      className='inline-flex shrink-0 items-center justify-end'
    >
      {parts.map((p, i) => (
        <Fragment key={String(p.key ?? i)}>
          {i > 0 && <Dot />}
          {p}
        </Fragment>
      ))}
    </span>
  )
}

/**
 * Summary mode's quiet marker beside a field label: the field takes a personal default on this
 * form. A muted person glyph, never a button or a pill — the reader is reading the record, not
 * editing it. Accent when this record's value IS the reader's saved default; the tip says which.
 * Renders nothing outside a form that provides PersonalDefaultsContext, or for a field the
 * layout does not open to personal defaults.
 */
export function PersonalDefaultMark({ field }: { field: string }) {
  const api = usePersonalDefaultsApi()
  if (!api?.allowed(field)) return null
  const mine = api.loaded && api.isDefault(field)
  const saved = api.loaded && api.defaultFor(field) !== null
  const tip = mine
    ? 'Your default: new records you start get this value.'
    : saved
      ? 'You have your own default for this field, different from this value.'
      : 'You can save your own default for this field (Edit mode).'
  return (
    <span
      data-personal-default-mark={mine ? 'mine' : saved ? 'saved' : 'allowed'}
      data-tip={tip}
      role='img'
      aria-label={tip}
      className={
        mine
          ? 'ml-1.5 inline-flex align-middle text-cyan-700 dark:text-nvr-cyan'
          : 'ml-1.5 inline-flex align-middle text-slate-500 dark:text-slate-400'
      }
    >
      <UserRound aria-hidden className='h-3 w-3' strokeWidth={2.25} />
    </span>
  )
}
