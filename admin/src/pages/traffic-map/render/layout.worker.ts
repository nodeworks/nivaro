// #2278 — the map's layout and edge routing off the main thread. Pure: it runs the same
// computeLayout / routeEdges the page falls back to, and hands the route buffer over (transfer,
// no copy). One message in, one out; the page drops replies older than its newest request.
import { computeLayout, type LayoutInput, type RouteRequest, routeEdges } from '../layout'

interface Job {
  seq: number
  input: LayoutInput
  edges: RouteRequest | null
}
const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<Job>) => void) | null
  postMessage(message: unknown, transfer?: Transferable[]): void
}

ctx.onmessage = (e) => {
  const { seq, input, edges } = e.data
  try {
    const layout = computeLayout(input)
    const routes = edges ? routeEdges(layout, edges) : null
    ctx.postMessage({ seq, layout, routes }, routes ? [routes.points.buffer] : [])
  } catch (err) {
    ctx.postMessage({ seq, error: String(err) })
  }
}
