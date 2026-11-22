/**
 * An in-memory swarm behind the agent's Engine interface. Every call first
 * goes through the REAL allow-list and body guard (`checkEngineCall`), so a
 * call the agent could not make against Docker fails here too. Never the
 * host's Docker socket.
 *
 * Like Docker, a stored service spec names its networks by ID (the agent sends
 * names): an update body built by round-tripping an inspected spec would carry
 * ids, which the guard refuses.
 */
import type http from 'node:http'
import { Readable } from 'node:stream'
import { isDeepStrictEqual } from 'node:util'
import type { AgentConfig } from '../src/config.js'
import {
  checkEngineCall,
  type Engine,
  type EngineCallOptions,
  EngineError,
  type EngineMethod,
  OwnershipGuard
} from '../src/engine.js'

export type Recorded = {
  method: EngineMethod
  path: string
  query?: Record<string, unknown>
  body?: unknown
  headers?: Record<string, string>
}

type Obj = Record<string, any>

export type FakeService = {
  ID: string
  Version: { Index: number }
  CreatedAt: string
  UpdatedAt: string
  Spec: Obj
  PreviousSpec?: Obj
  UpdateStatus?: { State: string; Message?: string }
  Endpoint?: Obj
}

const clone = <T>(v: T): T => (v === undefined ? v : structuredClone(v))

export class FakeEngine implements Engine {
  readonly calls: Recorded[] = []
  readonly refused: Recorded[] = []
  services = new Map<string, FakeService>()
  secrets = new Map<string, { ID: string; Version: { Index: number }; Spec: Obj }>()
  networks = new Map<
    string,
    { Id: string; Name: string; Driver: string; Labels: Obj; Scope: string; Attachable?: boolean }
  >()
  volumes = new Map<
    string,
    { Name: string; Driver: string; Labels: Obj; Options: Obj; Scope: string }
  >()
  images = new Set<string>()
  containers = new Map<
    string,
    { Id: string; Name: string; Image: string; Labels: Obj; Cmd?: unknown; Created?: number }
  >()
  /** Archive of /extension per image: bytes, or a stream factory (to model a broken socket). */
  archives = new Map<string, Buffer | (() => Readable)>()
  /** How often each service's tasks were replaced (a task template change, ForceUpdate included). */
  restarts = new Map<string, number>()
  /** The same stateful ownership guard the real engine runs. */
  private readonly guard = new OwnershipGuard()

  private seq = 1
  private version = 10
  private updateKnob: 'rollback' | 'out-of-sequence' | 'error' | null = null
  private taskStates = new Map<string, string>()
  private pullFailures = new Set<string>()
  private unreachable = false
  private secretsInUse = new Set<string>()

  constructor(readonly cfg: AgentConfig) {
    this.networks.set('ingress', {
      Id: 'ingressid000000000000001',
      Name: 'ingress',
      Driver: 'overlay',
      Labels: {},
      Scope: 'swarm'
    })
    if (cfg.edgeNetwork) {
      this.networks.set(cfg.edgeNetwork, {
        Id: 'edgeid00000000000000001',
        Name: cfg.edgeNetwork,
        Driver: 'overlay',
        Labels: {},
        Scope: 'swarm'
      })
    }
  }

