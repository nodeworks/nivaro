// Partial edit lock (a post-approval state that leaves some fields open): the
// fields a person may NOT change are every one the server did not list as open.
// Empty open list = not partial mode, so nothing is added here (the whole form
// is read-only through `isReadOnly` instead).

export function editLockLockedFields(
  fieldNames: readonly string[],
  openFields: ReadonlySet<string> | readonly string[]
): string[] {
  const open = openFields instanceof Set ? openFields : new Set(openFields)
  if (open.size === 0) return []
  return fieldNames.filter((f) => !open.has(f))
}
