// =============================================================
// 베일 그래픽 렌더러 (WebGL2)
//
// 레퍼런스(피그마 Inner Glow + Layer Blur)를 화면에서 재현하는 방식:
//  1) 웹캠 영상을 작게 줄여 여러 번 흐리게(블러) 만든다  → "베일 속 흐린 얼굴"
//  2) 화면을 "닦인 영역(선명)"과 "베일(흐림+컬러)"로 나눈다
//  3) 컬러는 베일 조각의 '테두리 안쪽'에만 짙게 맺힌다 (Inner Glow)
//  4) 닦인 영역 안쪽은 색·블러 없이 완전히 선명
//
// 닦기 = 손을 부드럽게 따라가는 둥근 붓이 지나간 길(호)을 칠해 '선명도 지도'에 기록
//  - 한 번 칠해진 모양은 다시 바뀌지 않음 (끊김/떨림 없음)
//  - 잠시(holdTime) 뒤에는 그 영역이 잉크 번지듯 흐려지며 퍼지고, 베일이 다시 차오름
// =============================================================

// 디자인 수치는 여기서 쉽게 조절할 수 있어요.
export const LOOK = {
  washMix: 0.72,         // 베일 가운데 옅은 색 = 선택 컬러를 흰색과 섞는 비율 (클수록 옅음)
  washAmount: 0.26,      // 옅은 색이 흐린 영상을 덮는 정도 (0~1)
  glowAmount: 0.72,      // Inner Glow 최대 진하기 (0~1)
  glowGain: 2.2,         // 닦인 영역 주변 글로우 세기
  veilOpacity: 0.94,     // 베일 전체 불투명도 (낮을수록 뒤의 카메라 화면이 더 비침)
  glowWidthFrame: 0.11,  // 화면 테두리에서 안쪽으로 번지는 폭 (화면 높이 비율)
  edgePx: 1.5,           // 막 닦인 경계선의 부드러움 (픽셀, 작을수록 또렷)
  blurPasses: 3,         // 영상 블러 반복 횟수 (클수록 더 흐림)
  blurSpread: 2.2,       // 영상 블러 퍼짐 정도
  blurWidth: 200,        // 블러용 축소 해상도(가로 픽셀)
  glowBlurWidth: 160,    // 글로우 계산용 축소 해상도
  glowSpread: 1.6,       // 글로우 번짐 폭
  maskScale: 0.5,        // 선명도 지도 해상도 (화면 대비)

  // ---- 다시 덮이기 (흐려지며 퍼짐) ----
  holdTime: 1.2,         // 닦인 뒤 선명하게 유지되는 시간 (초)
  spreadPx: 5,           // 흐려지며 퍼지는 정도 (클수록 더 넓게 번짐)
  fadeTime: 2.4,         // 퍼지기 시작한 뒤 베일이 완전히 다시 덮이기까지 걸리는 시간 (초)
};

const VERT = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// 원본 영상을 화면 비율에 맞게(cover) 잘라 + 좌우 반전(거울)해서 작은 텍스처로 옮기는 셰이더
const MAP_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uSrc;
uniform vec2 uCover;
uniform float uMirror;
vec2 srcUv(vec2 s) {
  vec2 v = (s - 0.5) * uCover + 0.5;
  if (uMirror > 0.5) v.x = 1.0 - v.x;
  return v;
}
void main() { o = vec4(texture(uSrc, srcUv(vUv)).rgb, 1.0); }`;

// 가우시안 블러 (가로 또는 세로 한 방향씩)
const BLUR_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uTex;
uniform vec2 uStep;
void main() {
  float w[5] = float[](0.227027, 0.1945946, 0.1216216, 0.054054, 0.016216);
  vec3 c = texture(uTex, vUv).rgb * w[0];
  for (int i = 1; i < 5; i++) {
    vec2 off = uStep * float(i);
    c += texture(uTex, vUv + off).rgb * w[i];
    c += texture(uTex, vUv - off).rgb * w[i];
  }
  o = vec4(c, 1.0);
}`;

