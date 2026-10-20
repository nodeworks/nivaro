import { useCallback, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts'
import { cn } from '../../lib/utils'
import type { ChartPointHandler, ChartSpec } from './AiMarkdown'

const CHART_COLORS = [
  '#0ea5e9',
  '#6366f1',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#14b8a6',
  '#f97316'
]

/** A chart the answer attached — bar/line/pie over {label, value} points,
 *  recharts, sized to the bubble. Theme-neutral inks so it reads in both modes. */
export function AiChart({ spec, onPoint }: { spec: ChartSpec; onPoint?: ChartPointHandler }) {
  const point = onPoint
    ? (label: unknown) => label != null && onPoint(String(label), spec)
    : undefined
  const [width, setWidth] = useState(0)
  const ref = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    setWidth(el.getBoundingClientRect().width)
    const ro = new ResizeObserver(() => setWidth(el.getBoundingClientRect().width))
    ro.observe(el)
  }, [])
  const height = spec.type === 'pie' ? 220 : 200
  const w = Math.max(240, Math.min(720, width || 400))
  const fmt = (n: number) =>
    Math.abs(n) >= 1e6
      ? `${(n / 1e6).toFixed(1)}M`
      : Math.abs(n) >= 1e3
        ? `${(n / 1e3).toFixed(n % 1e3 === 0 ? 0 : 1)}k`
        : n.toLocaleString()
  const tip = {
    contentStyle: {
      background: '#0f172a',
      border: '1px solid #334155',
      borderRadius: 6,
      color: '#f8fafc',
      fontSize: 12
    },
    itemStyle: { color: '#f8fafc' },
    labelStyle: { color: '#cbd5e1' }
  }
  return (
    <div
      ref={ref}
      data-ai-chart={spec.type}
      data-ai-chart-drill={onPoint ? '' : undefined}
      className={cn('my-2 w-full', onPoint && '[&_.recharts-wrapper]:cursor-pointer')}
    >
      {spec.title && (
        <div className='mb-1 text-[0.9em] font-medium text-muted-foreground'>{spec.title}</div>
      )}
      {spec.type === 'pie' ? (
        <PieChart width={w} height={height}>
          <Pie
            data={spec.data}
            dataKey='value'
            nameKey='label'
            cx='50%'
            cy='50%'
            outerRadius={80}
            label={({ name, percent }) => `${name} ${Math.round((percent ?? 0) * 100)}%`}
            labelLine={false}
            onClick={point ? (d: any) => point(d?.label ?? d?.name) : undefined}
          >
            {spec.data.map((d, i) => (
              <Cell key={d.label} fill={CHART_COLORS[i % CHART_COLORS.length]} />
            ))}
          </Pie>
          <Tooltip {...tip} formatter={(v) => fmt(Number(v))} />
        </PieChart>
      ) : spec.type === 'line' ? (
        <LineChart
          width={w}
          height={height}
          data={spec.data}
          margin={{ left: 4, right: 12 }}
          onClick={point ? (st: any) => point(st?.activeLabel) : undefined}
        >
          <CartesianGrid strokeDasharray='3 3' stroke='currentColor' opacity={0.12} />
          <XAxis dataKey='label' tick={{ fontSize: 11 }} interval='preserveStartEnd' />
          <YAxis tick={{ fontSize: 11 }} tickFormatter={fmt} width={44} />
          <Tooltip {...tip} formatter={(v) => fmt(Number(v))} />
          <Line
            type='monotone'
            dataKey='value'
            stroke='#0ea5e9'
            strokeWidth={2}
            dot={spec.data.length <= 12}
          />
        </LineChart>
      ) : (
        <BarChart
          width={w}
          height={height}
          data={spec.data}
          margin={{ left: 4, right: 12 }}
          onClick={point ? (st: any) => point(st?.activeLabel) : undefined}
        >
          <CartesianGrid strokeDasharray='3 3' stroke='currentColor' opacity={0.12} />
          <XAxis
            dataKey='label'
            tick={{ fontSize: 11 }}
            interval={0}
            angle={spec.data.length > 8 ? -30 : 0}
            textAnchor={spec.data.length > 8 ? 'end' : 'middle'}
            height={spec.data.length > 8 ? 56 : 30}
          />
          <YAxis tick={{ fontSize: 11 }} tickFormatter={fmt} width={44} />
          <Tooltip {...tip} formatter={(v) => fmt(Number(v))} />
          <Bar dataKey='value' fill='#0ea5e9' radius={[3, 3, 0, 0]} />
        </BarChart>
      )}
    </div>
  )
}