  // ── knobs ───────────────────────────────────────────────────────────
  failNextUpdate(kind: 'rollback' | 'out-of-sequence' | 'error'): void {
    this.updateKnob = kind
  }
  taskState(service: string, state: string): void {
    this.taskStates.set(service, state)
  }
  failPull(ref: string): void {
    this.pullFailures.add(ref)
  }
  setUnreachable(v: boolean): void {
    this.unreachable = v
  }
  /** A secret the Engine refuses to remove ("in use"), whatever references it. */
  secretInUse(name: string): void {
    this.secretsInUse.add(name)
  }
  /** Every running update finishes. */
  completeUpdates(): void {
    for (const s of this.services.values()) {
      if (s.UpdateStatus?.State === 'updating')
        s.UpdateStatus = { State: 'completed', Message: 'update completed' }
    }
  }
  /** A service the agent did not create (EFP's own, say). */
  preexisting(name: string, labels: Obj = {}, extra: Obj = {}): FakeService {
    const svc: FakeService = {
      ID: this.id(),
      Version: { Index: this.version++ },
      CreatedAt: new Date(0).toISOString(),
      UpdatedAt: new Date(0).toISOString(),
      Spec: {
        Name: name,
        Labels: { ...labels },
        TaskTemplate: {
          ContainerSpec: { Image: 'efp/web:1', Env: ['SECRET_THING=efp-env-value'] }
        },
        Mode: { Replicated: { Replicas: 1 } },
        ...extra
      }
    }
    this.services.set(svc.ID, svc)
    return svc
  }
  /** A container left behind by an earlier agent run (or someone else's). */
  leftoverContainer(name: string, labels: Obj, created = 0): void {
    this.containers.set(name, {
      Id: this.id(),
      Name: name,
      Image: 'x',
      Labels: { ...labels },
      Created: created
    })
  }
  archive(ref: string, tar: Buffer | (() => Readable)): void {
    this.archives.set(ref, tar)
  }

  // ── queries for tests ──────────────────────────────────────────────
  writes(): Recorded[] {
    return this.calls.filter((c) => c.method !== 'GET')
  }
  service(name: string): FakeService | undefined {
    return [...this.services.values()].find((s) => s.Spec.Name === name)
  }
  serviceNames(): string[] {
    return [...this.services.values()].map((s) => s.Spec.Name as string).sort()
  }

  private id(): string {
    return `id${String(this.seq++).padStart(23, '0')}`
  }

  private find<T>(
    map: Map<string, T>,
    key: string,
    idOf: (v: T) => string,
    nameOf: (v: T) => string
  ): [string, T] | null {
    for (const [k, v] of map) if (idOf(v) === key || nameOf(v) === key) return [k, v]
    return null
  }

  private findService(key: string): FakeService | null {
    return (
      this.find(
        this.services,
        key,
        (s) => s.ID,
        (s) => s.Spec.Name
      )?.[1] ?? null
    )
  }

  private toNetworkIds(spec: Obj): Obj {
    const out = clone(spec)
    const map = (nets: unknown) =>
      Array.isArray(nets)
        ? nets.map((n: Obj) => {
            const net = this.networks.get(n.Target)
            return { ...n, Target: net ? net.Id : n.Target }
          })
        : nets
    if (out.TaskTemplate?.Networks) out.TaskTemplate.Networks = map(out.TaskTemplate.Networks)
    if (out.Networks) out.Networks = map(out.Networks)
    return out
  }

  private endpointFor(spec: Obj): Obj | undefined {
    const ports = spec.EndpointSpec?.Ports
    if (!Array.isArray(ports) || ports.length === 0) return undefined
    return {
      Spec: clone(spec.EndpointSpec),
      Ports: ports.map((p: Obj) => ({ Protocol: 'tcp', ...p }))
    }
  }

  private tasks(filters: Obj | null): Obj[] {
    const wanted: string[] = filters?.service ?? []
    const out: Obj[] = []
    for (const s of this.services.values()) {
      if (wanted.length && !wanted.includes(s.ID) && !wanted.includes(s.Spec.Name)) continue
      const n = s.Spec.Mode?.Replicated?.Replicas ?? 0
      const state = this.taskStates.get(s.Spec.Name) ?? 'running'
      for (let i = 0; i < n; i++) {
        out.push({
          ID: `${s.ID}-t${i}`,
          ServiceID: s.ID,
          DesiredState: 'running',
          Status: { State: state }
        })
      }
      // A shut-down task of an earlier version, as Docker keeps them.
      out.push({
        ID: `${s.ID}-old`,
        ServiceID: s.ID,
        DesiredState: 'shutdown',
        Status: { State: 'running' }
      })
    }
    return out
  }

