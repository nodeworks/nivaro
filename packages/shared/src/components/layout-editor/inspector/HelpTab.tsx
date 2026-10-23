import { useQuery, useQueryClient } from '@tanstack/react-query'
import { PlayCircle, Plus, StickyNote, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNivaroClient } from '../../../context'
import { get } from '../../../lib/commands'
import { userErrorMessage } from '../../../lib/safe-error'
import { cn } from '../../../lib/utils'
import { fetchHelpVideo, helpVideoApi, useHelpVideosForForm } from '../../help-videos/api'
import type { HelpVideoContext, HelpVideoDto } from '../../help-videos/types'
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '../../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import type { DesignTarget } from '../design-context'
import { type EditorNote, NOTE_TEXT_MAX, noteByline, noteOf, noteOps } from '../editor-notes'
import { inputBase } from '../panel-style'
import { Setting, useInspectorEnv } from './kit'

const smallBtn =
  'inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 text-[12px] font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:opacity-40 dark:border-border dark:bg-background dark:text-foreground dark:hover:bg-muted'
const solidBtn =
  'inline-flex h-7 items-center rounded-md bg-nvr-cyan px-2.5 text-[12px] font-medium text-white transition-colors hover:bg-[#00b8e0] disabled:opacity-40'

/** The signed-in admin, for a note's byline. */
function useEditorMe() {
  const client = useNivaroClient()
  return useQuery({
    queryKey: ['layout-editor', 'me'] as const,
    staleTime: 10 * 60_000,
    queryFn: () =>
      client
        .request<{
          data: {
            id: string
            first_name?: string | null
            last_name?: string | null
            email?: string
          }
        }>(get('/users/me'))
        .then((r) => r.data)
  })
}

/**
 * #2608 — a note pinned to this field or section, for whoever edits the form
 * next ("Finance asked for this in Q3"). Shown only in the layout editor.
 */
export function NoteSetting({ target, name }: { target: DesignTarget; name: string }) {
  const env = useInspectorEnv()
  const { data: me } = useEditorMe()
  const note = noteOf(env.bundle, target)
  const [text, setText] = useState(note?.text ?? '')
  // Undo, another tab's save or a new selection: show what the layout holds.
  useEffect(() => setText(note?.text ?? ''), [note?.text])
  const changed = text.trim() !== (note?.text ?? '')
  const save = (next: EditorNote | null, label: string) => {
    const ops = noteOps(env.bundle, target, next)
    if (ops.length) env.apply(ops, { label })
  }
  const pin = () => {
    if (!text.trim()) return save(null, `Remove the note on ${name}`)
    const byName = [me?.first_name, me?.last_name].filter(Boolean).join(' ') || me?.email || null
    save(
      { text, by: me?.id ?? null, by_name: byName, at: new Date().toISOString() },
      note ? `Change the note on ${name}` : `Pin a note to ${name}`
    )
  }
  return (
    <Setting
      k='editor.note'
      label={
        <span className='inline-flex items-center gap-1.5'>
          <StickyNote aria-hidden className='h-3.5 w-3.5 text-amber-500' />
          Note for editors
        </span>
      }
      effect='Only people editing this form see it, as a marker on the canvas. Record pages never show it.'
    >
      <textarea
        aria-label='Note for editors'
        rows={3}
        maxLength={NOTE_TEXT_MAX}
        value={text}
        placeholder='Finance asked for this in Q3'
        onChange={(e) => setText(e.target.value)}
        className={cn(inputBase, 'h-auto py-1.5 leading-snug')}
      />
      {note && (
        <p data-note-byline='' className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
          {noteByline(note)}
        </p>
      )}
      <div className='flex flex-wrap gap-2'>
        <button
          type='button'
          data-note-save=''
          className={solidBtn}
          disabled={!changed}
          onClick={pin}
        >
          {note ? 'Save note' : 'Pin note'}
        </button>
        {note && (
          <button
            type='button'
            data-note-remove=''
            className={smallBtn}
            onClick={() => save(null, `Remove the note on ${name}`)}
          >
            Remove
          </button>
        )}
      </div>
    </Setting>
  )
}

