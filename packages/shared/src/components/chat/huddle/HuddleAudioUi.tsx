import { Keyboard, MicOff, Settings2, Volume2, WifiOff } from 'lucide-react'
import type React from 'react'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { cn } from '../../../lib/utils'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { SimpleSelect } from '../../ui/SimpleSelect'
import { Skeleton } from '../../ui/skeleton'
import { Switch } from '../../ui/switch'
import { createLevelMeter, playTestTone, speakerChoiceSupported } from './huddle-audio'
import {
  type DeviceLike,
  HUDDLE_SHORTCUTS,
  isPseudoDevice,
  meterFill,
  type PeerQuality,
  qualityTip
} from './huddle-audio-logic'
import { type HuddleDevicePrefs, loadDevicePrefs } from './huddle-device-prefs'
import {
  type AudioDevices,
  applyDevicePrefs,
  currentMicId,
  listAudioDevices,
  openMic
} from './huddle-devices'
import { huddleShortcuts } from './huddle-shortcuts'
import { huddleSpeaking } from './huddle-speaking'
import { useHuddleShortcuts } from './useHuddleAudio'

/**
 * Huddle audio UI (#2845–#2848): the speaking ring, connection bars, the
 * poor-connection banner, the microphone/speaker popover (also the pre-join
 * check) and the keyboard cheat-sheet. Every piece reads the engines in
 * huddle-speaking / huddle-link-quality / huddle-shortcuts / huddle-devices.
 */

// ── #2845 Speaking ring ─────────────────────────────────────────────────────

/** A ring around an avatar while that person speaks; static under reduced motion. */
export function SpeakingRing({
  speaking,
  children
}: {
  speaking: boolean
  children: React.ReactNode
}) {
  return (
    <span className='relative inline-flex rounded-full' style={{ lineHeight: 0 }}>
      {children}
      <span
        aria-hidden
        className={cn(
          'pointer-events-none absolute -inset-[2px] rounded-full ring-2 ring-emerald-500 transition-opacity duration-150 dark:ring-emerald-400',
          speaking ? 'opacity-100 motion-safe:animate-pulse' : 'opacity-0'
        )}
        data-huddle-speaking={speaking ? 'on' : 'off'}
      />
    </span>
  )
}

// ── #2848 Connection quality ────────────────────────────────────────────────

const BAR_TONE: Record<number, string> = {
  4: 'bg-emerald-500 dark:bg-emerald-400',
  3: 'bg-emerald-500 dark:bg-emerald-400',
  2: 'bg-amber-500 dark:bg-amber-400',
  1: 'bg-red-500 dark:bg-red-400'
}

/** Four bars with the numbers behind them in the tip. */
export function QualityBars({ name, quality }: { name: string; quality?: PeerQuality }) {
  const bars = quality?.bars ?? 0
  const tip = qualityTip(name, quality)
  return (
    <span
      role='img'
      aria-label={tip}
      data-tip={tip}
      data-huddle-quality={bars}
      className='inline-flex h-2.5 items-end gap-px'
    >
      {[1, 2, 3, 4].map((n) => (
        <span
          key={n}
          className={cn(
            'w-[2px] rounded-[1px]',
            n <= bars ? BAR_TONE[bars] : 'bg-slate-300 dark:bg-slate-600'
          )}
          style={{ height: `${3 + n * 2}px` }}
        />
      ))}
    </span>
  )
}

export function PoorConnectionBanner({ sharing }: { sharing: boolean }) {
  return (
    <div
      role='status'
      className='mt-1.5 flex items-start gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-[11.5px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'
      data-huddle-poor
    >
      <WifiOff className='mt-px h-3.5 w-3.5 shrink-0' strokeWidth={2} />
      <span>
        Your connection is poor — others may hear you break up.
        {sharing && ' Your shared screen is sent at a lower quality until it recovers.'}
      </span>
    </div>
  )
}

export function MutedTalkingHint() {
  return (
    <span
      role='status'
      className='inline-flex h-6 items-center gap-1 rounded-full bg-red-50 px-2 text-[11px] font-medium text-red-700 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150 dark:bg-red-500/15 dark:text-red-200'
      data-huddle-muted-talking
    >
      <MicOff className='h-3 w-3' strokeWidth={2} />
      You are muted — hold Space to talk
    </span>
  )
}

// ── #2847 Level meter ───────────────────────────────────────────────────────