  private record(method: EngineMethod, path: string, opts: EngineCallOptions): void {
    const r: Recorded = { method, path }
    if (opts.query) r.query = clone(opts.query)
    if (opts.body !== undefined) r.body = clone(opts.body)
    if (opts.headers) r.headers = { ...opts.headers }
    this.calls.push(r)
  }

  async call<T = unknown>(
    method: EngineMethod,
    path: string,
    opts: EngineCallOptions = {}
  ): Promise<{ status: number; body: T }> {
    if (this.unreachable) throw new EngineError('ENGINE_UNREACHABLE')
    let verdict: 'forward' | 'missing'
    try {
      checkEngineCall(this.cfg, method, path, opts)
      verdict = await this.guard.check(
        async (p) => {
          const r = this.handle('GET', p, {})
          return { status: r.status, body: clone(r.body) }
        },
        method,
        path
      )
    } catch (err) {
      this.refused.push({ method, path, body: clone(opts.body), query: clone(opts.query) })
      throw err
    }
    if (verdict === 'missing') return { status: 404, body: { message: 'not found' } as T }
    this.record(method, path, opts)
    const r = this.handle(method, path, opts)
    this.guard.note(method, path, opts, r.status)
    return { status: r.status, body: clone(r.body) as T }
  }

  async stream(
    method: EngineMethod,
    path: string,
    opts: EngineCallOptions = {}
  ): Promise<{ status: number; stream: http.IncomingMessage }> {
    checkEngineCall(this.cfg, method, path, opts)
    if (this.unreachable) throw new EngineError('ENGINE_UNREACHABLE')
    try {
      await this.guard.check(async () => ({ status: 404, body: null }), method, path)
    } catch (err) {
      this.refused.push({ method, path, query: clone(opts.query) })
      throw err
    }
    this.record(method, path, opts)
    const m = /^\/containers\/([^/]+)\/archive$/.exec(path)
    const c = m ? this.containers.get(m[1]) : undefined
    const tar = c ? this.archives.get(c.Image) : undefined
    if (!c || !tar) {
      return {
        status: 404,
        stream: Readable.from([Buffer.from('{"message":"no such path"}')]) as never
      }
    }
    if (typeof tar === 'function') return { status: 200, stream: tar() as never }
    // Small chunks, like a socket.
    const chunks: Buffer[] = []
    for (let i = 0; i < tar.length; i += 64 * 1024) chunks.push(tar.subarray(i, i + 64 * 1024))
    return { status: 200, stream: Readable.from(chunks) as never }
  }

