/**
 * Settings → Huddles connection test: gather ICE candidates against the configured
 * STUN/TURN servers and report what came back. A `relay` candidate proves the TURN server
 * answered, accepted the credential and handed out a relay port; a `srflx` candidate proves
 * STUN answered. Nothing is sent to another person — the peer connection never connects.
 */

export interface IceServerDto {
  urls: string[]
  username?: string
  credential?: string
}

export interface IceProbeResult {
  /** Address of the first relay candidate (TURN works), else null. */
  relay: string | null
  /** Address of the first server-reflexive candidate (STUN works), else null. */
  srflx: string | null
  /** True when the browser only found its own local addresses. */
  hostOnly: boolean
  ms: number
  error: string | null
}

export interface GatheredCandidate {
  type: string | null
  address: string | null
  port: number | null
}

/** Pure: what a list of gathered candidates proves. */
export function summarizeCandidates(
  cands: GatheredCandidate[],
  ms: number,
  error: string | null = null
): IceProbeResult {
  const at = (c: GatheredCandidate | undefined) =>
    c ? `${c.address ?? '?'}${c.port ? `:${c.port}` : ''}` : null
  const relay = at(cands.find((c) => c.type === 'relay'))
  const srflx = at(cands.find((c) => c.type === 'srflx'))
  return { relay, srflx, hostOnly: !relay && !srflx, ms, error }
}

export async function probeIce(
  iceServers: IceServerDto[],
  timeoutMs = 8000
): Promise<IceProbeResult> {
  const started = performance.now()
  const elapsed = () => Math.round(performance.now() - started)
  if (typeof RTCPeerConnection === 'undefined') {
    return summarizeCandidates([], 0, 'This browser cannot run calls (no WebRTC).')
  }
  const pc = new RTCPeerConnection({ iceServers, iceCandidatePoolSize: 0 })
  const cands: GatheredCandidate[] = []
  try {
    pc.createDataChannel('probe')
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs)
      pc.onicecandidate = (e) => {
        if (!e.candidate) {
          clearTimeout(timer)
          resolve()
          return
        }
        cands.push({ type: e.candidate.type, address: e.candidate.address, port: e.candidate.port })
        // A relay answer is the strongest proof — no need to wait for slower servers.
        if (e.candidate.type === 'relay') {
          clearTimeout(timer)
          resolve()
        }
      }
      pc.createOffer()
        .then((o) => pc.setLocalDescription(o))
        .catch(() => {
          clearTimeout(timer)
          resolve()
        })
    })
    return summarizeCandidates(cands, elapsed())
  } catch (e) {
    return summarizeCandidates(cands, elapsed(), e instanceof Error ? e.message : String(e))
  } finally {
    pc.close()
  }
}
