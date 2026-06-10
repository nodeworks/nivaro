import { Keyboard } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { type ShortcutDef, useKeyboardShortcuts } from '@/lib/useKeyboardShortcuts'
import { cn } from '@/lib/utils'

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className='inline-flex h-5 min-w-[20px] items-center justify-center rounded border border-slate-200 bg-slate-50 px-1.5 font-mono text-[11px] font-medium text-slate-600 shadow-sm dark:border-border dark:bg-slate-800 dark:text-slate-300'>
      {children}
    </kbd>
  )
}

function ShortcutRow({
  shortcut,
  rebinding,
  onStartRebind
}: {
  shortcut: ShortcutDef
  rebinding: boolean
  onStartRebind: () => void
}) {
  return (
    <button
      type='button'
      onClick={onStartRebind}
      className={cn(
        'flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/50',
        rebinding && 'bg-nvr-cyan/10 ring-1 ring-nvr-cyan/40'
      )}
      title='Click to rebind, then press the new key(s)'
    >
      <span className='text-[12.5px] text-slate-700 dark:text-slate-300'>{shortcut.label}</span>
      <span className='flex shrink-0 items-center gap-1'>
        {rebinding ? (
          <span className='text-[11px] font-medium text-nvr-cyan'>Press new key…</span>
        ) : (
          shortcut.keys.split(' ').map((k, i) => (
            <span key={`${shortcut.id}-${k}`} className='flex items-center gap-1'>
              {i > 0 && <span className='text-[10px] text-slate-300'>then</span>}
              <Kbd>{k}</Kbd>
            </span>
          ))
        )}
      </span>
    </button>
  )
}

/**
 * Mounts the global keyboard shortcut listener and the "?" shortcuts overlay.
 * Render once inside the router (AppLayout).
 */
export function KeyboardShortcuts() {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [rebindingId, setRebindingId] = useState<string | null>(null)

  const { shortcuts, rebind } = useKeyboardShortcuts({
    'toggle-overlay': () => setOpen((v) => !v),
    'go-dashboard': () => navigate('/'),
    'go-collections': () => navigate('/collections'),
    'go-notifications': () => navigate('/notifications'),
    'new-item': () => window.dispatchEvent(new CustomEvent('nivaro:new-item')),
    'focus-search': () => window.dispatchEvent(new CustomEvent('nivaro:focus-search'))
  })

  // Capture the next key(s) while rebinding. A second key within 800ms makes a sequence.
  useEffect(() => {
    if (!rebindingId) return
    let firstKey: string | null = null
    let timer: ReturnType<typeof setTimeout> | null = null

    const commit = (keys: string) => {
      rebind(rebindingId, keys)
      setRebindingId(null)
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      e.preventDefault()
      e.stopPropagation()
      if (e.key === 'Escape') {
        if (timer) clearTimeout(timer)
        setRebindingId(null)
        return
      }
      if (e.key.length > 1) return // only printable keys
      if (!firstKey) {
        const key = e.key
        firstKey = key
        timer = setTimeout(() => commit(key), 800)
      } else {
        if (timer) clearTimeout(timer)
        commit(`${firstKey} ${e.key}`)
      }
    }

    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      if (timer) clearTimeout(timer)
    }
  }, [rebindingId, rebind])

  const mid = Math.ceil(shortcuts.length / 2)
  const columns = [shortcuts.slice(0, mid), shortcuts.slice(mid)]

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setRebindingId(null)
      }}
    >
      <DialogContent className='max-w-2xl'>
        <DialogHeader>
          <DialogTitle className='flex items-center gap-2 text-[15px]'>
            <Keyboard className='h-4 w-4 text-nvr-cyan' />
            Keyboard Shortcuts
          </DialogTitle>
        </DialogHeader>
        <div className='grid grid-cols-2 gap-x-6 gap-y-0.5'>
          {columns.map((col, ci) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed two-column layout
            <div key={ci} className='space-y-0.5'>
              {col.map((s) => (
                <ShortcutRow
                  key={s.id}
                  shortcut={s}
                  rebinding={rebindingId === s.id}
                  onStartRebind={() => setRebindingId(s.id)}
                />
              ))}
            </div>
          ))}
        </div>
        <p className='text-[11px] text-slate-400'>
          Click a shortcut, then press the new key (or two keys quickly for a sequence). Press{' '}
          <Kbd>Esc</Kbd> to cancel. Customizations are saved to this browser.
        </p>
      </DialogContent>
    </Dialog>
  )
}
