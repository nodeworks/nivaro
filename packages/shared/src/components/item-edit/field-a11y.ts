// Accessible names and states for a field's control (record form rows and
// the line editor share them).

/**
 * Marks a field's control required / invalid and ties it to the message under
 * the field. A picker trigger (plain button) does not take aria-required —
 * the label's "*" names it there. Our describedby token is added / removed
 * without touching ids the control set itself.
 */
export function applyFieldA11y(
  el: HTMLElement,
  s: {
    required: boolean
    hasError: boolean
    errorId: string
    /** false = invalid, but no message element to point at (default: hasError). */
    describe?: boolean
  }
): void {
  const set = (name: string, value: string | null) => {
    if (value == null) {
      if (el.hasAttribute(name)) el.removeAttribute(name)
    } else if (el.getAttribute(name) !== value) el.setAttribute(name, value)
  }
  const takesRequired = el.tagName !== 'BUTTON' || el.getAttribute('role') === 'combobox'
  set('aria-required', s.required && takesRequired ? 'true' : null)
  // Only the aria-invalid this helper set is taken back (the control may mark
  // its own typing error, FieldRenderer's entryError).
  if (s.hasError) {
    set('aria-invalid', 'true')
    el.setAttribute('data-nvr-invalid', '')
  } else if (el.hasAttribute('data-nvr-invalid')) {
    el.removeAttribute('data-nvr-invalid')
    set('aria-invalid', null)
  }
  const tokens = (el.getAttribute('aria-describedby') ?? '')
    .split(/\s+/)
    .filter((t) => t && t !== s.errorId)
  if (s.hasError && s.describe !== false) tokens.push(s.errorId)
  set('aria-describedby', tokens.length ? tokens.join(' ') : null)
}

/** The control a field label names: its first input (a rich-text body, not
 *  the toolbar above it), else a picker's trigger button. */
export function primaryControl(root: HTMLElement | null): HTMLElement | null {
  if (!root) return null
  return (
    root.querySelector<HTMLElement>(
      'input:not([type=hidden]), textarea, [role="combobox"], [contenteditable="true"]'
    ) ?? root.querySelector<HTMLElement>('button')
  )
}

/**
 * Names the control inside `root` after its visible label (`labelId`) — a
 * picker button keeps its own text after the label ("Zone, Select…") — and
 * applies the required / invalid state. A control with its own aria-label
 * keeps it.
 */
export function nameFieldControl(
  root: HTMLElement | null,
  labelId: string,
  s: Parameters<typeof applyFieldA11y>[1]
): void {
  const el = primaryControl(root)
  if (!el) return
  applyFieldA11y(el, s)
  if (el.hasAttribute('aria-label')) return
  if (!el.id) el.id = `${labelId}-control`
  const want = el.tagName === 'BUTTON' ? `${labelId} ${el.id}` : labelId
  if (el.getAttribute('aria-labelledby') !== want) el.setAttribute('aria-labelledby', want)
}
