/**
 * The record tools a form layout can switch on for everyone (Form settings →
 * Buttons & panels): "Schedule a change" (allow_schedule) and "Disable in
 * pickers" (allow_disable_pickers). Administrators always have both. One
 * reader for every host — admin ItemEdit and the shared record form.
 */
export interface LayoutGrantFlags {
  allow_schedule?: boolean | number | null
  allow_disable_pickers?: boolean | number | null
}

export function layoutGrantedTools(
  layout: LayoutGrantFlags | null | undefined,
  isAdmin: boolean
): { schedule: boolean; disablePickers: boolean } {
  return {
    schedule: isAdmin || !!layout?.allow_schedule,
    disablePickers: isAdmin || !!layout?.allow_disable_pickers
  }
}
