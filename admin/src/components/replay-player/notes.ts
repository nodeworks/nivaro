/**
 * #1363 — timestamped notes on a recording: the data hook the player uses and
 * the pure placement of note markers on the scrubber. The notes rail and the
 * notes list (NotesRail.tsx / NotesPanel.tsx) render what this returns.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { api } from '@/lib/api'

export interface ReplayNote {
  id: string
  recording: string
  at_ms: number
  text: string
  user: string | null
  user_name: string | null
  created_at: string
  updated_at: string
}

export interface NoteTargets {
  issues: Array<{ id: number; title: string; status: string }>
  investigations: Array<{
    id: string
    title: string
    updated_at: string
    created_by_name: string | null
  }>
}

export type CopyTarget = { issue_id: number } | { investigation_id: string }

const EMPTY_TARGETS: NoteTargets = { issues: [], investigations: [] }

type ApiError = { response?: { data?: { error?: string } } }
const errorText = (err: unknown, fallback: string) =>
  (err as ApiError)?.response?.data?.error ?? fallback

const notesKey = (recordingId: string) => ['replay-notes', recordingId]

/** The notes and copy targets alone — what the scrubber's rail needs. */
export function useReplayNoteList(recordingId: string) {
  return useQuery({
    queryKey: notesKey(recordingId),
    queryFn: () =>
      api
        .get<{ data: ReplayNote[]; targets: NoteTargets; ready?: boolean }>(
          `/session-recordings/${recordingId}/notes`
        )
        .then((r) => r.data),
    staleTime: 30_000
  })
}

/** The list plus add / edit / delete / copy — what the notes panel needs. */
export function useReplayNotes(recordingId: string) {
  const qc = useQueryClient()
  const key = notesKey(recordingId)
  const q = useReplayNoteList(recordingId)
  const refresh = () => qc.invalidateQueries({ queryKey: key })

  const add = useMutation({
    mutationFn: (body: { at_ms: number; text: string }) =>
      api.post(`/session-recordings/${recordingId}/notes`, body),
    onSuccess: refresh,
    onError: (err) => toast.error(errorText(err, 'Could not save the note'))
  })
  const edit = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) =>
      api.patch(`/session-recordings/${recordingId}/notes/${id}`, { text }),
    onSuccess: refresh,
    onError: (err) => toast.error(errorText(err, 'Could not change the note'))
  })
  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/session-recordings/${recordingId}/notes/${id}`),
    onSuccess: refresh,
    onError: (err) => toast.error(errorText(err, 'Could not delete the note'))
  })
  const copy = useMutation({
    mutationFn: ({ id, target }: { id: string; target: CopyTarget; label: string }) =>
      api.post(`/session-recordings/${recordingId}/notes/${id}/copy`, target),
    onSuccess: (_r, v) => toast.success(`Copied to ${v.label}`),
    onError: (err) => toast.error(errorText(err, 'Could not copy the note'))
  })

  return {
    notes: q.data?.data ?? [],
    targets: q.data?.targets ?? EMPTY_TARGETS,
    /** False on an instance behind migration 423 — the panel says so instead of a form. */
    ready: q.data?.ready !== false,
    loading: q.isLoading,
    add,
    edit,
    remove,
    copy
  }
}

export interface NoteMarker {
  /** Earliest note in the group — where a click seeks. */
  offset: number
  /** 0–1 along the scrubber. */
  left: number
  notes: ReplayNote[]
}

/**
 * Notes as scrubber markers: placed by offset, merged when they land within
 * `minPx` of each other so a busy stretch stays clickable. Notes past the end
 * of a still-growing recording sit at the end.
 */
export function noteMarkers(
  notes: ReplayNote[],
  total: number,
  widthPx: number,
  minPx = 6
): NoteMarker[] {
  if (total <= 0 || notes.length === 0) return []
  const sorted = [...notes].sort((a, b) => a.at_ms - b.at_ms)
  const span = (minPx / Math.max(1, widthPx)) * total
  const out: NoteMarker[] = []
  for (const n of sorted) {
    const at = Math.min(Math.max(0, n.at_ms), total)
    const last = out[out.length - 1]
    if (last && at - last.offset <= span) {
      last.notes.push(n)
      continue
    }
    out.push({ offset: at, left: at / total, notes: [n] })
  }
  return out
}
