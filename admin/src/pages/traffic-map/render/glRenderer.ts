// #2279 — raw WebGL2 (no dependency): two instanced programs. `seg` expands each polyline
// segment into a quad with shared normals (joins never overlap, so translucent edges keep an even
// tone) and an antialiased edge; `rect` draws rounded boxes, circles and rings from a signed
// distance (fill + centred stroke, like the 2D canvas). Output is premultiplied over a
// transparent clear, so the 2D canvas composites it with one drawImage.
import { type GlScene, RECT_FLOATS, SEG_FLOATS } from './glScene'

const SEG_VS = `#version 300 es
layout(location=0) in vec2 a_corner;
layout(location=1) in vec4 a_ends;
layout(location=2) in vec4 a_normals;
layout(location=3) in float a_half;
layout(location=4) in vec4 a_color;
uniform vec4 u_view;
uniform float u_aa;
out float v_d;
out float v_half;
out vec4 v_color;
void main() {
  vec2 p = mix(a_ends.xy, a_ends.zw, a_corner.x);
  vec2 n = mix(a_normals.xy, a_normals.zw, a_corner.x);
  float ln = length(n);
  n = ln > 0.0 ? n / ln : vec2(0.0, 1.0);
  float reach = a_half + u_aa;
  p += n * a_corner.y * reach;
  v_d = a_corner.y * reach;
  v_half = a_half;
  v_color = a_color;
  vec2 c = (p - u_view.xy) / u_view.zw * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
}`
const SEG_FS = `#version 300 es
precision highp float;
in float v_d;
in float v_half;
in vec4 v_color;
uniform float u_aa;
uniform float u_alpha;
out vec4 o;
void main() {
  float cov = clamp((v_half - abs(v_d)) / u_aa + 0.5, 0.0, 1.0);
  float a = v_color.a * cov * u_alpha;
  o = vec4(v_color.rgb * a, a);
}`
const RECT_VS = `#version 300 es
layout(location=0) in vec2 a_corner;
layout(location=1) in vec4 a_box;
layout(location=2) in vec2 a_shape;
layout(location=3) in vec4 a_fill;
layout(location=4) in vec4 a_stroke;
uniform vec4 u_view;
uniform float u_aa;
out vec2 v_local;
out vec2 v_half;
out vec2 v_shape;
out vec4 v_fill;
out vec4 v_stroke;
void main() {
  float pad = a_shape.y * 0.5 + u_aa;
  vec2 half_ = a_box.zw * 0.5;
  vec2 centre = a_box.xy + half_;
  // the shared corner buffer is (0..1, -1..1): x → -1..1, y already is
  vec2 local = vec2(a_corner.x * 2.0 - 1.0, a_corner.y) * (half_ + pad);
  v_local = local;
  v_half = half_;
  v_shape = a_shape;
  v_fill = a_fill;
  v_stroke = a_stroke;
  vec2 p = centre + local;
  vec2 c = (p - u_view.xy) / u_view.zw * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
}`
const RECT_FS = `#version 300 es
precision highp float;
in vec2 v_local;
in vec2 v_half;
in vec2 v_shape;
in vec4 v_fill;
in vec4 v_stroke;
uniform float u_aa;
out vec4 o;
float sdRound(vec2 p, vec2 b, float r) {
  r = min(r, min(b.x, b.y));
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}
void main() {
  float d = sdRound(v_local, v_half, v_shape.x);
  float fillCov = clamp(0.5 - d / u_aa, 0.0, 1.0);
  vec4 c = vec4(v_fill.rgb * v_fill.a, v_fill.a) * fillCov;
  if (v_shape.y > 0.0) {
    float ring = abs(d) - v_shape.y * 0.5;
    float sc = clamp(0.5 - ring / u_aa, 0.0, 1.0) * v_stroke.a;
    c = vec4(v_stroke.rgb * sc, sc) + c * (1.0 - sc);
  }
  if (c.a <= 0.001) discard;
  o = c;
}`

interface Prog {
  p: WebGLProgram
  view: WebGLUniformLocation | null
  aa: WebGLUniformLocation | null
  alpha: WebGLUniformLocation | null
}
interface Batch {
  vao: WebGLVertexArrayObject
  buf: WebGLBuffer
  count: number
  cap: number
}

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): Prog {
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)
    if (!s) throw new Error('createShader failed')
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
      throw new Error(gl.getShaderInfoLog(s) ?? 'shader compile failed')
    return s
  }
  const p = gl.createProgram()
  if (!p) throw new Error('createProgram failed')
  gl.attachShader(p, sh(gl.VERTEX_SHADER, vs))
  gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs))
  gl.linkProgram(p)
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(p) ?? 'program link failed')
  return {
    p,
    view: gl.getUniformLocation(p, 'u_view'),
    aa: gl.getUniformLocation(p, 'u_aa'),
    alpha: gl.getUniformLocation(p, 'u_alpha')
  }
}

/** True when this browser can give us a WebGL2 context (cached; never true under jsdom). */
let support: boolean | null = null
export function webgl2Supported(): boolean {
  if (support !== null) return support
  try {
    if (typeof WebGL2RenderingContext === 'undefined' || typeof document === 'undefined') {
      support = false
      return false
    }
    const c = document.createElement('canvas')
    const gl = c.getContext('webgl2')
    support = gl instanceof WebGL2RenderingContext
    ;(gl as WebGL2RenderingContext | null)?.getExtension('WEBGL_lose_context')?.loseContext()
  } catch {
    support = false
  }
  return support
}

