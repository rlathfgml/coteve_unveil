// =============================================================
// 베일 그래픽 렌더러 (WebGL2)
//
// 레퍼런스(피그마 Inner Glow + Layer Blur)를 화면에서 재현하는 방식:
//  1) 웹캠 영상을 작게 줄여 여러 번 흐리게(블러) 만든다  → "베일 속 흐린 얼굴"
//  2) 화면을 "닦인 영역(선명)"과 "베일(흐림+컬러)"로 나눈다
//  3) 컬러는 베일 조각의 '테두리 안쪽'에만 짙게 맺힌다 (Inner Glow)
//  4) 닦인 영역 안쪽은 색·블러 없이 완전히 선명
//
// 닦이는 모양 = 손이 지나간 길을 따라 그린 '호 모양 띠'
//  - 닦을 때마다 새 호가 더해지고(누적)
//  - 시간이 지나면 닦인 곳 가장자리부터 베일이 천천히 다시 차오름 (재응결)
//  - 각 호까지의 '거리'를 기억 텍스처에 저장 → 경계선은 또렷하고, 그 바깥쪽 베일 테두리에 컬러 글로우
// =============================================================

// 디자인 수치는 여기서 쉽게 조절할 수 있어요.
export const LOOK = {
  washMix: 0.72,         // 베일 가운데 옅은 색 = 선택 컬러를 흰색과 섞는 비율 (클수록 옅음)
  washAmount: 0.26,      // 옅은 색이 흐린 영상을 덮는 정도 (0~1)
  glowAmount: 0.72,      // Inner Glow 최대 진하기 (0~1)
  veilOpacity: 0.84,     // 베일 전체 불투명도 (낮을수록 뒤의 카메라 화면이 더 비침)
  glowWidthWindow: 0.075,// 닦인 영역 경계에서 베일 쪽으로 번지는 폭 (화면 높이 비율)
  glowWidthFrame: 0.11,  // 화면 테두리에서 안쪽으로 번지는 폭 (화면 높이 비율)
  edgeSoftness: 0.003,   // 경계선 부드러움 (작을수록 또렷)
  blurPasses: 3,         // 블러 반복 횟수 (클수록 더 흐림)
  blurSpread: 2.2,       // 블러 퍼짐 정도
  blurWidth: 200,        // 블러용 축소 해상도(가로 픽셀)
  cornerRadius: 0.035,   // 호 띠 양 끝 모서리 둥글기 (화면 높이 비율)
  maskScale: 0.5,        // 닦인 영역 기억 텍스처 해상도 (화면 대비)

  // ---- 다시 덮이기 (재응결) ----
  refogDelay: 4,         // 닦인 뒤 선명하게 유지되는 시간 (초)
  refogSpeed: 0.035,     // 그 뒤 베일이 가장자리부터 차오르는 속도 (초당 화면 높이 비율)
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

// 호 모양 띠 하나를 '거리 값'으로 그리기 (여러 개는 MAX 블렌딩으로 합쳐짐)
//  값 v = 0.5 - 거리/(2*범위)  → 띠 안쪽 > 0.5, 경계 = 0.5, 멀어질수록 0
const STROKE_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform vec2 uRes;       // 화면 픽셀 크기
uniform vec2 uC;         // 원 중심 (픽셀, 위쪽이 0)
uniform float uRho;      // 원 반지름
uniform float uMid;      // 호 가운데 각도
uniform float uHalfSpan; // 호 각도 범위의 절반
uniform float uHalf;     // 띠 두께의 절반
uniform float uCorner;
uniform float uRange;
const float PI = 3.14159265;
void main() {
  vec2 p = vec2(vUv.x * uRes.x, (1.0 - vUv.y) * uRes.y);
  vec2 v = p - uC;
  float r = length(v);
  float rel = atan(v.y, v.x) - uMid;
  rel = mod(rel + PI, 2.0 * PI) - PI;
  float da = (abs(rel) - uHalfSpan) * max(r, 1.0);
  float dr = abs(r - uRho) - uHalf;
  vec2 q = vec2(da, dr) + uCorner;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uCorner;
  float val = clamp(0.5 - d / (2.0 * uRange), 0.0, 1.0);
  // G = 유지 타이머 (닦인 곳과 그 주변은 1로 채움 → 시간이 지나며 줄어듦)
  o = vec4(val, step(0.35, val), 0.0, 1.0);
}`;

// 시간이 지나면: 유지 타이머(G)를 줄이고, 타이머가 끝난 곳은 거리 값(R)을 줄여 베일이 다시 차오르게
const DECAY_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uMask;
uniform float uDt;
uniform float uHold;
uniform float uShrink;
void main() {
  vec4 m = texture(uMask, vUv);
  float g = max(m.g - uDt / uHold, 0.0);
  float r = m.g > 0.0 ? m.r : max(m.r - uShrink * uDt, 0.0);
  o = vec4(r, g, 0.0, 1.0);
}`;

// 닦인 비율 계산용 (작은 텍스처로 줄이기)
const COVER_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uMask;
uniform sampler2D uLive;
void main() {
  float v = max(texture(uMask, vUv).r, texture(uLive, vUv).r);
  o = vec4(step(0.5, v), 0.0, 0.0, 1.0);
}`;

// 최종 합성: 선명한 영상 / 베일 / Inner Glow
const COMP_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uSrc;
uniform sampler2D uBlur;
uniform sampler2D uMask;   // 끝난 닦기들 (영구)
uniform sampler2D uLive;   // 진행 중인 닦기
uniform vec2 uRes;
uniform vec2 uCover;
uniform float uMirror;
uniform float uRange;
uniform vec3 uWash;
uniform float uWashAmt;
uniform vec3 uGlow;
uniform float uGlowAmt;
uniform float uGlowWin;
uniform float uGlowFrame;
uniform float uEdge;
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

  // 닦인 영역까지의 거리(픽셀). 음수 = 닦인 영역 안(선명), 양수 = 베일
  float v = max(texture(uMask, vUv).r, texture(uLive, vUv).r);
  float d = (0.5 - v) * 2.0 * uRange;

  // 베일 마스크: 0 = 선명, 1 = 베일
  float edge = max(1.2, H * uEdge);
  float veilMask = smoothstep(-edge, edge, d);

  // Inner Glow: 베일 조각의 테두리 안쪽에서 진하고, 안쪽으로 갈수록 사라짐
  float gWin = exp(-max(d, 0.0) / (H * uGlowWin)) * step(v, 0.999) * smoothstep(0.0, 0.02, v);
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
    // 거리 값을 정밀하게 저장할 수 있으면 16비트, 아니면 8비트
    this.floatMask = !!gl.getExtension('EXT_color_buffer_float');
    this.mapProg = program(gl, MAP_FRAG);
    this.blurProg = program(gl, BLUR_FRAG);
    this.strokeProg = program(gl, STROKE_FRAG);
    this.coverProg = program(gl, COVER_FRAG);
    this.decayProg = program(gl, DECAY_FRAG);
    this.compProg = program(gl, COMP_FRAG);
    this.vao = gl.createVertexArray();
    this.srcTex = makeTex(gl);
    this.clearSource();
    this.setColor('#FF80A0');
    this.bandHalf = 0.2;  // 닦이는 띠 두께의 절반 (화면 높이 비율) — 크기 슬라이더로 바뀜

    this.fbos = [this._makeFbo(), this._makeFbo()];
    this.masks = [this._makeFbo(), this._makeFbo()]; // 끝난 닦기들 (번갈아 쓰기)
    this.decayAcc = 0;
    this.live = this._makeFbo();   // 진행 중인 닦기
    this.tiny = this._makeFbo();   // 닦인 비율 계산용
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
    const bw = LOOK.blurWidth;
    const bh = Math.max(2, Math.round(bw * h / w));
    this.fbos.forEach((f) => this._sizeFbo(f, bw, bh, false));
    const mw = Math.round(w * LOOK.maskScale), mh = Math.round(h * LOOK.maskScale);
    this.masks.forEach((m) => { this._sizeFbo(m, mw, mh, this.floatMask); this._clear(m); });
    this._sizeFbo(this.live, mw, mh, this.floatMask); // 창 크기가 바뀌면 닦인 기록은 초기화
    this._clear(this.live);
  }

  /** 닦인 기록 모두 지우기 (다시 체험하기) */
  clearWipes() {
    this.masks.forEach((m) => this._clear(m));
    this._clear(this.live);
    this.coverage = 0;
  }

  get range() { return this.canvas.height * 0.3; }
  get mask() { return this.masks[0]; }

  /** 시간이 흐름에 따라 닦인 곳이 다시 덮이게 함 */
  decay(dt) {
    // 8비트 기록일 때는 변화가 너무 작아 반영이 안 되므로 0.1초씩 모아서 처리
    this.decayAcc += dt;
    const step = this.floatMask ? this.decayAcc : (this.decayAcc >= 0.1 ? this.decayAcc : 0);
    if (!step) return;
    this.decayAcc = 0;
    const gl = this.gl, d = this.decayProg;
    const [src, dst] = this.masks;
    gl.bindVertexArray(this.vao);
    this._pass(d, dst, dst.w, dst.h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(d.u.uMask, 0);
    gl.uniform1f(d.u.uDt, step);
    gl.uniform1f(d.u.uHold, LOOK.refogDelay);
    gl.uniform1f(d.u.uShrink, (LOOK.refogSpeed * this.canvas.height) / (2 * this.range));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.masks = [dst, src];
  }

  _drawArcs(target, arcs) {
    if (!arcs.length) return;
    const gl = this.gl, s = this.strokeProg;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
    gl.viewport(0, 0, target.w, target.h);
    gl.useProgram(s.p);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.MAX);
    gl.uniform2f(s.u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform1f(s.u.uCorner, LOOK.cornerRadius * this.canvas.height);
    gl.uniform1f(s.u.uRange, this.range);
    for (const a of arcs) {
      gl.uniform2f(s.u.uC, a.cx, a.cy);
      gl.uniform1f(s.u.uRho, a.rho);
      gl.uniform1f(s.u.uMid, a.mid);
      gl.uniform1f(s.u.uHalfSpan, a.halfSpan);
      gl.uniform1f(s.u.uHalf, a.half);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
  }

  /** 끝난 닦기를 영구 기록 */
  commitArcs(arcs) {
    this.gl.bindVertexArray(this.vao);
    this._drawArcs(this.mask, arcs);
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

  /** 닦인 비율(0~1) 다시 계산 — 가끔만 호출 */
  measureCoverage() {
    const gl = this.gl, t = this.tiny;
    gl.bindVertexArray(this.vao);
    this._pass(this.coverProg, t, t.w, t.h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.mask.tex);
    gl.uniform1i(this.coverProg.u.uMask, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.live.tex);
    gl.uniform1i(this.coverProg.u.uLive, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
    const px = new Uint8Array(t.w * t.h * 4);
    gl.readPixels(0, 0, t.w, t.h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let n = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] > 127) n++;
    this.coverage = n / (t.w * t.h);
    return this.coverage;
  }

  /**
   * @param {{liveArcs:Array, mirror:boolean}} s  liveArcs: 진행 중인 닦기의 호 목록
   */
  render(s) {
    const gl = this.gl;
    this.resize();
    this._uploadSource();
    gl.bindVertexArray(this.vao);
    const cover = this.coverFactor();
    const mirror = s.mirror ? 1 : 0;
    const [A, B] = this.fbos;
    const W = this.canvas.width, H = this.canvas.height;

    // 0) 진행 중인 닦기 다시 그리기
    this._clear(this.live);
    this._drawArcs(this.live, s.liveArcs || []);

    // 1) 원본 → 작은 텍스처
    this._pass(this.mapProg, A, A.w, A.h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.uniform1i(this.mapProg.u.uSrc, 0);
    gl.uniform2f(this.mapProg.u.uCover, cover[0], cover[1]);
    gl.uniform1f(this.mapProg.u.uMirror, mirror);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 2) 블러 반복 (가로 → 세로)
    for (let i = 0; i < LOOK.blurPasses; i++) {
      const spread = LOOK.blurSpread * (1 + i * 0.5);
      this._pass(this.blurProg, B, B.w, B.h);
      gl.bindTexture(gl.TEXTURE_2D, A.tex);
      gl.uniform1i(this.blurProg.u.uTex, 0);
      gl.uniform2f(this.blurProg.u.uStep, spread / A.w, 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      this._pass(this.blurProg, A, A.w, A.h);
      gl.bindTexture(gl.TEXTURE_2D, B.tex);
      gl.uniform2f(this.blurProg.u.uStep, 0, spread / B.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

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
    bind(3, this.live.tex, 'uLive');
    gl.uniform2f(c.u.uRes, W, H);
    gl.uniform2f(c.u.uCover, cover[0], cover[1]);
    gl.uniform1f(c.u.uMirror, mirror);
    gl.uniform1f(c.u.uRange, this.range);
    gl.uniform3fv(c.u.uWash, this.washColor);
    gl.uniform1f(c.u.uWashAmt, LOOK.washAmount);
    gl.uniform3fv(c.u.uGlow, this.glowColor);
    gl.uniform1f(c.u.uGlowAmt, LOOK.glowAmount);
    gl.uniform1f(c.u.uGlowWin, LOOK.glowWidthWindow);
    gl.uniform1f(c.u.uGlowFrame, LOOK.glowWidthFrame);
    gl.uniform1f(c.u.uEdge, LOOK.edgeSoftness);
    gl.uniform1f(c.u.uOpacity, LOOK.veilOpacity);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
  }
}
