// =============================================================
// 베일 그래픽 렌더러 (WebGL2)
//
// 레퍼런스(피그마 Inner Glow + Layer Blur)를 화면에서 재현하는 방식:
//  1) 웹캠 영상을 작게 줄여 여러 번 흐리게(블러) 만든다  → "베일 속 흐린 얼굴"
//  2) 화면을 "닦인 영역(선명)"과 "베일(흐림+컬러)"로 나눈다
//  3) 컬러는 베일 조각의 '테두리 안쪽'에만 짙게 맺힌다 (Inner Glow)
//  4) 닦인 영역 안쪽은 색·블러 없이 완전히 선명
//
// 닦이는 모양 = 자동차 와이퍼처럼 '화면 아래 보이지 않는 축'을 중심으로 도는 호(arc)
//  - 손이 좌우로 움직이면 경계가 축을 중심으로 회전하며 호를 그리며 열림
//  - 닦인 영역은 휘어진 띠 모양, 위/아래 모서리에는 초승달 모양 베일이 남음
// =============================================================

// 디자인 수치는 여기서 쉽게 조절할 수 있어요.
export const LOOK = {
  washMix: 0.72,         // 베일 가운데 옅은 색 = 선택 컬러를 흰색과 섞는 비율 (클수록 옅음)
  washAmount: 0.38,      // 옅은 색이 흐린 영상을 덮는 정도 (0~1)
  glowAmount: 0.82,      // Inner Glow 최대 진하기 (0~1)
  glowWidthWindow: 0.075,// 닦인 영역 경계에서 베일 쪽으로 번지는 폭 (화면 높이 비율)
  glowWidthFrame: 0.11,  // 화면 테두리에서 안쪽으로 번지는 폭 (화면 높이 비율)
  edgeSoftness: 0.003,   // 경계선 부드러움 (작을수록 또렷)
  blurPasses: 3,         // 블러 반복 횟수 (클수록 더 흐림)
  blurSpread: 2.2,       // 블러 퍼짐 정도
  blurWidth: 200,        // 블러용 축소 해상도(가로 픽셀)

  // ---- 호(arc) 모양 ----
  pivotX: 0.5,           // 회전축 가로 위치 (화면 가로 비율)
  pivotY: 2.2,           // 회전축 세로 위치 (화면 높이 기준, 1 = 화면 맨 아래)
  arcRadius: 1.75,       // 닦이는 띠의 중심 반지름 (화면 높이 기준)
  arcBulge: 0.035,       // 닦기 경계(앞쪽 끝)가 볼록하게 휘는 정도
  cornerRadius: 0.04,    // 닦인 영역 모서리 둥글기 (화면 높이 비율)
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

// 최종 합성: 선명한 영상 / 베일 / Inner Glow
const COMP_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 o;
uniform sampler2D uSrc;
uniform sampler2D uBlur;
uniform vec2 uRes;
uniform vec2 uCover;
uniform float uMirror;
uniform vec2 uAng;       // 닦인 영역의 왼쪽/오른쪽 경계 각도 (라디안, 0 = 위쪽)
uniform vec3 uArc;       // 회전축 x, y, 띠 중심 반지름 (픽셀)
uniform float uHalf;     // 띠 두께의 절반 (픽셀)
uniform float uBulge;    // 경계 볼록함 (라디안)
uniform float uCorner;   // 모서리 둥글기 (픽셀)
uniform float uOpen;     // 닦인 영역이 존재하는 정도 (0~1)
uniform vec3 uWash;
uniform float uWashAmt;
uniform vec3 uGlow;
uniform float uGlowAmt;
uniform float uGlowWin;
uniform float uGlowFrame;
uniform float uEdge;

vec2 srcUv(vec2 s) {
  vec2 v = (s - 0.5) * uCover + 0.5;
  if (uMirror > 0.5) v.x = 1.0 - v.x;
  return v;
}

// 닦인 영역(호 모양 띠)까지의 거리(픽셀). 음수 = 닦인 영역 안(선명), 양수 = 베일
float windowDist(vec2 p) {
  vec2 v = p - uArc.xy;
  float r = length(v);
  float th = atan(v.x, -v.y);                    // 회전축에서 본 각도 (0 = 바로 위)
  float s = clamp((r - uArc.z) / uHalf, -1.0, 1.0);
  float b = uBulge * (1.0 - s * s) * uOpen;      // 경계 가운데가 볼록하게
  float da = max((uAng.x - b) - th, th - (uAng.y + b)) * r;
  float dr = max((uArc.z - uHalf) - r, r - (uArc.z + uHalf));
  vec2 q = vec2(da, dr) + uCorner;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uCorner;
}

void main() {
  vec2 p = vec2(vUv.x * uRes.x, (1.0 - vUv.y) * uRes.y);   // 위쪽이 0
  float H = uRes.y;

  vec3 sharp = texture(uSrc, srcUv(vUv)).rgb;
  vec3 blur  = texture(uBlur, vUv).rgb;

  // 닦인 영역이 없으면 아주 먼 거리로 처리 → 전체가 베일
  float d = uOpen > 0.0 ? windowDist(p) : 1e5;

  // 베일 마스크: 0 = 선명, 1 = 베일
  float edge = max(1.2, H * uEdge);
  float veilMask = smoothstep(-edge, edge, d);

  // Inner Glow: 베일 조각의 테두리 안쪽에서 진하고, 안쪽으로 갈수록 사라짐
  float gWin = exp(-max(d, 0.0) / (H * uGlowWin)) * uOpen;
  float fw = H * uGlowFrame;
  vec4 eg = exp(-vec4(p.x, uRes.x - p.x, p.y, uRes.y - p.y) / fw);
  float gFrame = 1.0 - (1.0 - eg.x) * (1.0 - eg.y) * (1.0 - eg.z) * (1.0 - eg.w);
  float glow = 1.0 - (1.0 - gWin) * (1.0 - gFrame * 0.9);

  vec3 veil = mix(blur, uWash, uWashAmt);
  veil = mix(veil, uGlow, glow * uGlowAmt);

  o = vec4(mix(sharp, veil, veilMask), 1.0);
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
    this.mapProg = program(gl, MAP_FRAG);
    this.blurProg = program(gl, BLUR_FRAG);
    this.compProg = program(gl, COMP_FRAG);
    this.vao = gl.createVertexArray();
    this.srcTex = makeTex(gl);
    this.clearSource();
    this.setColor('#FF80A0');
    this.bandHalf = 0.28;  // 닦이는 띠 두께의 절반 (화면 높이 비율) — 크기 슬라이더로 바뀜

    this.fbos = [this._makeFbo(), this._makeFbo()];
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

  _sizeFbo(f, w, h) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, f.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, f.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, f.tex, 0);
    f.w = w; f.h = h;
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
    this.fbos.forEach((f) => this._sizeFbo(f, bw, bh));
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

  // 화면 가로 위치(0~1) → 회전축 기준 각도
  xToAngle(x) {
    const W = this.canvas.width, H = this.canvas.height;
    const R = LOOK.arcRadius * H;
    const t = (x * W - LOOK.pivotX * W) / R;
    return Math.asin(Math.max(-1, Math.min(1, t)));
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

  /**
   * @param {{left:number,right:number,open:number,mirror:boolean}} s
   *   left/right: 닦인 영역 경계 (화면 가로 0~1, 화면 밖 값 허용)
   *   open: 0이면 닦인 영역 없음
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
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.uniform1i(c.u.uSrc, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, A.tex);
    gl.uniform1i(c.u.uBlur, 1);
    gl.uniform2f(c.u.uRes, W, H);
    gl.uniform2f(c.u.uCover, cover[0], cover[1]);
    gl.uniform1f(c.u.uMirror, mirror);
    gl.uniform2f(c.u.uAng, this.xToAngle(s.left), this.xToAngle(s.right));
    gl.uniform3f(c.u.uArc, LOOK.pivotX * W, LOOK.pivotY * H, LOOK.arcRadius * H);
    gl.uniform1f(c.u.uHalf, this.bandHalf * H);
    gl.uniform1f(c.u.uBulge, LOOK.arcBulge);
    gl.uniform1f(c.u.uCorner, LOOK.cornerRadius * H);
    gl.uniform1f(c.u.uOpen, s.open);
    gl.uniform3fv(c.u.uWash, this.washColor);
    gl.uniform1f(c.u.uWashAmt, LOOK.washAmount);
    gl.uniform3fv(c.u.uGlow, this.glowColor);
    gl.uniform1f(c.u.uGlowAmt, LOOK.glowAmount);
    gl.uniform1f(c.u.uGlowWin, LOOK.glowWidthWindow);
    gl.uniform1f(c.u.uGlowFrame, LOOK.glowWidthFrame);
    gl.uniform1f(c.u.uEdge, LOOK.edgeSoftness);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
  }
}
