import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNivaroClient } from '../../context'
import { del, get, patch, post } from '../../lib/commands'

/**
 * Chat — hooks for the second wave of features (#927–#989): mentions view,
 * shared files and links, room info, the record behind a record room,
 * scheduled messages, link previews, channel audit + bulk invite, summaries
 * over any range. The core room/message/outbox hooks live in chat-core.
 */

export interface MentionHit {
  id: number
  room: string
  room_label: string | null
  sender: string | null
  sender_name: string | null
  message: string
  date_created: string
  parent_id?: number | null
  unread: boolean
}

export function useMentions(enabled: boolean) {
  const client = useNivaroClient()
  const { data, isLoading } = useQuery({
    queryKey: ['nvr-chat-mentions'],
    queryFn: () =>
      client.request<{ data: MentionHit[] }>(get('/chat/mentions')).then((r) => r.data ?? []),
    enabled,
    staleTime: 15_000
  })
  return { mentions: data ?? [], loading: isLoading }
}

export interface SharedFile {
  file_id: string
  message_id: number
  sender_name: string | null
  date_created: string
  name: string
  type: string | null
  size: number | null
}
export interface SharedLink {
  url: string
  message_id: number
  sender_name: string | null
  date_created: string
}

export function useRoomShared(room: string, enabled: boolean) {
  const client = useNivaroClient()
  const { data, isLoading } = useQuery({
    queryKey: ['nvr-chat-shared', room],
    queryFn: () =>
      client
        .request<{ data: { files: SharedFile[]; links: SharedLink[] } }>(
          get(`/chat/rooms/${encodeURIComponent(room)}/shared`)
        )
        .then((r) => r.data),
    enabled,
    staleTime: 30_000
  })
  return { files: data?.files ?? [], links: data?.links ?? [], loading: isLoading }
}

export interface RoomInfoData {
  room: string
  kind: string
  members: Array<{ id: string; name: string; title: string | null; online: boolean }>
  member_count: number
  online_count: number
  created_by: string | null
  created_at: string | null
  file_count: number
  pin_count: number
  notify: { muted: boolean; mode: 'all' | 'mentions' }
}

export function useRoomInfo(room: string | null, enabled = true) {
  const client = useNivaroClient()
  const { data } = useQuery({
    queryKey: ['nvr-chat-room-info', room],
    queryFn: () =>
      client
        .request<{ data: RoomInfoData }>(
          get(`/chat/rooms/${encodeURIComponent(room as string)}/info`)
        )
        .then((r) => r.data),
    enabled: !!room && enabled,
    staleTime: 30_000,
    refetchInterval: enabled ? 60_000 : false
  })
  return data ?? null
}

export interface RoomRecordData {
  room: string
  collection: string
  id: string
  label: string
  state: { key: string; label: string; color: string | null } | null
  sla: { status: string; elapsed_hours: number | null; due_hours: number | null } | null
  owners: Array<{ id: string; name: string }>
}

export function useRoomRecord(room: string | null, enabled: boolean) {
  const client = useNivaroClient()
  const { data } = useQuery({
    queryKey: ['nvr-chat-room-record', room],
    queryFn: () =>
      client
        .request<{ data: RoomRecordData | null }>(
          get(`/chat/rooms/${encodeURIComponent(room as string)}/record`)
        )
        .then((r) => r.data ?? null),
    enabled: !!room && enabled,
    staleTime: 60_000
  })
  return data ?? null
}

export interface ScheduledMessage {
  id: number
  room: string
  message: string
  attachments: string[]
  parent_id: number | null
  send_at: string
  status: 'pending' | 'failed'
  error: string | null
}

export function useScheduledMessages(enabled = true) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: ['nvr-chat-scheduled'],
    queryFn: () =>
      client
        .request<{ data: ScheduledMessage[] }>(get('/chat/scheduled'))
        .then((r) => r.data ?? []),
    enabled,
    staleTime: 15_000,
    refetchInterval: enabled ? 30_000 : false
  })
  const refresh = () => void qc.invalidateQueries({ queryKey: ['nvr-chat-scheduled'] })
  const create = useMutation({
    mutationFn: (input: {
      room: string
      message: string
      attachments?: string[]
      parent_id?: number | null
      send_at: string
    }) => client.request(post('/chat/scheduled', input)),
    onSuccess: refresh
  })
  const update = useMutation({
    mutationFn: ({ id, ...p }: { id: number; message?: string; send_at?: string }) =>
      client.request(patch(`/chat/scheduled/${id}`, p)),
    onSuccess: refresh
  })
  const cancel = useMutation({
    mutationFn: (id: number) => client.request(del(`/chat/scheduled/${id}`)),
    onSuccess: refresh
  })
  return { scheduled: query.data ?? [], loading: query.isLoading, create, update, cancel }
}

