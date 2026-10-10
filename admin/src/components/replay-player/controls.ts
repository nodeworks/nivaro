/**
 * What a host can do with a mounted ReplayPlayer (its `controlsRef`): read
 * and drive the playhead. The floating window (#1401) reads the time to hand
 * the replay back; watch-together (#1399) mirrors the host's playhead.
 */
export interface ReplayControls {
  /** ms into the recording. */
  getTime(): number
  isPlaying(): boolean
  getSpeed(): number
  /** Seek, keeping the play / pause state. */
  seek(ms: number): void
  /** Play or pause at `ms`. */
  playAt(play: boolean, ms: number): void
  setSpeed(speed: number): void
}