export class GlMapRenderer {
  readonly canvas: HTMLCanvasElement
  private gl: WebGL2RenderingContext
  private seg: Prog
  private rect: Prog
  private corner: WebGLBuffer
  private batches: Record<'segs' | 'accent' | 'rects' | 'particles', Batch>
  private lostFlag = false
  onLost: (() => void) | null = null

  private constructor(canvas: HTMLCanvasElement, gl: WebGL2RenderingContext) {
    this.canvas = canvas
    this.gl = gl
    this.seg = compile(gl, SEG_VS, SEG_FS)
    this.rect = compile(gl, RECT_VS, RECT_FS)
    const corner = gl.createBuffer()
    if (!corner) throw new Error('createBuffer failed')
    this.corner = corner
    gl.bindBuffer(gl.ARRAY_BUFFER, corner)
    // corners: x = along (0..1), y = across (-1..1); the rect shader maps x to -1..1
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]), gl.STATIC_DRAW)
    this.batches = {
      segs: this.batch('seg'),
      accent: this.batch('seg'),
      rects: this.batch('rect'),
      particles: this.batch('rect')
    }
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault()
      this.lostFlag = true
      this.onLost?.()
    })
  }

  /** A renderer on its own (off-DOM) canvas; null when WebGL2 is unavailable or fails. */
  static create(): GlMapRenderer | null {
    if (!webgl2Supported()) return null
    try {
      const canvas = document.createElement('canvas')
      const gl = canvas.getContext('webgl2', {
        alpha: true,
        antialias: false,
        premultipliedAlpha: true,
        preserveDrawingBuffer: false,
        depth: false,
        stencil: false
      })
      if (!(gl instanceof WebGL2RenderingContext)) return null
      return new GlMapRenderer(canvas, gl)
    } catch {
      return null
    }
  }

  get lost(): boolean {
    return this.lostFlag || this.gl.isContextLost()
  }

  private batch(kind: 'seg' | 'rect'): Batch {
    const gl = this.gl
    const vao = gl.createVertexArray()
    const buf = gl.createBuffer()
    if (!vao || !buf) throw new Error('createVertexArray failed')
    gl.bindVertexArray(vao)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.corner)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    const stride = (kind === 'seg' ? SEG_FLOATS : RECT_FLOATS) * 4
    // [location, size, float offset]
    const attrs: Array<[number, number, number]> =
      kind === 'seg'
        ? [
            [1, 4, 0],
            [2, 4, 4],
            [3, 1, 8],
            [4, 4, 9]
          ]
        : [
            [1, 4, 0],
            [2, 2, 4],
            [3, 4, 6],
            [4, 4, 10]
          ]
    for (const [loc, size, off] of attrs) {
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off * 4)
      gl.vertexAttribDivisor(loc, 1)
    }
    gl.bindVertexArray(null)
    return { vao, buf, count: 0, cap: 0 }
  }

  private upload(b: Batch, data: Float32Array, count: number): void {
    const gl = this.gl
    gl.bindBuffer(gl.ARRAY_BUFFER, b.buf)
    if (data.byteLength > b.cap) {
      b.cap = Math.max(data.byteLength, b.cap * 2, 4096)
      gl.bufferData(gl.ARRAY_BUFFER, b.cap, gl.DYNAMIC_DRAW)
    }
    if (data.byteLength) gl.bufferSubData(gl.ARRAY_BUFFER, 0, data)
    b.count = count
  }

  setScene(s: GlScene): void {
    if (this.lost) return
    this.upload(this.batches.segs, s.segs, s.segCount)
    this.upload(this.batches.accent, s.accent, s.accentCount)
    this.upload(this.batches.rects, s.rects, s.rectCount)
  }
  setParticles(rects: Float32Array, count: number): void {
    if (this.lost) return
    this.upload(this.batches.particles, rects, count)
  }

  /**
   * Draw the part of the map at `view` (map px) into the renderer's canvas, sized to it at `dpr`.
   * `accentAlpha` fades the highlight in (0..1 of its 0.55 strength, like the 2D canvas).
   */
  render(view: { x: number; y: number; w: number; h: number }, dpr: number, accentAlpha: number) {
    if (this.lost) return
    const gl = this.gl
    const pw = Math.max(1, Math.round(view.w * dpr))
    const ph = Math.max(1, Math.round(view.h * dpr))
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw
      this.canvas.height = ph
    }
    gl.viewport(0, 0, pw, ph)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    const aa = 1 / dpr
    const run = (prog: Prog, b: Batch, alpha = 1) => {
      if (!b.count) return
      // biome-ignore lint/correctness/useHookAtTopLevel: WebGL's useProgram, not a React hook
      gl.useProgram(prog.p)
      gl.uniform4f(prog.view, view.x, view.y, view.w, view.h)
      gl.uniform1f(prog.aa, aa)
      if (prog.alpha) gl.uniform1f(prog.alpha, alpha)
      gl.bindVertexArray(b.vao)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, b.count)
    }
    run(this.seg, this.batches.segs)
    if (accentAlpha > 0) run(this.seg, this.batches.accent, 0.55 * accentAlpha)
    run(this.rect, this.batches.rects)
    run(this.rect, this.batches.particles)
    gl.bindVertexArray(null)
  }

  dispose(): void {
    try {
      this.gl.getExtension('WEBGL_lose_context')?.loseContext()
    } catch {
      /* already gone */
    }
    this.onLost = null
  }
}