export interface LinkPreviewData {
  url: string
  title: string | null
  description: string | null
  site: string | null
  ok: boolean
}

export function useLinkPreview(url: string | null) {
  const client = useNivaroClient()
  const { data } = useQuery({
    queryKey: ['nvr-chat-link-preview', url],
    queryFn: () =>
      client
        .request<{ data: LinkPreviewData }>(get('/chat/link-preview', { url }))
        .then((r) => r.data),
    enabled: !!url,
    staleTime: 60 * 60_000,
    retry: false
  })
  return data ?? null
}

export interface ChannelAuditRow {
  id: number
  action: string
  comment: string | null
  at: string
  user: string | null
  user_name: string | null
}

export function useChannelAudit(channelId: number | null, enabled: boolean) {
  const client = useNivaroClient()
  const { data, isLoading } = useQuery({
    queryKey: ['nvr-chat-channel-audit', channelId],
    queryFn: () =>
      client
        .request<{ data: ChannelAuditRow[] }>(get(`/chat/channels/${channelId}/audit`))
        .then((r) => r.data ?? []),
    enabled: channelId != null && enabled,
    staleTime: 30_000
  })
  return { rows: data ?? [], loading: isLoading }
}

export function useBulkInvite(channelId: number | null) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: { team_id?: string | number; role_id?: string; dry_run?: boolean }) =>
      client
        .request<{
          data: { added?: number; would_add?: number; skipped: number; source: string }
        }>(post(`/chat/channels/${channelId}/members/bulk`, input))
        .then((r) => r.data),
    onSuccess: (_d, v) => {
      if (!v.dry_run) {
        void qc.invalidateQueries({ queryKey: ['nvr-chat-members', channelId] })
        void qc.invalidateQueries({ queryKey: ['nvr-chat-directory'] })
      }
    }
  })
}

export interface TeamOption {
  id: string | number
  name: string
}

export function useTeams(enabled: boolean) {
  const client = useNivaroClient()
  const { data } = useQuery({
    queryKey: ['nvr-chat-teams'],
    queryFn: () =>
      client
        .request<{ data: TeamOption[] }>(get('/user-groups'))
        .then((r) => r.data ?? [])
        .catch(() => [] as TeamOption[]),
    enabled,
    staleTime: 5 * 60_000
  })
  return data ?? []
}

/** AI summary of a room since a date, or of one thread (#945). */
export function useRoomSummary() {
  const client = useNivaroClient()
  return useMutation({
    mutationFn: (input: { room: string; since?: string; thread?: number }) =>
      client
        .request<{ data: { summary: string | null; count: number } }>(
          post('/chat/rooms/summary', input)
        )
        .then((r) => r.data)
  })
}

export interface MyRecordRoom {
  room: string
  label: string
  unread: number
  mentions: number
  last_message: { sender_name: string | null; message: string; date_created: string } | null
}

export function useMyRecordRooms(enabled = true) {
  const client = useNivaroClient()
  const { data, isLoading } = useQuery({
    queryKey: ['nvr-chat-my-record-rooms'],
    queryFn: () =>
      client
        .request<{ data: MyRecordRoom[] }>(get('/chat/my-record-rooms'))
        .then((r) => r.data ?? [])
        .catch(() => [] as MyRecordRoom[]),
    enabled,
    staleTime: 30_000,
    refetchInterval: enabled ? 60_000 : false
  })
  return { rooms: data ?? [], loading: isLoading }
}

export interface FileTarget {
  field: string
  label: string
  kind: 'm2m' | 'm2o'
}

export function useRecordFileTargets(room: string, enabled: boolean) {
  const client = useNivaroClient()
  const { data } = useQuery({
    queryKey: ['nvr-chat-file-targets', room],
    queryFn: () =>
      client
        .request<{ data: FileTarget[] }>(
          get(`/chat/rooms/${encodeURIComponent(room)}/file-targets`)
        )
        .then((r) => r.data ?? []),
    enabled,
    staleTime: 5 * 60_000
  })
  return data ?? []
}
