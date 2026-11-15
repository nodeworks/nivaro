import { type ScreenShareRuntime, ScreenShareHost as SharedScreenShareHost } from '@nivaro/shared'

/**
 * Share my screen with support (realtime idea 24) for headless hosts: mount once in the app
 * shell, inside NivaroProvider and the RealtimeContext. It shows the "Sharing with … · Stop" bar
 * and lets support tickets offer sharing / the live view. Needs `rrweb` installed in the app
 * (an optional peer, as for session recording); without it the feature stays hidden.
 */
const rrwebRuntime: ScreenShareRuntime = {
  loadRecord: async () => {
    try {
      return (await import('rrweb')).record as never
    } catch {
      return null
    }
  },
  loadReplayer: async () => {
    try {
      return (await import('rrweb')).Replayer as never
    } catch {
      return null
    }
  }
}

export function ScreenShareHost() {
  return <SharedScreenShareHost runtime={rrwebRuntime} />
}
