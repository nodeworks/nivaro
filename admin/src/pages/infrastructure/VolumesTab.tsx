import { formatFileSize, formatRelative } from '@/lib/utils'
import {
  DataTable,
  Empty,
  Flags,
  InventoryTab,
  Pill,
  Stat,
  StatStrip,
  Td,
  Th
} from './inventory-ui'
import { Chip, Dash, Note } from './ui'

interface Vol {
  name: string
  kind: 'volume' | 'bind'
  driver: string | null
  anonymous: boolean
  size_bytes: number | null
  owner: string | null
  containers: string[]
  orphaned: boolean
  last_write: number | null
  backup: 'label' | 'env' | 'none'
  flags: Array<{ code: string; text: string }>
}
interface Inv {
  volumes: Vol[]
  reclaimable_bytes: number
  orphan_count: number
  last_write_known: boolean
}

const unbacked = (inv: Inv) =>
  inv.volumes.filter((v) => v.flags.some((f) => f.code === 'unbacked-in-use')).length

/** Named volumes and bind mounts: size, owner, users, orphans, backup coverage (#2832). */
export function VolumesTab() {
  return (
    <InventoryTab<Inv>
      area='volumes'
      intro='Named volumes and bind mounts. A volume counts as backed up when its name matches INFRA_BACKED_UP_VOLUMES or it carries the label nivaro.backup=true.'
      aside={(inv) =>
        unbacked(inv) > 0 ? (
          <Chip tone='warn'>{unbacked(inv)} not backed up</Chip>
        ) : inv.volumes.length ? (
          <Chip tone='ok'>All in-use volumes backed up</Chip>
        ) : null
      }
    >
      {(inv) =>
        inv.volumes.length === 0 ? (
          <Empty>No volumes or bind mounts on this host.</Empty>
        ) : (
          <div className='space-y-3'>
            <StatStrip>
              <Stat label='Volumes and mounts' value={inv.volumes.length} />
              <Stat
                label='Orphaned'
                value={inv.orphan_count}
                tone={inv.orphan_count ? 'warn' : undefined}
              />
              <Stat
                label='Reclaimable from orphans'
                value={formatFileSize(inv.reclaimable_bytes)}
              />
              <Stat
                label='Not backed up, in use'
                value={unbacked(inv)}
                tone={unbacked(inv) ? 'warn' : undefined}
              />
            </StatStrip>
            {!inv.last_write_known && (
              <Note>Host facts not collected, so last write times are not shown.</Note>
            )}
            {
              <DataTable
                head={
                  <>
                    <Th>Volume</Th>
                    <Th className='text-right'>Size</Th>
                    <Th>Owner</Th>
                    <Th>Used by</Th>
                    <Th>Last write</Th>
                    <Th>Backup</Th>
                  </>
                }
              >
                {inv.volumes.map((v) => (
                  <tr key={`${v.kind}:${v.name}`}>
                    <Td className='max-w-[320px]'>
                      <div className='flex items-center gap-1.5'>
                        <span
                          className='truncate font-mono font-medium text-slate-900 dark:text-foreground'
                          data-tip={v.name.length > 36 || v.anonymous ? v.name : undefined}
                        >
                          {v.anonymous ? `${v.name.slice(0, 12)}…` : v.name}
                        </span>
                        {v.kind === 'bind' && <Pill>bind</Pill>}
                        {v.anonymous && <Pill>anonymous</Pill>}
                        {v.orphaned && <Pill tone='amber'>orphaned</Pill>}
                      </div>
                      <Flags flags={v.flags} />
                    </Td>
                    <Td className='whitespace-nowrap text-right tabular-nums'>
                      {v.size_bytes != null ? formatFileSize(v.size_bytes) : <Dash />}
                    </Td>
                    <Td className='whitespace-nowrap'>{v.owner ?? <Dash />}</Td>
                    <Td className='max-w-[240px] break-words font-mono'>
                      {v.containers.length ? (
                        v.containers.join(', ')
                      ) : (
                        <span className='font-sans text-slate-500 dark:text-muted-foreground'>
                          nothing
                        </span>
                      )}
                    </Td>
                    <Td className='whitespace-nowrap'>
                      {v.last_write ? formatRelative(new Date(v.last_write * 1000)) : <Dash />}
                    </Td>
                    <Td>
                      {v.backup === 'none' ? (
                        <Pill tone={v.orphaned ? 'slate' : 'amber'}>Not covered</Pill>
                      ) : (
                        <Pill tone='green'>{v.backup === 'label' ? 'Label' : 'Listed'}</Pill>
                      )}
                    </Td>
                  </tr>
                ))}
              </DataTable>
            }
          </div>
        )
      }
    </InventoryTab>
  )
}
