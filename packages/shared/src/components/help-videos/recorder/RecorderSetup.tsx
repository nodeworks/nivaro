import { AppWindow, ArchiveX, History, Monitor, PanelTop } from 'lucide-react'
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react'
import { Button } from '../../ui/button'
import { Checkbox } from '../../ui/checkbox'
import {
  DialogBody,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../ui/dialog'
import { Label } from '../../ui/label'
import { SimpleSelect } from '../../ui/SimpleSelect'
import type { Leftover } from './leftovers'
import { ConfirmDiscard, ErrorNote, ghostBtn, primaryBtn } from './RecorderStatus'
import type { Source } from './useScreenCapture'

export type SetupOptions = {
  source: Source
  useMic: boolean
  micId: string
  captureClicks: boolean
}
export const DEFAULT_SETUP: SetupOptions = {
  source: 'tab',
  useMic: true,
  micId: 'default',
  captureClicks: true
}

const SOURCES: Array<{ id: Source; label: string; hint: string; icon: ReactNode }> = [
  { id: 'tab', label: 'This tab', hint: 'Recommended', icon: <PanelTop className='h-4 w-4' /> },
  { id: 'window', label: 'A window', hint: 'Any app', icon: <AppWindow className='h-4 w-4' /> },
  { id: 'screen', label: 'Whole screen', hint: 'Everything', icon: <Monitor className='h-4 w-4' /> }
]
const SOURCE_NOTES: Record<Source, string> = {
  tab: 'The recording bar sits in the bottom-left corner of the video. You can blur it in the editor.',
  window: 'Your browser will ask which window to share.',
  screen: 'Your browser will ask which screen to share. Close anything private first.'
}

function sizeLabel(bytes: number): string {
  const mb = bytes / 1_048_576
  if (mb < 1) return 'less than 1 MB'
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${Math.round(mb)} MB`
}

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })

export function RecorderSetup({
  title,
  rerecord,
  options,
  onOptions,
  leftovers,
  busyLeftover,
  confirmDiscard,
  onConfirmDiscard,
  onKeep,
  onDiscard,
  error,
  onCancel,
  onStart
}: {
  title: string
  rerecord: boolean
  options: SetupOptions
  onOptions: (o: SetupOptions) => void
  leftovers: Leftover[]
  busyLeftover: string | null
  confirmDiscard: string | null
  onConfirmDiscard: (id: string | null) => void
  onKeep: (id: string) => void
  onDiscard: (id: string) => void
  error: string | null
  onCancel: () => void
  onStart: () => void
}) {
  const ids = useId()
  const [mics, setMics] = useState<MediaDeviceInfo[]>([])
  const set = (patch: Partial<SetupOptions>) => onOptions({ ...options, ...patch })
  const { source } = options

  useEffect(() => {
    let stop = false
    void navigator.mediaDevices
      ?.enumerateDevices()
      .then((d) => !stop && setMics(d.filter((x) => x.kind === 'audioinput')))
      .catch(() => null)
    return () => {
      stop = true
    }
  }, [])

  return (
    <>
      <DialogHeader className='pr-12'>
        <DialogTitle className='text-[16px] text-foreground'>{title}</DialogTitle>
        <DialogDescription className='text-[13px] text-muted-foreground'>
          {rerecord
            ? 'The new recording becomes a fresh draft. The published video stays as it is until you publish again.'
            : 'Show how something works while you talk it through. You can trim, annotate and caption it afterwards.'}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className='space-y-5 text-[13px]'>
        <LeftoverList
          leftovers={leftovers}
          busy={busyLeftover}
          confirmDiscard={confirmDiscard}
          onConfirmDiscard={onConfirmDiscard}
          onKeep={onKeep}
          onDiscard={onDiscard}
        />

        <fieldset>
          <legend id={`${ids}-src`} className='mb-2 font-medium text-foreground'>
            What to record
          </legend>
          <SourcePicker
            value={source}
            onChange={(s) => set({ source: s })}
            labelledBy={`${ids}-src`}
          />
          <p className='mt-2 text-[12.5px] text-muted-foreground'>{SOURCE_NOTES[source]}</p>
        </fieldset>

        <div className='space-y-3.5'>
          <div className='flex items-start gap-2.5'>
            <Checkbox
              id={`${ids}-mic`}
              checked={options.useMic}
              onCheckedChange={(v) => set({ useMic: v === true })}
              className='mt-px'
              data-hv-use-mic
            />
            <div className='min-w-0 flex-1'>
              <Label htmlFor={`${ids}-mic`} className='text-[13px] leading-snug text-foreground'>
                Narrate with my microphone
              </Label>
              {options.useMic && (
                <SimpleSelect
                  value={options.micId}
                  onChange={(v) => set({ micId: v })}
                  ariaLabel='Microphone'
                  className='mt-2 h-9 text-[13px]'
                  options={[
                    { value: 'default', label: 'Default microphone' },
                    ...mics
                      .filter((m) => m.deviceId && m.deviceId !== 'default')
                      .map((m) => ({ value: m.deviceId, label: m.label || 'Microphone' }))
                  ]}
                />
              )}
            </div>
          </div>
          <div className='flex items-start gap-2.5'>
            <Checkbox
              id={`${ids}-clicks`}
              checked={options.captureClicks && source === 'tab'}
              disabled={source !== 'tab'}
              onCheckedChange={(v) => set({ captureClicks: v === true })}
              className='mt-px'
            />
            <div className='min-w-0 flex-1'>
              <Label htmlFor={`${ids}-clicks`} className='text-[13px] leading-snug text-foreground'>
                Capture my clicks
              </Label>
              <p className='mt-1 text-[12.5px] text-muted-foreground'>
                {source === 'tab'
                  ? 'The editor can turn them into click ripples.'
                  : 'Clicks can only be captured when you record this tab.'}
              </p>
            </div>
          </div>
        </div>

        {error && <ErrorNote data-hv-setup-error>{error}</ErrorNote>}
      </DialogBody>
      <DialogFooter className='border-border'>
        <Button variant='ghost' className={ghostBtn} onClick={onCancel}>
          Cancel
        </Button>
        <Button className={primaryBtn} onClick={onStart} data-hv-start>
          Start recording
        </Button>
      </DialogFooter>
    </>
  )
}

/** Tab / window / screen as a radio group: arrow keys move the choice. */
function SourcePicker({
  value,
  onChange,
  labelledBy
}: {
  value: Source
  onChange: (s: Source) => void
  labelledBy: string
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([])
  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0
    if (!step) return
    e.preventDefault()
    const next = (i + step + SOURCES.length) % SOURCES.length
    onChange(SOURCES[next].id)
    refs.current[next]?.focus()
  }
  return (
    <div
      role='radiogroup'
      aria-labelledby={labelledBy}
      className='grid grid-cols-1 gap-2 sm:grid-cols-3'
    >
      {SOURCES.map((s, i) => {
        const on = value === s.id
        return (
          // biome-ignore lint/a11y/useSemanticElements: a segmented control — buttons in a radiogroup, not native radios
          <button
            key={s.id}
            ref={(el) => {
              refs.current[i] = el
            }}
            type='button'
            role='radio'
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(s.id)}
            onKeyDown={(e) => onKey(e, i)}
            data-hv-source={s.id}
            className={`flex min-w-0 items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan motion-reduce:transition-none sm:flex-col sm:items-start sm:gap-1.5 ${
              on ? 'border-nvr-cyan bg-nvr-cyan/10' : 'border-border hover:bg-muted/60'
            }`}
          >
            <span className={on ? 'text-foreground' : 'text-muted-foreground'}>{s.icon}</span>
            <span className='flex min-w-0 flex-1 items-baseline gap-2 sm:block sm:w-full'>
              <span className='block truncate font-medium text-foreground'>{s.label}</span>
              <span className='block truncate text-[12px] text-muted-foreground'>{s.hint}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** Interrupted recordings (keep or discard) and copies the server can no
 *  longer take (discard only). */
function LeftoverList({
  leftovers,
  busy,
  confirmDiscard,
  onConfirmDiscard,
  onKeep,
  onDiscard
}: {
  leftovers: Leftover[]
  busy: string | null
  confirmDiscard: string | null
  onConfirmDiscard: (id: string | null) => void
  onKeep: (id: string) => void
  onDiscard: (id: string) => void
}) {
  const ids = useId()
  const interrupted = leftovers.filter((l) => l.kind === 'interrupted')
  const unsaveable = leftovers.filter((l) => l.kind === 'unsaveable')
  const discard = (l: Leftover) => (
    <ConfirmDiscard
      compact
      confirming={confirmDiscard === l.id}
      busy={!!busy}
      label='Discard'
      onAsk={() => onConfirmDiscard(l.id)}
      onCancel={() => onConfirmDiscard(null)}
      onConfirm={() => onDiscard(l.id)}
    />
  )
  return (
    <>
      {interrupted.length > 0 && (
        <section
          aria-labelledby={`${ids}-left`}
          className='rounded-lg border border-amber-300 bg-amber-50 px-3.5 py-3 dark:border-amber-400/30 dark:bg-amber-400/10'
          data-hv-leftovers
        >
          <div className='flex items-start gap-2.5'>
            <History className='mt-0.5 h-4 w-4 shrink-0 text-amber-700 dark:text-amber-300' />
            <div className='min-w-0 flex-1'>
              <p id={`${ids}-left`} className='font-medium text-amber-950 dark:text-amber-100'>
                {interrupted.length === 1
                  ? 'A recording was interrupted'
                  : `${interrupted.length} recordings were interrupted`}
              </p>
              <ul className='mt-2 space-y-2.5'>
                {interrupted.map((l) => (
                  <li
                    key={l.id}
                    className='flex flex-col items-start gap-2'
                    data-hv-leftover={l.id}
                  >
                    <span className='text-amber-900 dark:text-amber-200'>
                      Started {when(l.created_at as string)}, {sizeLabel(l.bytes)} saved so far.
                      {l.gap &&
                        " The end of this recording didn't reach the server, so only the part before it can be kept."}
                    </span>
                    <span className='flex flex-wrap items-center gap-1.5'>
                      {confirmDiscard !== l.id && (
                        <Button
                          size='sm'
                          className={`h-8 text-[12.5px] ${primaryBtn}`}
                          disabled={!!busy}
                          onClick={() => onKeep(l.id)}
                          data-hv-keep
                        >
                          {l.gap ? 'Keep what was saved' : 'Keep what was recorded'}
                        </Button>
                      )}
                      {discard(l)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      )}
      {unsaveable.length > 0 && (
        <section
          aria-labelledby={`${ids}-gone`}
          className='rounded-lg border border-border bg-muted/50 px-3.5 py-3'
          data-hv-unsaveable
        >
          <div className='flex items-start gap-2.5'>
            <ArchiveX className='mt-0.5 h-4 w-4 shrink-0 text-muted-foreground' />
            <div className='min-w-0 flex-1'>
              <p id={`${ids}-gone`} className='font-medium text-foreground'>
                {unsaveable.length === 1
                  ? 'A recording could not be saved'
                  : `${unsaveable.length} recordings could not be saved`}
              </p>
              <ul className='mt-2 space-y-2.5'>
                {unsaveable.map((l) => (
                  <li
                    key={l.id}
                    className='flex flex-col items-start gap-2'
                    data-hv-leftover={l.id}
                  >
                    <span className='text-muted-foreground'>
                      The server no longer accepts it. Discard removes the copy kept in this browser
                      ({sizeLabel(l.bytes)}).
                    </span>
                    {discard(l)}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>
      )}
    </>
  )
}