/**
 * #2615 — attach published help videos to one field or section of this
 * collection. The record page then shows a small play button beside its
 * label (to the roles each video is visible to). Attaching adds a "where"
 * to the video itself, so it shows for this field on every form of the
 * collection.
 */
export function HelpVideoSetting({
  kind,
  name,
  label
}: {
  kind: 'field' | 'section'
  /** The field name or the section's group key. */
  name: string
  label: string
}) {
  const env = useInspectorEnv()
  const client = useNivaroClient()
  const qc = useQueryClient()
  const { data: form } = useHelpVideosForForm(env.collection)
  const listed = kind === 'field' ? form?.fields?.[name] : form?.sections?.[name]
  const attached = Array.isArray(listed) ? listed : []
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const library = useQuery({
    queryKey: ['help-videos', 'library', { status: 'published', picker: true }] as const,
    enabled: open,
    staleTime: 60_000,
    queryFn: () =>
      client
        .request<{ data: HelpVideoDto[] }>(get('/help-videos', { status: 'published', limit: 100 }))
        .then((r) => r.data)
  })
  const here: HelpVideoContext = { kind, key: env.collection, state_key: name }
  const same = (c: HelpVideoContext) =>
    c.kind === here.kind && c.key === here.key && c.state_key === here.state_key
  const change = async (videoId: string, attach: boolean) => {
    setBusy(true)
    setError(null)
    try {
      // The video's whole "where" list, as its author sees it, with this one added or taken off.
      const video = await fetchHelpVideo(client, videoId)
      const rest = (video.contexts ?? []).filter((c) => !same(c))
      await helpVideoApi(client).setContexts(videoId, attach ? [...rest, here] : rest)
      await qc.invalidateQueries({ queryKey: ['help-videos'] })
    } catch (e) {
      setError(userErrorMessage(e, 'Could not change the video'))
    } finally {
      setBusy(false)
    }
  }
  const attachedIds = new Set(attached.map((v) => v.id))
  const choices = (Array.isArray(library.data) ? library.data : []).filter(
    (v) => !attachedIds.has(v.id)
  )
  return (
    <Setting
      k={kind === 'field' ? 'field.help_video' : 'group.help_video'}
      label='Help video'
      scope={kind === 'field' ? 'field' : 'form'}
      effect={`A play button beside ${label} opens the video on the record page, for the roles allowed to see it.`}
    >
      {attached.length > 0 && (
        <ul className='space-y-1'>
          {attached.map((v) => (
            <li
              key={v.id}
              data-help-video-attached={v.id}
              className='flex items-center gap-2 rounded-md border border-slate-200 bg-white px-2 py-1 text-[12.5px] dark:border-border dark:bg-background'
            >
              <PlayCircle aria-hidden className='h-3.5 w-3.5 shrink-0 text-nvr-cyan' />
              <span className='min-w-0 flex-1 truncate text-slate-800 dark:text-foreground'>
                {v.title}
              </span>
              <button
                type='button'
                aria-label={`Take ${v.title} off ${label}`}
                data-tip='Take it off'
                disabled={busy}
                onClick={() => void change(v.id, false)}
                className='rounded p-0.5 text-slate-400 hover:bg-muted hover:text-slate-700 disabled:opacity-40 dark:hover:text-foreground'
              >
                <X className='h-3.5 w-3.5' />
              </button>
            </li>
          ))}
        </ul>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button type='button' className={smallBtn} disabled={busy} data-help-video-pick=''>
            <Plus className='h-3.5 w-3.5' />
            Attach a video
          </button>
        </PopoverTrigger>
        <PopoverContent align='start' className='w-[300px] p-0'>
          <Command>
            <CommandInput placeholder='Find a published video…' />
            <CommandList className='max-h-[260px] overscroll-contain'>
              <CommandEmpty>
                {library.isLoading ? 'Loading videos…' : 'No published videos to attach.'}
              </CommandEmpty>
              {choices.map((v) => (
                <CommandItem
                  key={v.id}
                  value={`${v.title} ${v.id}`}
                  onSelect={() => {
                    setOpen(false)
                    void change(v.id, true)
                  }}
                >
                  <span className='truncate'>{v.title}</span>
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {error && (
        <p role='alert' className='text-[12px] text-red-700 dark:text-red-300'>
          {error}
        </p>
      )}
    </Setting>
  )
}
