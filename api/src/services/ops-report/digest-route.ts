/** One request path as a route: ids, uuids and record keys folded. */
export function routeOf(path: string): string {
  return String(path ?? '')
    .split('?')[0]
    .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '/:uuid')
    .replace(/\/\d+(?=\/|$)/g, '/:id')
    .replace(/\/[A-Z]{1,5}\d{2}(INV)?-\d+(?=\/|$)/g, '/:key')
}
