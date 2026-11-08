/**
 * A header click's next sort (army 11 N6): ascending → descending → the
 * view's own default order (not the server's unsorted order). When the
 * column IS the default order it toggles between its two directions.
 */
export function nextSortValue(current: string, key: string, defaultSort: string): string {
  if (current === key) return `-${key}`
  if (current === `-${key}`) {
    if (!defaultSort) return ''
    return defaultSort === `-${key}` ? key : defaultSort
  }
  return key
}