  private handle(
    method: EngineMethod,
    path: string,
    opts: EngineCallOptions
  ): { status: number; body: unknown } {
    const body = (opts.body ?? {}) as Obj
    const seg = path.split('/').slice(1)
    const key = `${method} /${seg[0]}`
    const filters = typeof opts.query?.filters === 'string' ? JSON.parse(opts.query.filters) : null

    if (method === 'GET' && path === '/version')
      return { status: 200, body: { ApiVersion: '1.45' } }
    if (method === 'GET' && path === '/info')
      return { status: 200, body: { Swarm: { ControlAvailable: true, NodeID: 'node-agent-1' } } }

    switch (key) {
      case 'GET /services': {
        if (seg.length === 2) {
          const s = this.findService(seg[1])
          return s
            ? { status: 200, body: s }
            : { status: 404, body: { message: 'service not found' } }
        }
        return { status: 200, body: [...this.services.values()] }
      }
      case 'GET /tasks':
        return { status: 200, body: this.tasks(filters) }
      case 'GET /networks':
        return { status: 200, body: [...this.networks.values()] }
      case 'GET /secrets':
        return {
          status: 200,
          body: [...this.secrets.values()].map((s) => ({
            ID: s.ID,
            Version: s.Version,
            Spec: { Name: s.Spec.Name, Labels: s.Spec.Labels }
          }))
        }
      case 'GET /volumes':
        return { status: 200, body: { Volumes: [...this.volumes.values()], Warnings: null } }
      case 'GET /containers': {
        if (seg[1] === 'json') {
          const label: string[] = filters?.label ?? []
          const rows = [...this.containers.values()].filter((c) =>
            label.every((l) => {
              const [k, v] = l.split('=')
              return v === undefined ? k in c.Labels : c.Labels[k] === v
            })
          )
          return {
            status: 200,
            body: rows.map((c) => ({
              Id: c.Id,
              Names: [`/${c.Name}`],
              Image: c.Image,
              Labels: c.Labels,
              Created: c.Created ?? Math.floor(Date.now() / 1000)
            }))
          }
        }
        const c = this.containers.get(seg[1])
        return c
          ? {
              status: 200,
              body: { Id: c.Id, Name: `/${c.Name}`, Config: { Labels: c.Labels, Image: c.Image } }
            }
          : { status: 404, body: { message: 'No such container' } }
      }
      case 'GET /images': {
        const ref = path.slice('/images/'.length, -'/json'.length)
        return this.images.has(ref)
          ? { status: 200, body: { Id: `sha256:${'e'.repeat(64)}`, RepoDigests: [ref] } }
          : { status: 404, body: { message: 'No such image' } }
      }
      case 'POST /services': {
        if (seg[1] === 'create') {
          if (this.service(body.Name)) return { status: 409, body: { message: 'name conflicts' } }
          const svc: FakeService = {
            ID: this.id(),
            Version: { Index: this.version++ },
            CreatedAt: new Date().toISOString(),
            UpdatedAt: new Date().toISOString(),
            Spec: this.toNetworkIds(body),
            Endpoint: this.endpointFor(body)
          }
          this.services.set(svc.ID, svc)
          return { status: 201, body: { ID: svc.ID, Warnings: [] } }
        }
        const svc = this.findService(seg[1])
        if (!svc) return { status: 404, body: { message: 'service not found' } }
        const knob = this.updateKnob
        this.updateKnob = null
        if (knob === 'error')
          return { status: 500, body: { message: 'rpc error: internal secret detail' } }
        if (
          knob === 'out-of-sequence' ||
          String(opts.query?.version) !== String(svc.Version.Index)
        ) {
          return { status: 500, body: { message: 'update out of sequence' } }
        }
        const next = this.toNetworkIds(body)
        const task = (spec: Obj) => ({
          ...spec.TaskTemplate,
          ForceUpdate: spec.TaskTemplate?.ForceUpdate ?? 0
        })
        if (!isDeepStrictEqual(task(svc.Spec), task(next))) {
          this.restarts.set(next.Name, (this.restarts.get(next.Name) ?? 0) + 1)
        }
        svc.PreviousSpec = svc.Spec
        svc.Spec = next
        svc.Endpoint = this.endpointFor(body)
        svc.Version = { Index: this.version++ }
        svc.UpdatedAt = new Date().toISOString()
        svc.UpdateStatus = { State: 'updating', Message: 'update in progress' }
        if (knob === 'rollback') {
          svc.Spec = svc.PreviousSpec
          svc.UpdateStatus = { State: 'rollback_completed', Message: 'rollback completed' }
        }
        return { status: 200, body: { Warnings: [] } }
      }
      case 'POST /networks': {
        if (this.networks.has(body.Name))
          return { status: 409, body: { message: 'network exists' } }
        this.networks.set(body.Name, {
          Id: this.id(),
          Name: body.Name,
          Driver: body.Driver,
          Labels: { ...(body.Labels ?? {}) },
          Scope: 'swarm',
          Attachable: body.Attachable
        })
        return { status: 201, body: { Id: this.networks.get(body.Name)?.Id } }
      }
      case 'POST /secrets': {
        if ([...this.secrets.values()].some((s) => s.Spec.Name === body.Name))
          return { status: 409, body: { message: 'secret exists' } }
        const id = this.id()
        this.secrets.set(id, { ID: id, Version: { Index: this.version++ }, Spec: clone(body) })
        return { status: 201, body: { ID: id } }
      }
      case 'POST /volumes': {
        if (!this.volumes.has(body.Name)) {
          this.volumes.set(body.Name, {
            Name: body.Name,
            Driver: body.Driver,
            Labels: { ...(body.Labels ?? {}) },
            Options: { ...(body.DriverOpts ?? {}) },
            Scope: 'local'
          })
        }
        return { status: 201, body: this.volumes.get(body.Name) }
      }
      case 'POST /images': {
        const ref = `${opts.query?.fromImage}@${opts.query?.tag}`
        if (this.pullFailures.has(ref)) {
          return {
            status: 200,
            body: '{"status":"Pulling"}\n{"errorDetail":{"message":"denied"},"error":"pull access denied"}\n'
          }
        }
        this.images.add(ref)
        return { status: 200, body: '{"status":"Pulling"}\n{"status":"Digest: done"}\n' }
      }
      case 'POST /containers': {
        const name = String(opts.query?.name)
        if (!this.images.has(body.Image)) return { status: 404, body: { message: 'No such image' } }
        if (this.containers.has(name)) return { status: 409, body: { message: 'name in use' } }
        this.containers.set(name, {
          Id: this.id(),
          Name: name,
          Image: body.Image,
          Labels: { ...body.Labels },
          Cmd: body.Cmd
        })
        return { status: 201, body: { Id: this.containers.get(name)?.Id, Warnings: [] } }
      }
      case 'DELETE /services': {
        const svc = this.findService(seg[1])
        if (!svc) return { status: 404, body: { message: 'service not found' } }
        this.services.delete(svc.ID)
        return { status: 200, body: null }
      }
      case 'DELETE /secrets': {
        const hit = this.find(
          this.secrets,
          seg[1],
          (s) => s.ID,
          (s) => s.Spec.Name
        )
        if (!hit) return { status: 404, body: { message: 'secret not found' } }
        const [id, sec] = hit
        const used =
          this.secretsInUse.has(sec.Spec.Name) ||
          [...this.services.values()].some((s) =>
            (s.Spec.TaskTemplate?.ContainerSpec?.Secrets ?? []).some((r: Obj) => r.SecretID === id)
          )
        if (used) return { status: 400, body: { message: `secret '${sec.Spec.Name}' is in use` } }
        this.secrets.delete(id)
        return { status: 204, body: null }
      }
      case 'DELETE /networks': {
        const hit = this.find(
          this.networks,
          seg[1],
          (n) => n.Id,
          (n) => n.Name
        )
        if (!hit) return { status: 404, body: { message: 'network not found' } }
        const used = [...this.services.values()].some((s) =>
          (s.Spec.TaskTemplate?.Networks ?? []).some((n: Obj) => n.Target === hit[1].Id)
        )
        if (used) return { status: 403, body: { message: 'network has active endpoints' } }
        this.networks.delete(hit[0])
        return { status: 204, body: null }
      }
      case 'DELETE /volumes': {
        if (!this.volumes.has(seg[1])) return { status: 404, body: { message: 'no such volume' } }
        const used = [...this.services.values()].some((s) =>
          (s.Spec.TaskTemplate?.ContainerSpec?.Mounts ?? []).some((m: Obj) => m.Source === seg[1])
        )
        if (used) return { status: 409, body: { message: 'volume is in use' } }
        this.volumes.delete(seg[1])
        return { status: 204, body: null }
      }
      case 'DELETE /containers': {
        if (!this.containers.delete(seg[1]))
          return { status: 404, body: { message: 'no such container' } }
        return { status: 204, body: null }
      }
    }
    return { status: 500, body: { message: `fake engine: ${method} ${path} not modelled` } }
  }
}
