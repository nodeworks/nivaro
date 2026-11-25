/**
 * Behind the standalone Hub's sign-in card: a faint fleet map — apps as dots, each linked to the
 * Hub at the centre, radar rings around it. Decorative and anonymous (nothing about the real
 * fleet is shown before sign-in); the beacon breathes only when motion is welcome.
 */

const W = 1200
const H = 800
const CX = W / 2
const CY = H / 2

const TONES = [
  'var(--hub-env-production-ink-on-chrome)',
  'var(--hub-env-staging-ink-on-chrome)',
  'var(--hub-env-development-ink-on-chrome)',
  'var(--hub-env-other-ink-on-chrome)'
]

/** Deterministic scatter (golden angle), so the map never jumps between loads. */
function fleetPoints(n: number) {
  const pts: Array<{ x: number; y: number; r: number; tone: string }> = []
  for (let i = 0; i < n; i++) {
    const a = i * 2.399963 + 0.4
    const d = 170 + ((i * 97) % 5) * 62 + (i % 3) * 18
    const x = CX + Math.cos(a) * d * 1.35
    const y = CY + Math.sin(a) * d * 0.78
    // Keep the middle clear: the wordmark and the sign-in card sit there.
    if (Math.abs(x - CX) < 300 && Math.abs(y - CY) < 250) continue
    pts.push({ x, y, r: 2.5 + (i % 3) * 0.75, tone: TONES[i % TONES.length] })
  }
  return pts
}

const POINTS = fleetPoints(30)

export function HubLoginBackdrop() {
  return (
    <svg
      aria-hidden
      className='pointer-events-none absolute inset-0 h-full w-full'
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio='xMidYMid slice'
    >
      <title>Fleet map</title>
      <defs>
        <radialGradient id='hub-login-glow' cx='50%' cy='50%' r='50%'>
          <stop offset='0%' stopColor='#f5a623' stopOpacity='0.16' />
          <stop offset='60%' stopColor='#f5a623' stopOpacity='0' />
        </radialGradient>
      </defs>
      <circle cx={CX} cy={CY} r={420} fill='url(#hub-login-glow)' />
      {[120, 240, 360, 480].map((r) => (
        <ellipse
          key={r}
          cx={CX}
          cy={CY}
          rx={r * 1.35}
          ry={r * 0.78}
          fill='none'
          stroke='#ffffff'
          strokeOpacity={0.05}
        />
      ))}
      {POINTS.map((p) => (
        <line
          key={`l-${p.x}-${p.y}`}
          x1={CX}
          y1={CY}
          x2={p.x}
          y2={p.y}
          stroke='#ffffff'
          strokeOpacity={0.06}
        />
      ))}
      {POINTS.map((p) => (
        <circle
          key={`d-${p.x}-${p.y}`}
          cx={p.x}
          cy={p.y}
          r={p.r}
          fill={p.tone}
          fillOpacity={0.38}
        />
      ))}
      <circle cx={CX} cy={CY} r={7} fill='#f5a623' fillOpacity={0.9} />
      <circle
        cx={CX}
        cy={CY}
        r={7}
        fill='none'
        stroke='#f5a623'
        strokeOpacity={0.5}
        className='hub-login-beacon'
      />
    </svg>
  )
}
