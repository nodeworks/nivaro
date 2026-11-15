import { useRelativeText } from '../lib/relative-ticker'

/**
 * "2m ago" that keeps counting (rt4 #23). Drop-in for `{formatRelative(x)}` in JSX; every
 * instance shares the tab's one ticker (lib/relative-ticker.ts). `format` swaps the wording
 * (a list column with its own phrasing); `title` is the exact stamp for the hover.
 */
export function RelativeTime({
  value,
  format,
  title,
  className
}: {
  value: string | Date | number | null | undefined
  format?: (v: string | Date | number) => string
  title?: string
  className?: string
}) {
  const text = useRelativeText(value, format)
  if (!text) return null
  const iso =
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'string' && !Number.isNaN(Date.parse(value))
        ? value
        : undefined
  return (
    <time dateTime={iso} title={title} className={className}>
      {text}
    </time>
  )
}
