/**
 * Whether the agent's volume options name an NFS export (`type` nfs or nfs4). One helper for
 * every reader (storage health here; the volume-export checks of the NFS work), so the agent
 * never decides it two ways. Pure: no I/O.
 */
export function isNfsOpts(opts: Record<string, unknown> | null | undefined): boolean {
  const type = String(opts?.type ?? '')
    .trim()
    .toLowerCase()
  return type === 'nfs' || type === 'nfs4'
}