// 붓 한 번(선분 → 둥근 띠)을 선명도 지도에 칠하기 (MAX 블렌딩으로 합쳐짐)
//  R = 선명도 (1 = 완전히 닦임), G = 유지 타이머 (1에서 시작해 줄어듦)
const BRUSH_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform vec2 uRes;      // 화면 픽셀 크기
uniform vec2 uA;        // 선분 시작 (픽셀, 위쪽이 0)
uniform vec2 uB;        // 선분 끝
uniform float uR;       // 붓 반지름
uniform float uEdge;
uniform float uHalo;
void main() {
  vec2 p = vec2(vUv.x * uRes.x, (1.0 - vUv.y) * uRes.y);
  vec2 pa = p - uA, ba = uB - uA;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
  float d = length(pa - ba * h) - uR;
  float c = 1.0 - smoothstep(-uEdge, uEdge, d);
  o = vec4(c, step(d, uHalo), 0.0, 1.0);
}`;

// 시간 흐름: 유지 시간이 끝난 곳은 주변과 섞이며(번짐) 선명도가 줄어듦(다시 덮임)
const EVOLVE_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uMask;
uniform vec2 uTexel;
uniform float uDt;
uniform float uHold;
uniform float uSpread;
uniform float uFade;
void main() {
  vec4 m = texture(uMask, vUv);
  float g = max(m.g - uDt / uHold, 0.0);
  float c = m.r;
  if (m.g <= 0.0) {
    vec2 s = uTexel * uSpread;
    float avg = (
      texture(uMask, vUv + vec2( s.x, 0.0)).r + texture(uMask, vUv + vec2(-s.x, 0.0)).r +
      texture(uMask, vUv + vec2(0.0,  s.y)).r + texture(uMask, vUv + vec2(0.0, -s.y)).r +
      texture(uMask, vUv + s * 0.7071).r + texture(uMask, vUv - s * 0.7071).r +
      texture(uMask, vUv + vec2(s.x, -s.y) * 0.7071).r + texture(uMask, vUv + vec2(-s.x, s.y) * 0.7071).r
    ) / 8.0;
    float k = clamp(uDt * 30.0, 0.0, 1.0) * 0.5;
    c = mix(c, avg, k);                 // 번짐
    c = max(c - uDt / uFade, 0.0);      // 다시 덮임
  }
  o = vec4(c, g, 0.0, 1.0);
}`;

// 선명도 지도 → 글로우 계산용 작은 텍스처로 복사
const COPY_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uMask;
void main() { o = vec4(vec3(texture(uMask, vUv).r), 1.0); }`;

// 닦인 비율 계산용
const COVER_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uMask;
void main() { o = vec4(step(0.5, texture(uMask, vUv).r), 0.0, 0.0, 1.0); }`;

// 최종 합성: 선명한 영상 / 베일 / Inner Glow
const COMP_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uSrc;
uniform sampler2D uBlur;
uniform sampler2D uMask;      // 선명도 지도
uniform sampler2D uMaskBlur;  // 흐리게 만든 선명도 지도 (글로우용)
uniform vec2 uRes;
uniform vec2 uCover;
uniform float uMirror;
uniform vec3 uWash;
uniform float uWashAmt;
uniform vec3 uGlow;
uniform float uGlowAmt;
uniform float uGlowGain;
uniform float uGlowFrame;
uniform float uOpacity;

vec2 srcUv(vec2 s) {
  vec2 v = (s - 0.5) * uCover + 0.5;
  if (uMirror > 0.5) v.x = 1.0 - v.x;
  return v;
}