/** A live bar for one level source, drawn per animation frame without re-rendering React. */
export function LevelMeter({ read }: { read: () => number }) {
  const fill = useRef<HTMLSpanElement>(null)
  const readRef = useRef(read)
  readRef.current = read
  useEffect(() => {
    let raf = 0
    let shown = 0
    const draw = () => {
      // Rise fast, fall slower: a meter that reads like one.
      const target = meterFill(readRef.current())
      shown = target > shown ? target : shown * 0.85 + target * 0.15
      if (fill.current) fill.current.style.transform = `scaleX(${shown.toFixed(3)})`
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <span
      aria-hidden
      className='block h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700'
      data-huddle-meter
    >
      <span
        ref={fill}
        className='block h-full w-full origin-left rounded-full bg-emerald-500 dark:bg-emerald-400'
        style={{ transform: 'scaleX(0)' }}
      />
    </span>
  )
}

// ── #2847 Device panel ──────────────────────────────────────────────────────

function deviceOptions(list: DeviceLike[], noun: string) {
  const def = list.find((d) => d.deviceId === 'default')
  const real = list.filter((d) => !isPseudoDevice(d))
  return [
    {
      value: '',
      label: def?.label ? def.label.replace(/^Default\s*-\s*/i, 'Default — ') : 'System default'
    },
    ...real.map((d, i) => ({ value: d.deviceId, label: d.label || `${noun} ${i + 1}` }))
  ]
}

const TOGGLES: Array<{ key: keyof HuddleDevicePrefs; label: string; hint: string }> = [
  { key: 'noiseSuppression', label: 'Noise suppression', hint: 'Filters out typing and fans' },
  {
    key: 'echoCancellation',
    label: 'Echo cancellation',
    hint: 'Keeps your speakers out of your mic'
  },
  { key: 'autoGainControl', label: 'Automatic volume', hint: 'Evens out how loud you sound' }
]

/**
 * Microphone, speaker and processing choices with a live level meter. In a
 * huddle the meter listens to the microphone being sent (it still moves
 * while muted); before joining it opens the chosen microphone on its own and
 * closes it when the panel closes.
 */
export function DevicePanel({
  mode,
  muted,
  onJoin,
  onShortcuts
}: {
  mode: 'live' | 'prejoin'
  muted?: boolean
  onJoin?: () => void
  onShortcuts?: () => void
}) {
  const [prefs, setPrefs] = useState<HuddleDevicePrefs>(loadDevicePrefs)
  const [devices, setDevices] = useState<AudioDevices | null>(null)
  const [micError, setMicError] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)
  const preview = useRef<{
    stream: MediaStream
    meter: ReturnType<typeof createLevelMeter>
  } | null>(null)
  const speakerChoice = speakerChoiceSupported()
  const uid = useId()

  const refresh = useCallback(() => {
    void listAudioDevices().then(setDevices)
  }, [])
  useEffect(() => {
    refresh()
    const md = navigator.mediaDevices
    md?.addEventListener?.('devicechange', refresh)
    return () => md?.removeEventListener?.('devicechange', refresh)
  }, [refresh])

  // Pre-join: open the chosen microphone for the meter (labels appear once it is allowed).
  const micPrefs = useMemo<HuddleDevicePrefs>(
    () => ({
      micId: prefs.micId,
      speakerId: null,
      noiseSuppression: prefs.noiseSuppression,
      echoCancellation: prefs.echoCancellation,
      autoGainControl: prefs.autoGainControl
    }),
    [prefs.micId, prefs.noiseSuppression, prefs.echoCancellation, prefs.autoGainControl]
  )
  useEffect(() => {
    if (mode !== 'prejoin') return
    let cancelled = false
    setMicError(null)
    openMic(micPrefs)
      .then((stream) => {
        if (cancelled) {
          for (const t of stream.getTracks()) t.stop()
          return
        }
        preview.current = { stream, meter: createLevelMeter(stream) }
        refresh()
      })
      .catch((err: { name?: string }) => {
        if (!cancelled) {
          setMicError(
            err?.name === 'NotAllowedError'
              ? 'Microphone access is blocked for this site.'
              : 'This microphone could not be started.'
          )
        }
      })
    return () => {
      cancelled = true
      preview.current?.meter?.stop()
      for (const t of preview.current?.stream.getTracks() ?? []) t.stop()
      preview.current = null
    }
  }, [mode, micPrefs, refresh])

  const read = useCallback(
    () => (mode === 'live' ? huddleSpeaking.selfLevel() : (preview.current?.meter?.level() ?? 0)),
    [mode]
  )

  const change = async (patch: Partial<HuddleDevicePrefs>) => {
    setPrefs((p) => ({ ...p, ...patch }))
    if (mode === 'prejoin') {
      await applyDevicePrefs(patch) // remembered; nothing live to swap
      return
    }
    const ok = await applyDevicePrefs(patch)
    if (!ok) toast.error('That microphone could not be started — still using the previous one.')
  }

  const testSpeaker = async () => {
    setTesting(true)
    try {
      await playTestTone(speakerChoice ? (prefs.speakerId ?? '') : '')
    } finally {
      setTesting(false)
    }
  }

  const liveMic = mode === 'live' ? currentMicId() : null
  const micValue =
    prefs.micId && devices?.mics.some((d) => d.deviceId === prefs.micId) ? prefs.micId : ''
  const speakerValue =
    prefs.speakerId && devices?.speakers.some((d) => d.deviceId === prefs.speakerId)
      ? prefs.speakerId
      : ''
  const selectClass =
    'h-7 w-full gap-1 rounded-md border-slate-200 bg-white px-2 text-left text-[12px] dark:border-border dark:bg-card [&>span]:min-w-0 [&>span]:flex-1 [&>span]:truncate'

  return (
    <div className='flex flex-col gap-3 text-[12px]' data-huddle-devices={mode}>
      <div className='flex flex-col gap-1.5'>
        <span className='text-[11.5px] font-medium text-slate-700 dark:text-slate-200'>
          Microphone
        </span>
        {devices ? (
          <SimpleSelect
            value={micValue}
            onChange={(v) => void change({ micId: v || null })}
            options={deviceOptions(devices.mics, 'Microphone')}
            ariaLabel='Microphone'
            className={selectClass}
            triggerProps={{ 'data-huddle-mic': liveMic ?? '' }}
          />
        ) : (
          <Skeleton className='h-7 w-full' />
        )}
        {micError ? (
          <span className='text-[11px] text-red-600 dark:text-red-300' role='alert'>
            {micError}
          </span>
        ) : (
          <>
            <LevelMeter read={read} />
            <span className='text-[11px] text-slate-500 dark:text-slate-400'>
              {mode === 'live' && muted
                ? 'You are muted — the bar still shows your level, nobody hears it.'
                : 'Say something — the bar should move.'}
            </span>
          </>
        )}
      </div>

      <div className='flex flex-col gap-1.5'>
        <span className='text-[11.5px] font-medium text-slate-700 dark:text-slate-200'>
          Speaker
        </span>
        <div className='flex items-center gap-1.5'>
          {speakerChoice &&
            (devices ? (
              <SimpleSelect
                value={speakerValue}
                onChange={(v) => void change({ speakerId: v || null })}
                options={deviceOptions(devices.speakers, 'Speaker')}
                ariaLabel='Speaker'
                className={cn(selectClass, 'min-w-0 flex-1')}
              />
            ) : (
              <Skeleton className='h-7 min-w-0 flex-1' />
            ))}
          <button
            type='button'
            onClick={() => void testSpeaker()}
            disabled={testing}
            className={cn(
              'flex h-7 shrink-0 items-center gap-1 rounded-md border border-slate-200 bg-white px-2 text-[11.5px] font-medium text-slate-700 transition-colors hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan disabled:opacity-60 dark:border-border dark:bg-card dark:text-slate-200 dark:hover:bg-white/5',
              !speakerChoice && 'self-start'
            )}
            data-huddle-test-speaker
          >
            <Volume2 className='h-3.5 w-3.5' strokeWidth={2} />
            {testing ? 'Playing…' : 'Test speaker'}
          </button>
        </div>
      </div>

      <div className='flex flex-col gap-2 border-t border-slate-200 pt-2.5 dark:border-border'>
        {TOGGLES.map((t) => (
          <div key={t.key} className='flex items-center justify-between gap-3'>
            <label htmlFor={`${uid}-${t.key}`} className='flex min-w-0 cursor-pointer flex-col'>
              <span className='text-[12px] text-slate-700 dark:text-slate-200'>{t.label}</span>
              <span className='text-[11px] text-slate-500 dark:text-slate-400'>{t.hint}</span>
            </label>
            <Switch
              id={`${uid}-${t.key}`}
              checked={prefs[t.key] as boolean}
              onCheckedChange={(v) => void change({ [t.key]: v })}
              className='h-4 w-7 [&>span]:h-3 [&>span]:w-3 [&>span]:data-[state=checked]:translate-x-3'
              data-huddle-toggle={t.key}
            />
          </div>
        ))}
      </div>

      {mode === 'prejoin' ? (
        <button
          type='button'
          onClick={onJoin}
          className='flex h-8 items-center justify-center rounded-md bg-nvr-cyan text-[12px] font-medium text-white transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan focus-visible:ring-offset-2 dark:focus-visible:ring-offset-background'
          data-huddle-prejoin-join
        >
          Join huddle
        </button>
      ) : (
        onShortcuts && (
          <button
            type='button'
            onClick={onShortcuts}
            className='flex items-center justify-between rounded-md px-1 py-0.5 text-[11.5px] text-slate-600 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-slate-300 dark:hover:bg-white/10'
          >
            <span className='inline-flex items-center gap-1.5'>
              <Keyboard className='h-3.5 w-3.5' strokeWidth={2} />
              Keyboard shortcuts
            </span>
            <Kbd>?</Kbd>
          </button>
        )
      )}
    </div>
  )
}

/** The controls' gear: microphone, speaker and processing while in a huddle. */
export function DeviceSettingsButton({ muted }: { muted: boolean }) {
  const [open, setOpen] = useState(false)
  const toShortcuts = useRef(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className={cn(
            'flex h-6 w-6 items-center justify-center rounded text-slate-600 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan dark:text-slate-300 dark:hover:bg-white/10',
            open && 'bg-slate-100 dark:bg-white/10'
          )}
          aria-label='Microphone and speaker settings'
          data-tip='Microphone and speaker'
          data-huddle-device-button
        >
          <Settings2 className='h-3.5 w-3.5' strokeWidth={2} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align='end'
        className='w-72 p-3'
        onCloseAutoFocus={(e) => {
          // Handing over to the cheat-sheet: focus going back to the gear would dismiss it.
          if (!toShortcuts.current) return
          toShortcuts.current = false
          e.preventDefault()
          huddleShortcuts.setHelpOpen(true)
        }}
      >
        {open && (
          <DevicePanel
            mode='live'
            muted={muted}
            onShortcuts={() => {
              toShortcuts.current = true
              setOpen(false)
            }}
          />
        )}
      </PopoverContent>
    </Popover>
  )
}

/** "Check your microphone first" beside Start / Join; the main button still joins in one click. */
export function PreJoinCheck({
  onJoin,
  children
}: {
  onJoin: () => void
  /** The trigger button. */
  children: React.ReactElement
}) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align='end' className='w-72 p-3'>
        {open && (
          <div className='flex flex-col gap-2.5'>
            <div className='flex flex-col'>
              <span className='text-[12.5px] font-semibold text-slate-800 dark:text-slate-100'>
                Check before you join
              </span>
              <span className='text-[11px] text-slate-500 dark:text-slate-400'>
                Pick a microphone and make sure the bar moves when you talk.
              </span>
            </div>
            <DevicePanel
              mode='prejoin'
              onJoin={() => {
                setOpen(false)
                onJoin()
              }}
            />
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

// ── #2846 Cheat-sheet ───────────────────────────────────────────────────────

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className='inline-flex h-5 min-w-5 items-center justify-center rounded border border-slate-200 bg-slate-50 px-1 font-sans text-[10.5px] font-medium text-slate-600 dark:border-border dark:bg-muted dark:text-slate-300'>
      {children}
    </kbd>
  )
}

/**
 * Sits at the end of the huddle controls: `?` (or the link in the device
 * popover) opens the shortcut list anchored there.
 */
export function ShortcutSheetAnchor() {
  const { helpOpen } = useHuddleShortcuts()
  return (
    <Popover open={helpOpen} onOpenChange={(o) => huddleShortcuts.setHelpOpen(o)}>
      <PopoverAnchor asChild>
        <span aria-hidden className='w-0 self-stretch' />
      </PopoverAnchor>
      <PopoverContent align='end' className='w-64 p-3' data-huddle-shortcuts>
        <div className='mb-2 text-[12.5px] font-semibold text-slate-800 dark:text-slate-100'>
          Huddle shortcuts
        </div>
        <ul className='flex flex-col gap-1.5'>
          {HUDDLE_SHORTCUTS.map((s) => (
            <li key={s.label} className='flex items-center justify-between gap-3 text-[12px]'>
              <span className='text-slate-600 dark:text-slate-300'>{s.label}</span>
              <span className='flex shrink-0 items-center gap-0.5'>
                {s.keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
        <p className='mt-2.5 text-[11px] text-slate-500 dark:text-slate-400'>
          These work while you are in a huddle and not typing in a field. While you share, L asks
          once more before leaving.
        </p>
      </PopoverContent>
    </Popover>
  )
}
