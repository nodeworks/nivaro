import {
  Briefcase,
  Bug,
  Building2,
  Calendar,
  DollarSign,
  Hash,
  Lightbulb,
  type LucideIcon,
  Map as MapIcon,
  Megaphone,
  Package,
  Shield,
  Star,
  Truck,
  Users,
  Wrench,
  Zap
} from 'lucide-react'
import { cn } from '../../lib/utils'

/**
 * How a channel looks (#959): an icon from a fixed set and a colour from a
 * fixed palette. The names and hexes mirror CHANNEL_ICONS / CHANNEL_COLORS in
 * the API (services/chat.ts), which refuses anything else.
 */
export const CHANNEL_ICON_SET: Record<string, { icon: LucideIcon; label: string }> = {
  hash: { icon: Hash, label: 'Hash' },
  megaphone: { icon: Megaphone, label: 'Announcements' },
  users: { icon: Users, label: 'People' },
  briefcase: { icon: Briefcase, label: 'Business' },
  wrench: { icon: Wrench, label: 'Engineering' },
  truck: { icon: Truck, label: 'Logistics' },
  package: { icon: Package, label: 'Inventory' },
  dollar: { icon: DollarSign, label: 'Finance' },
  building: { icon: Building2, label: 'Sites' },
  map: { icon: MapIcon, label: 'Regions' },
  zap: { icon: Zap, label: 'Power' },
  shield: { icon: Shield, label: 'Security' },
  bug: { icon: Bug, label: 'Issues' },
  lightbulb: { icon: Lightbulb, label: 'Ideas' },
  calendar: { icon: Calendar, label: 'Planning' },
  star: { icon: Star, label: 'Highlights' }
}

export const CHANNEL_COLOR_SET: Array<{ hex: string; label: string }> = [
  { hex: '#0ea5e9', label: 'Sky' },
  { hex: '#14b8a6', label: 'Teal' },
  { hex: '#10b981', label: 'Green' },
  { hex: '#f59e0b', label: 'Amber' },
  { hex: '#f97316', label: 'Orange' },
  { hex: '#ef4444', label: 'Red' },
  { hex: '#ec4899', label: 'Pink' },
  { hex: '#8b5cf6', label: 'Violet' },
  { hex: '#6366f1', label: 'Indigo' },
  { hex: '#64748b', label: 'Slate' }
]

/**
 * The square tile beside a channel's name. With a colour, the tint and the
 * icon are mixed against the surrounding text colour, so the same hex reads
 * darker on a light surface and lighter on a dark one without a second value.
 */
export function ChannelTile({
  icon,
  color,
  size = 32,
  fallback: Fallback = Hash,
  className
}: {
  icon?: string | null
  color?: string | null
  size?: number
  fallback?: LucideIcon
  className?: string
}) {
  const Icon = (icon && CHANNEL_ICON_SET[icon]?.icon) || Fallback
  const glyph = Math.round(size * 0.5)
  return (
    <span
      className={cn(
        'flex shrink-0 items-center justify-center rounded-lg',
        color
          ? 'text-slate-800 dark:text-slate-100'
          : 'bg-slate-100 text-slate-500 dark:bg-muted dark:text-slate-400',
        className
      )}
      style={{
        width: size,
        height: size,
        ...(color ? { backgroundColor: `color-mix(in srgb, ${color} 18%, transparent)` } : {})
      }}
      data-chat-channel-tile={icon ?? 'default'}
    >
      <Icon
        style={{
          width: glyph,
          height: glyph,
          ...(color ? { color: `color-mix(in srgb, ${color} 70%, currentColor)` } : {})
        }}
        strokeWidth={1.8}
      />
    </span>
  )
}

/** Icon grid + colour swatches, used when creating a channel and in its settings. */
export function ChannelLookPicker({
  icon,
  color,
  onChange,
  disabled
}: {
  icon: string | null
  color: string | null
  onChange: (next: { icon: string | null; color: string | null }) => void
  disabled?: boolean
}) {
  return (
    <div className='space-y-2' data-chat-channel-look>
      <div>
        <p className='mb-1 text-[11px] font-medium text-slate-500 dark:text-slate-400'>Icon</p>
        <div className='flex flex-wrap gap-1'>
          {Object.entries(CHANNEL_ICON_SET).map(([key, { icon: I, label }]) => {
            const on = (icon ?? 'hash') === key
            return (
              <button
                key={key}
                type='button'
                disabled={disabled}
                aria-pressed={on}
                aria-label={label}
                title={label}
                onClick={() => onChange({ icon: key === 'hash' ? null : key, color })}
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded-md border transition-colors disabled:opacity-50',
                  on
                    ? 'border-slate-400 bg-slate-100 text-slate-800 dark:border-slate-500 dark:bg-muted dark:text-slate-100'
                    : 'border-transparent text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-muted'
                )}
                data-chat-channel-icon={key}
              >
                <I className='h-3.5 w-3.5' strokeWidth={1.8} />
              </button>
            )
          })}
        </div>
      </div>
      <div>
        <p className='mb-1 text-[11px] font-medium text-slate-500 dark:text-slate-400'>Colour</p>
        <div className='flex flex-wrap items-center gap-1.5'>
          <button
            type='button'
            disabled={disabled}
            aria-pressed={!color}
            onClick={() => onChange({ icon, color: null })}
            className={cn(
              'h-6 rounded-full border px-2 text-[11px] disabled:opacity-50',
              !color
                ? 'border-slate-400 text-slate-700 dark:border-slate-500 dark:text-slate-200'
                : 'border-slate-200 text-slate-500 dark:border-border dark:text-slate-400'
            )}
            data-chat-channel-color='none'
          >
            None
          </button>
          {CHANNEL_COLOR_SET.map((c) => {
            const on = color?.toLowerCase() === c.hex
            return (
              <button
                key={c.hex}
                type='button'
                disabled={disabled}
                aria-pressed={on}
                aria-label={c.label}
                title={c.label}
                onClick={() => onChange({ icon, color: c.hex })}
                className={cn(
                  'h-6 w-6 rounded-full border-2 transition-transform disabled:opacity-50',
                  on ? 'scale-110 border-slate-800 dark:border-white' : 'border-transparent'
                )}
                style={{ backgroundColor: c.hex }}
                data-chat-channel-color={c.hex}
              />
            )
          })}
        </div>
      </div>
    </div>
  )
}