void main() {
  vec2 p = vec2(vUv.x * uRes.x, (1.0 - vUv.y) * uRes.y);   // 위쪽이 0
  float H = uRes.y;

  vec3 sharp = texture(uSrc, srcUv(vUv)).rgb;
  vec3 blur  = texture(uBlur, vUv).rgb;

  float c = texture(uMask, vUv).r;            // 1 = 닦임(선명)
  float cb = texture(uMaskBlur, vUv).r;       // 주변에 닦인 곳이 얼마나 있나
  float veilMask = 1.0 - c;

  // Inner Glow: 닦인 영역과 맞닿은 베일 쪽에서 진하고, 멀어질수록 사라짐
  float gWin = clamp(cb * uGlowGain, 0.0, 1.0) * veilMask;
  float fw = H * uGlowFrame;
  vec4 eg = exp(-vec4(p.x, uRes.x - p.x, p.y, uRes.y - p.y) / fw);
  float gFrame = 1.0 - (1.0 - eg.x) * (1.0 - eg.y) * (1.0 - eg.z) * (1.0 - eg.w);
  float glow = 1.0 - (1.0 - gWin) * (1.0 - gFrame * 0.9);

  vec3 veil = mix(blur, uWash, uWashAmt);
  veil = mix(veil, uGlow, glow * uGlowAmt);

  o = vec4(mix(sharp, veil, veilMask * uOpacity), 1.0);
}`;

function compile(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
  return s;
}

function program(gl, fragSrc) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fragSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const name = gl.getActiveUniform(p, i).name;
    uniforms[name] = gl.getUniformLocation(p, name);
  }
  return { p, u: uniforms };
}

function makeTex(gl) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

export function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export class VeilRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error('이 브라우저는 WebGL2를 지원하지 않아요.');
    this.gl = gl;
    this.floatMask = !!gl.getExtension('EXT_color_buffer_float');
    this.mapProg = program(gl, MAP_FRAG);
    this.blurProg = program(gl, BLUR_FRAG);
    this.brushProg = program(gl, BRUSH_FRAG);
    this.evolveProg = program(gl, EVOLVE_FRAG);
    this.copyProg = program(gl, COPY_FRAG);
    this.coverProg = program(gl, COVER_FRAG);
    this.compProg = program(gl, COMP_FRAG);
    this.vao = gl.createVertexArray();
    this.srcTex = makeTex(gl);
    this.clearSource();
    this.setColor('#AB7EFF');
    this.bandHalf = 0.2;  // 붓 반지름 (화면 높이 비율) — 크기 슬라이더로 바뀜

    this.fbos = [this._makeFbo(), this._makeFbo()];       // 영상 블러
    this.gfbos = [this._makeFbo(), this._makeFbo()];      // 글로우 블러
    this.masks = [this._makeFbo(), this._makeFbo()];      // 선명도 지도 (번갈아 쓰기)
    this.tiny = this._makeFbo();                          // 닦인 비율 계산용
    this._sizeFbo(this.tiny, 48, 27, false);
    this.coverage = 0;
    this.resize();
  }

  // 베일 컬러 지정 (#RRGGBB)
  setColor(hex) {
    const c = hexToRgb(hex);
    this.glowColor = c;
    this.washColor = c.map((v) => v + (1 - v) * LOOK.washMix);
  }

  _makeFbo() {
    const gl = this.gl;
    return { tex: makeTex(gl), fb: gl.createFramebuffer(), w: 0, h: 0 };
  }

  _sizeFbo(f, w, h, float) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, f.tex);
    if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, f.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, f.tex, 0);
    f.w = w; f.h = h;
  }

  _clear(f) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, f.fb);
    gl.viewport(0, 0, f.w, f.h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(window.innerWidth * dpr);
    const h = Math.round(window.innerHeight * dpr);
    if (this.canvas.width === w && this.canvas.height === h && this.fbos[0].w) return;
    this.canvas.width = w;
    this.canvas.height = h;
    const small = (bw) => [bw, Math.max(2, Math.round(bw * h / w))];
    this.fbos.forEach((f) => this._sizeFbo(f, ...small(LOOK.blurWidth), false));
    this.gfbos.forEach((f) => this._sizeFbo(f, ...small(LOOK.glowBlurWidth), this.floatMask));
    const mw = Math.round(w * LOOK.maskScale), mh = Math.round(h * LOOK.maskScale);
    this.masks.forEach((m) => { this._sizeFbo(m, mw, mh, this.floatMask); this._clear(m); }); // 창 크기가 바뀌면 기록 초기화
  }

  /** 닦인 기록 모두 지우기 (다시 체험하기) */
  clearWipes() {
    this.masks.forEach((m) => this._clear(m));
    this.coverage = 0;
  }

  get mask() { return this.masks[0]; }

  /**
   * 붓으로 칠하기
   * @param segs [{ax, ay, bx, by, r}] 화면 픽셀 좌표 (위쪽이 0)
   */
  paint(segs) {
    if (!segs.length) return;
    const gl = this.gl, b = this.brushProg, m = this.mask;
    const W = this.canvas.width, H = this.canvas.height;
    const sx = m.w / W, sy = m.h / H;
    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, m.fb);
    gl.viewport(0, 0, m.w, m.h);
    gl.useProgram(b.p);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.MAX);
    gl.enable(gl.SCISSOR_TEST);
    const halo = H * 0.03;
    gl.uniform2f(b.u.uRes, W, H);
    gl.uniform1f(b.u.uEdge, LOOK.edgePx * (W / m.w));
    gl.uniform1f(b.u.uHalo, halo);
    for (const s of segs) {
      // 붓이 닿는 범위만 계산 (빠르게)
      const pad = s.r + halo + 4;
      const x0 = Math.floor((Math.min(s.ax, s.bx) - pad) * sx), x1 = Math.ceil((Math.max(s.ax, s.bx) + pad) * sx);
      const y0 = Math.floor((Math.min(s.ay, s.by) - pad) * sy), y1 = Math.ceil((Math.max(s.ay, s.by) + pad) * sy);
      gl.scissor(x0, m.h - y1, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
      gl.uniform2f(b.u.uA, s.ax, s.ay);
      gl.uniform2f(b.u.uB, s.bx, s.by);
      gl.uniform1f(b.u.uR, s.r);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
  }

  /** 시간 흐름: 유지 시간이 지난 곳은 흐려지며 퍼지고 다시 덮임 */
  evolve(dt) {
    if (dt <= 0) return;
    const gl = this.gl, e = this.evolveProg;
    const [src, dst] = this.masks;
    gl.bindVertexArray(this.vao);
    this._pass(e, dst, dst.w, dst.h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(e.u.uMask, 0);
    gl.uniform2f(e.u.uTexel, 1 / src.w, 1 / src.h);
    gl.uniform1f(e.u.uDt, dt);
    gl.uniform1f(e.u.uHold, LOOK.holdTime);
    gl.uniform1f(e.u.uSpread, LOOK.spreadPx);
    gl.uniform1f(e.u.uFade, LOOK.fadeTime);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.masks = [dst, src];
  }

  // 영상(video) 또는 이미지(img)를 원본으로 지정
  setSource(el) { this.source = el; }

  // 원본 없음 (홈 화면): 옅은 흰색 바탕 위에 베일 컬러만 보이게
  clearSource() {
    const gl = this.gl;
    this.source = null;
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([246, 242, 244, 255]));
    this.srcW = 1; this.srcH = 1;
  }

  // 원본을 화면에 꽉 차게(cover) 보여줄 때의 잘림 비율
  coverFactor() {
    const sa = this.canvas.width / this.canvas.height;
    const va = this.srcW / this.srcH;
    return sa > va ? [1, va / sa] : [sa / va, 1];
  }

  _uploadSource() {
    const gl = this.gl, el = this.source;
    if (!el) return;
    const w = el.videoWidth || el.naturalWidth;
    const h = el.videoHeight || el.naturalHeight;
    if (!w || !h) return;
    if (el.readyState !== undefined && el.readyState < 2) return;
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, el);
    this.srcW = w; this.srcH = h;
  }

  _pass(prog, target, w, h) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(prog.p);
  }

  _blur(pair, passes, spread) {
    const gl = this.gl, [A, B] = pair;
    for (let i = 0; i < passes; i++) {
      const s = spread * (1 + i * 0.5);
      this._pass(this.blurProg, B, B.w, B.h);
      gl.bindTexture(gl.TEXTURE_2D, A.tex);
      gl.uniform1i(this.blurProg.u.uTex, 0);
      gl.uniform2f(this.blurProg.u.uStep, s / A.w, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this._pass(this.blurProg, A, A.w, A.h);
      gl.bindTexture(gl.TEXTURE_2D, B.tex);
      gl.uniform2f(this.blurProg.u.uStep, 0, s / B.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  /** 닦인 비율(0~1) 다시 계산 — 가끔만 호출 */
  measureCoverage() {
    const gl = this.gl, t = this.tiny;
    gl.bindVertexArray(this.vao);
    this._pass(this.coverProg, t, t.w, t.h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.mask.tex);
    gl.uniform1i(this.coverProg.u.uMask, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const px = new Uint8Array(t.w * t.h * 4);
    gl.readPixels(0, 0, t.w, t.h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let n = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] > 127) n++;
    this.coverage = n / (t.w * t.h);
    return this.coverage;
  }

  /** @param {{mirror:boolean}} s */
  render(s) {
    const gl = this.gl;
    this.resize();
    this._uploadSource();
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    const cover = this.coverFactor();
    const mirror = s.mirror ? 1 : 0;
    const [A] = this.fbos, [GA] = this.gfbos;
    const W = this.canvas.width, H = this.canvas.height;

    // 1) 원본 → 작은 텍스처 → 블러 (베일 속 흐린 영상)
    this._pass(this.mapProg, A, A.w, A.h);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.uniform1i(this.mapProg.u.uSrc, 0);
    gl.uniform2f(this.mapProg.u.uCover, cover[0], cover[1]);
    gl.uniform1f(this.mapProg.u.uMirror, mirror);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this._blur(this.fbos, LOOK.blurPasses, LOOK.blurSpread);

    // 2) 선명도 지도 → 작은 텍스처 → 블러 (글로우)
    this._pass(this.copyProg, GA, GA.w, GA.h);
    gl.bindTexture(gl.TEXTURE_2D, this.mask.tex);
    gl.uniform1i(this.copyProg.u.uMask, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this._blur(this.gfbos, 2, LOOK.glowSpread);

    // 3) 최종 합성
    const c = this.compProg;
    this._pass(c, null, W, H);
    const bind = (unit, tex, name) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(c.u[name], unit);
    };
    bind(0, this.srcTex, 'uSrc');
    bind(1, A.tex, 'uBlur');
    bind(2, this.mask.tex, 'uMask');
    bind(3, GA.tex, 'uMaskBlur');
    gl.uniform2f(c.u.uRes, W, H);
    gl.uniform2f(c.u.uCover, cover[0], cover[1]);
    gl.uniform1f(c.u.uMirror, mirror);
    gl.uniform3fv(c.u.uWash, this.washColor);
    gl.uniform1f(c.u.uWashAmt, LOOK.washAmount);
    gl.uniform3fv(c.u.uGlow, this.glowColor);
    gl.uniform1f(c.u.uGlowAmt, LOOK.glowAmount);
    gl.uniform1f(c.u.uGlowGain, LOOK.glowGain);
    gl.uniform1f(c.u.uGlowFrame, LOOK.glowWidthFrame);
    gl.uniform1f(c.u.uOpacity, LOOK.veilOpacity);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
  }
}
