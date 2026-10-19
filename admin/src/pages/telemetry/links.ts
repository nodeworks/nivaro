/** Grafana Explore on one trace (the provisioned `traces` datasource), or null without Grafana. */
export function grafanaTraceUrl(grafanaUrl: string | null, traceId: string): string | null {
  if (!grafanaUrl) return null
  const panes = {
    t: {
      datasource: 'traces',
      queries: [{ refId: 'A', datasource: { type: 'jaeger', uid: 'traces' }, query: traceId }],
      range: { from: 'now-7d', to: 'now' }
    }
  }
  return `${grafanaUrl.replace(/\/$/, '')}/explore?schemaVersion=1&orgId=1&panes=${encodeURIComponent(JSON.stringify(panes))}`
}

export const shortId = (id: string) => `${id.slice(0, 8)}…`

export function fmtMs(ms: number): string {
  return ms >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms).toLocaleString()} ms`
}
