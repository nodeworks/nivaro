/** Below this width the record form's Summary rail folds and opens over the
 *  form (army11: at 375 px the 232 px rail left the form ~120 px wide). */
export const NARROW_RECORD_PX = 768

/** Is the record body (form + rail) this wide too narrow for the rail beside the form? */
export function isNarrowRecordWidth(width: number): boolean {
  return width > 0 && width < NARROW_RECORD_PX
}
