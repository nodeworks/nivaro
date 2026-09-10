import cronstrue from 'cronstrue'

/** Human-readable cron expression ("At 02:00, only on Monday"), or null when
 *  the expression cannot be described — callers fall back to the raw string. */
export function describeCron(expression: string | null | undefined): string | null {
  if (!expression) return null
  try {
    return cronstrue.toString(expression.trim(), { use24HourTimeFormat: false, verbose: false })
  } catch {
    return null
  }
}
