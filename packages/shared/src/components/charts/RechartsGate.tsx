import { type ReactNode, useEffect, useState } from 'react'
import { Skeleton } from '../ui/skeleton'

type Recharts = typeof import('recharts')

// recharts + d3 are ~430 KB and only chart-bearing views need them, so they load
// as their own chunk on first use instead of riding in the entry. A chart
// renders inside <RechartsGate> and receives the library as an argument; until
// it arrives the gate shows a skeleton the caller sizes like the chart.
let loaded: Recharts | null = null
let pending: Promise<Recharts> | null = null

export function loadRecharts(): Promise<Recharts> {
  pending ??= import('recharts').then((m) => {
    loaded = m
    return m
  })
  return pending
}

export function RechartsGate({
  children,
  fallback
}: {
  children: (r: Recharts) => ReactNode
  fallback?: ReactNode
}) {
  const [r, setR] = useState<Recharts | null>(loaded)
  useEffect(() => {
    if (r) return
    let live = true
    loadRecharts().then((m) => live && setR(m))
    return () => {
      live = false
    }
  }, [r])
  if (r) return <>{children(r)}</>
  return <>{fallback ?? <Skeleton className='h-full min-h-[120px] w-full' aria-busy='true' />}</>
}
