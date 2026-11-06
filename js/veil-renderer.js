// =============================================================
// 베일 그래픽 렌더러 (WebGL2)
//
// 레퍼런스(피그마 Inner Glow + Layer Blur)를 화면에서 재현하는 방식:
//  1) 웹캠 영상을 작게 줄여 여러 번 흐리게(블러) 만든다  → "베일 속 흐린 얼굴"
//  2) 화면을 "닦인 창(선명)"과 "베일(흐림+핑크)"로 나눈다
//  3) 핑크 색은 베일 조각의 '테두리 안쪽'에만 짙게 맺힌다 (Inner Glow)
//     - 베일 가운데: 흐린 영상이 옅은 핑크로 비침
//     - 베일 가장자리(화면 테두리 / 닦인 창과의 경계): 진한 핑크
//  4) 닦인 창 안쪽은 색·블러 없이 완전히 선명
// =============================================================

// 디자인 수치는 여기서 쉽게 조절할 수 있어요.
export const LOOK = {
  washColor: [0.985, 0.83, 0.87],  // 베일 가운데에 깔리는 옅은 핑크
  washAmount: 0.38,                // 옅은 핑크가 흐린 영상을 덮는 정도 (0~1)
  glowColor: [0.92, 0.47, 0.62],   // 테두리 안쪽의 진한 핑크 (Inner Glow)
  glowAmount: 0.82,                // Inner Glow 최대 진하기 (0~1)
  glowWidthWindow: 0.075,          // 닦인 창 경계에서 베일 쪽으로 번지는 폭 (화면 높이 비율)
  glowWidthFrame: 0.11,            // 화면 테두리에서 안쪽으로 번지는 폭 (화면 높이 비율)
  edgeSoftness: 0.003,             // 경계선 부드러움 (작을수록 또렷)
  blurPasses: 3,                   // 블러 반복 횟수 (클수록 더 흐림)
  blurSpread: 2.2,                 // 블러 퍼짐 정도
  blurWidth: 200,                  // 블러용 축소 해상도(가로 픽셀)
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
uniform vec2 uLR;        // 닦인 창의 왼쪽/오른쪽 경계 (화면 가로 비율)
uniform float uOpen;     // 닦인 창이 존재하는 정도 (0~1)
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

// 닦인 창 모양까지의 거리(픽셀). 음수 = 창 안(선명), 양수 = 베일
float windowDist(vec2 p) {
  float W = uRes.x, H = uRes.y;
  float xn = p.x / W;
  float yn = p.y / H;            // 위쪽이 0
  // 위/아래 경계: 레퍼런스처럼 기울어진 곡선 (베일 띠가 위·아래에 남음)
  float topY = H * (0.17 - 0.135 * xn + 0.035 * xn * xn);
  float botY = H * (0.95 - 0.04 * xn - 0.11 * xn * xn);
  // 좌/우 경계: 손을 따라 움직이며, 유리 조각처럼 살짝 휘어진 곡선
  float bow = H * 0.32 * (yn - 0.5) * (yn - 0.5);
  float lx = uLR.x * W + bow;
  float rx = uLR.y * W - bow;
  float ex = max(lx - p.x, p.x - rx);
  float ey = max(topY - p.y, p.y - botY);
  float r = H * 0.10;            // 모서리 둥글기
  vec2 q = vec2(ex, ey) + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  vec2 p = vec2(vUv.x * uRes.x, (1.0 - vUv.y) * uRes.y);
  float H = uRes.y;

  vec3 sharp = texture(uSrc, srcUv(vUv)).rgb;
  vec3 blur  = texture(uBlur, vUv).rgb;

  // 닦인 창이 없으면 아주 먼 거리로 처리 → 전체가 베일
  float d = uOpen > 0.0 ? windowDist(p) : 1e5;

  // 베일 마스크: 0 = 선명, 1 = 베일
  float edge = max(1.2, H * uEdge);
  float veilMask = smoothstep(-edge, edge, d);

  // Inner Glow: 베일 조각의 테두리 안쪽에서 진하고, 안쪽으로 갈수록 사라짐
  float gWin = exp(-max(d, 0.0) / (H * uGlowWin)) * uOpen;
  // 화면 네 변 각각의 글로우를 부드럽게 합쳐 모서리에 각진 선이 생기지 않게 함
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

    // 원본 텍스처 (처음엔 옅은 핑크 1픽셀)
    this.srcTex = makeTex(gl);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([246, 214, 222, 255]));
    this.srcW = 1; this.srcH = 1;
    this.source = null;

    this.fbos = [this._makeFbo(), this._makeFbo()];
    this.resize();
  }

  _makeFbo() {
    const gl = this.gl;
    const tex = makeTex(gl);
    const fb = gl.createFramebuffer();
    return { tex, fb, w: 0, h: 0 };
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
    this.fbos.forEach(f => this._sizeFbo(f, bw, bh));
  }

  // 영상(video) 또는 이미지(img)를 원본으로 지정
  setSource(el) { this.source = el; }

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

  /**
   * @param {{left:number,right:number,open:number,mirror:boolean}} s
   *   left/right: 닦인 창 경계 (화면 가로 0~1, 화면 밖 값 허용)
   *   open: 0이면 닦인 창 없음
   */
  render(s) {
    const gl = this.gl;
    this.resize();
    this._uploadSource();
    gl.bindVertexArray(this.vao);
    const cover = this.coverFactor();
    const mirror = s.mirror ? 1 : 0;
    const [A, B] = this.fbos;

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
    this._pass(c, null, this.canvas.width, this.canvas.height);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.uniform1i(c.u.uSrc, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, A.tex);
    gl.uniform1i(c.u.uBlur, 1);
    gl.uniform2f(c.u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform2f(c.u.uCover, cover[0], cover[1]);
    gl.uniform1f(c.u.uMirror, mirror);
    gl.uniform2f(c.u.uLR, s.left, s.right);
    gl.uniform1f(c.u.uOpen, s.open);
    gl.uniform3fv(c.u.uWash, LOOK.washColor);
    gl.uniform1f(c.u.uWashAmt, LOOK.washAmount);
    gl.uniform3fv(c.u.uGlow, LOOK.glowColor);
    gl.uniform1f(c.u.uGlowAmt, LOOK.glowAmount);
    gl.uniform1f(c.u.uGlowWin, LOOK.glowWidthWindow);
    gl.uniform1f(c.u.uGlowFrame, LOOK.glowWidthFrame);
    gl.uniform1f(c.u.uEdge, LOOK.edgeSoftness);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.activeTexture(gl.TEXTURE0);
  }
}
