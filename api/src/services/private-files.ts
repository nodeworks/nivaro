/**
 * Private files: a file a person rendered or exported FROM records they can see (a PDF, a
 * background export). The file library lists and serves every file to any signed-in user, which
 * would hand those renders to people the records are hidden from — so such files carry the
 * reserved tag `__private` and only the person who made them (and administrators) can list, read,
 * patch or download them. No migration: the marker rides the existing `tags` JSON column.
 */
export const PRIVATE_TAG = '__private'

export interface FileViewer {
  id?: string | null
  isAdmin?: boolean
}

/** Whether a file row carries the private marker. */
export function isPrivateFile(file: { tags?: unknown } | null | undefined): boolean {
  const raw = file?.tags
  if (!raw) return false
  try {
    const tags = typeof raw === 'string' ? JSON.parse(raw) : raw
    return Array.isArray(tags) && tags.includes(PRIVATE_TAG)
  } catch {
    return false
  }
}

/** May this viewer see the file? Everything non-private is open as before. */
export function viewerMaySeeFile(
  file: { tags?: unknown; uploaded_by?: unknown } | null | undefined,
  viewer: FileViewer | undefined
): boolean {
  if (!isPrivateFile(file)) return true
  if (!viewer) return false
  if (viewer.isAdmin) return true
  return (
    !!viewer.id &&
    !!file?.uploaded_by &&
    String(file.uploaded_by).toUpperCase() === String(viewer.id).toUpperCase()
  )
}
