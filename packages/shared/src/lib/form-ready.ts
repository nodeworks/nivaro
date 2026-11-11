/**
 * Whether the record form may judge and send a save. The form's field list is
 * empty until its field config AND resolved layout have loaded; validating an
 * empty list passes every required field, so a save pressed on a form that is
 * still loading (or never loaded on a bad network) would go out blank.
 */
export const FORM_NOT_READY_MESSAGE =
  'The form is still loading. Wait a moment for its fields to appear, then try again.'

export function formReadyToSave(fields: readonly unknown[] | null | undefined): boolean {
  return Array.isArray(fields) && fields.length > 0
}
