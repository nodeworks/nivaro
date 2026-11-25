import { cn } from '@/lib/utils'

/**
 * The Nivaro Hub mark: a signal tower sending from its beacon (original artwork; the same
 * geometry as admin/public/hub-brand/*.svg). Amber on deep slate-navy, so it reads on light and
 * dark backgrounds alike and never looks like Nivaro's cyan N.
 */
export function HubGlyph({
  size = 24,
  tile = true,
  className
}: {
  size?: number
  /** false = the bare tower in currentColor (on a surface that is already dark). */
  tile?: boolean
  className?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox='0 0 32 32'
      aria-hidden='true'
      className={cn('shrink-0', className)}
      data-hub-glyph=''
    >
      {tile && <rect width='32' height='32' rx='7.5' fill='#0d1726' />}
      <g
        fill='none'
        stroke={tile ? '#f5a623' : 'currentColor'}
        strokeLinecap='round'
        strokeLinejoin='round'
      >
        <path strokeWidth='2.1' d='M12 6.2a5.6 5.6 0 0 0 0 8M20 6.2a5.6 5.6 0 0 1 0 8' />
        <path
          strokeWidth='1.6'
          opacity='.55'
          d='M8.6 3.6a9.6 9.6 0 0 0 0 13.2M23.4 3.6a9.6 9.6 0 0 1 0 13.2'
        />
        <path strokeWidth='2.1' d='M16 14.4 11.2 26.6M16 14.4l4.8 12.2M12.9 22.2h6.2' />
      </g>
      <circle cx='16' cy='10.2' r='2.3' fill={tile ? '#f5a623' : 'currentColor'} />
    </svg>
  )
}

/**
 * "Nivaro Hub" with the mark. `onDark` = on the Hub chrome (always dark); otherwise it follows
 * the theme. An operator's own logo (Settings → Project) replaces the mark, never the "Hub"
 * name, so people still know which product they are in.
 */
export function HubWordmark({
  size = 'md',
  onDark = false,
  logoUrl,
  className
}: {
  size?: 'sm' | 'md' | 'lg'
  onDark?: boolean
  logoUrl?: string | null
  className?: string
}) {
  const glyph = size === 'lg' ? 40 : size === 'sm' ? 22 : 28
  return (
    <span
      className={cn('inline-flex items-center gap-2.5', className)}
      data-hub-wordmark=''
      role='img'
      aria-label='Nivaro Hub'
    >
      {logoUrl ? (
        <img
          src={logoUrl}
          alt=''
          className='object-contain'
          style={{ maxHeight: glyph, maxWidth: glyph * 1.6 }}
        />
      ) : (
        <HubGlyph size={glyph} />
      )}
      <span
        aria-hidden
        className={cn(
          'flex items-baseline gap-[0.32em] whitespace-nowrap leading-none tracking-[-0.02em]',
          size === 'lg' ? 'text-[26px]' : size === 'sm' ? 'text-[14px]' : 'text-[16px]',
          onDark ? 'text-white' : 'text-slate-900 dark:text-foreground'
        )}
      >
        <span className={cn('font-normal', onDark ? 'text-white/70' : 'opacity-70')}>Nivaro</span>
        <span className='font-bold'>Hub</span>
      </span>
    </span>
  )
}
