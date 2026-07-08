// Bucket-start enumeration matching the server's SQL bucketing (Monday weeks,
// first-of-month months). All math in UTC on YYYY-MM-DD strings.
const DAY_MS = 86_400_000

function toUtc(d: string): Date {
  return new Date(`${d}T00:00:00Z`)
}

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function mondayOf(d: Date): Date {
  const dow = (d.getUTCDay() + 6) % 7 // Monday = 0
  return new Date(d.getTime() - dow * DAY_MS)
}

export function enumerateBuckets(
  from: string,
  to: string,
  bucket: 'day' | 'week' | 'month'
): string[] {
  const start = toUtc(from)
  const end = toUtc(to)
  const out: string[] = []
  if (bucket === 'day') {
    for (let t = start.getTime(); t <= end.getTime(); t += DAY_MS) out.push(fmt(new Date(t)))
    return out
  }
  if (bucket === 'week') {
    for (let t = mondayOf(start).getTime(); t <= end.getTime(); t += 7 * DAY_MS) {
      out.push(fmt(new Date(t)))
    }
    return out
  }
  const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
  while (cur.getTime() <= end.getTime()) {
    out.push(fmt(cur))
    cur.setUTCMonth(cur.getUTCMonth() + 1)
  }
  return out
}
