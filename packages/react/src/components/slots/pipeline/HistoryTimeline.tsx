import { StateBadge } from './StateBadge'

export type PHistory = {
  id: string
  from_state: string | null
  to_state: string
  from_state_label?: string
  to_state_label: string
  from_state_color?: string | null
  to_state_color?: string | null
  comment?: string | null
  timestamp: string
  first_name?: string | null
  last_name?: string | null
  user_email?: string | null
}

export function relFmt(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function initials(
  first: string | null | undefined,
  last: string | null | undefined,
  email: string | null | undefined
) {
  const f = first?.[0] ?? ''
  const l = last?.[0] ?? ''
  return (f + l).toUpperCase() || email?.[0]?.toUpperCase() || '?'
}

export function HistoryTimeline({ history }: { history: PHistory[] }) {
  if (history.length === 0) {
    return (
      <p style={{ fontSize: 12, color: '#94a3b8', fontStyle: 'italic' }}>No transitions yet.</p>
    )
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {history.map((h) => {
        const name =
          [h.first_name, h.last_name].filter(Boolean).join(' ') || h.user_email || 'System'
        const ts = relFmt(h.timestamp)
        return (
          <div
            key={h.id}
            style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 12 }}
          >
            <div
              style={{
                marginTop: 6,
                width: 6,
                height: 6,
                borderRadius: '50%',
                backgroundColor: '#e2e8f0',
                flexShrink: 0
              }}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                {h.from_state_label ? (
                  <StateBadge label={h.from_state_label} color={h.from_state_color ?? null} small />
                ) : (
                  <span style={{ fontSize: 11, color: '#94a3b8', fontStyle: 'italic' }}>
                    started
                  </span>
                )}
                <svg aria-hidden='true' width='12' height='12' viewBox='0 0 12 12' fill='none'>
                  <path
                    d='M2 6h8M7 3l3 3-3 3'
                    stroke='#cbd5e1'
                    strokeWidth='1.5'
                    strokeLinecap='round'
                    strokeLinejoin='round'
                  />
                </svg>
                <StateBadge label={h.to_state_label} color={h.to_state_color ?? null} small />
              </div>
              {h.comment && (
                <p style={{ marginTop: 2, color: '#64748b', fontStyle: 'italic' }}>"{h.comment}"</p>
              )}
              <p style={{ marginTop: 2, color: '#94a3b8' }}>
                {name} · {ts}
              </p>
            </div>
          </div>
        )
      })}
    </div>
  )
}
