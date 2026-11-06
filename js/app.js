// =============================================================
// 전체 흐름: 홈 화면 → 카메라 켜기 → 손 인식 → 베일 그리기 → 촬영/저장 → (처음으로)
// =============================================================
import { VeilRenderer, hexToRgb } from './veil-renderer.js';
import { createHandTracker, handsToScreen } from './hand-tracker.js';
import { WipeController } from './wipe-controller.js';
import * as cap from './capture.js';

const $ = (id) => document.getElementById(id);
const canvas = $('stage');
const video = $('cam');
const ui = {
  intro: $('intro'), loading: $('loading'), error: $('error'), errorMsg: $('error-msg'),
  hud: $('hud'), status: $('status'), statusText: $('status-text'),
  hint: $('hint'), done: $('done-copy'), dot: $('hand-dot'),
  sizeRow: $('size-row'), size: $('size'),
  countdown: $('countdown'), flash: $('flash'),
  shot: $('shot'), shotImg: $('shot-img'), shareBtn: $('share-btn'),
};

// 주소 끝에 ?test 를 붙이면: 카메라 대신 레퍼런스 이미지 + 마우스 드래그로 테스트
// 주소 끝에 ?mouse 를 붙이면: 카메라 + 마우스 드래그도 함께 사용
const params = new URLSearchParams(location.search);
const TEST = params.has('test');
const MOUSE = TEST || params.has('mouse');
const DONE_RATIO = 0.6; // 화면의 이만큼 닦이면 "Reveal Your Smile." 문구 표시
const FOLLOW = 12;      // 붓이 손을 따라가는 빠르기 (클수록 즉각, 작을수록 부드럽게 미끄러짐)
const FINGER_SIZE = 0.2; // 손가락으로 닦을 때 붓 크기 (손바닥 붓 대비 비율)

let renderer;
try {
  renderer = new VeilRenderer(canvas);
} catch (e) {
  showError('이 브라우저에서는 그래픽 기능(WebGL2)을 쓸 수 없어요. 최신 Chrome, Edge, Safari에서 열어 주세요.');
}

const wipe = new WipeController();
let tracker = null;      // 한 번 불러온 손 인식 AI는 계속 재사용
let stream = null;
let mirror = true;
let running = false;
let session = 0;         // '처음으로'를 누르면 진행 중이던 준비 과정을 무시하기 위한 번호
let lastVideoTime = -1;
let accentDeep = 'rgb(158,79,99)';

function show(el, on) { el.classList.toggle('hidden', !on); }

function showError(msg) {
  show(ui.intro, false); show(ui.loading, false); show(ui.hud, false); show(ui.sizeRow, false);
  ui.errorMsg.textContent = msg;
  show(ui.error, true);
}

// ---------- 베일 컬러 ----------
function setColor(hex) {
  renderer?.setColor(hex);
  const [r, g, b] = hexToRgb(hex).map((v) => Math.round(v * 255));
  // 글자 그림자·버튼 글자용 진한 색 (선택 컬러를 어둡게)
  const deep = [r, g, b].map((v) => Math.round(v * 0.62));
  accentDeep = `rgb(${deep.join(',')})`;
  const root = document.documentElement.style;
  root.setProperty('--accent', hex);
  root.setProperty('--accent-deep', accentDeep);
  root.setProperty('--accent-shadow', `rgba(${deep.join(',')},0.5)`);
  document.querySelectorAll('.swatch').forEach((s) =>
    s.classList.toggle('selected', s.dataset.color.toLowerCase() === hex.toLowerCase()));
}
document.querySelectorAll('.swatch').forEach((s) =>
  s.addEventListener('click', () => setColor(s.dataset.color)));
setColor('#AB7EFF'); // 처음 시작 컬러: 보라색

// ---------- 닦이는 크기 ----------
function setSize(v) { if (renderer) renderer.bandHalf = v; }
ui.size.addEventListener('input', () => setSize(parseFloat(ui.size.value)));
setSize(parseFloat(ui.size.value));

// ---------- 시작 ----------
async function start() {
  const my = ++session;
  show(ui.intro, false); show(ui.error, false); show(ui.loading, true);
  try {
    if (TEST) {
      const img = new Image();
      img.src = 'cotev_visual.png';
      await img.decode();
      if (my !== session) return;
      renderer.setSource(img);
      mirror = false;
    } else {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw Object.assign(new Error(), { name: 'NoSupport' });
      }
      const [s, t] = await Promise.all([
        navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        }),
        tracker ? Promise.resolve(tracker) : createHandTracker(),
      ]);
      tracker = t;
      if (my !== session) { s.getTracks().forEach((tr) => tr.stop()); return; }
      stream = s;
      video.srcObject = stream;
      await video.play();
      renderer.setSource(video);
      mirror = true;
    }
    resetExperience();
    show(ui.loading, false);
    show(ui.hud, true);
    show(ui.sizeRow, true);
    running = true;
  } catch (e) {
    if (my !== session) return;
    console.error(e);
    const messages = {
      NotAllowedError: '카메라 사용이 허용되지 않았어요. 주소창 왼쪽의 자물쇠/카메라 아이콘을 눌러 카메라를 "허용"으로 바꾼 뒤 다시 시도해 주세요.',
      NotFoundError: '연결된 카메라를 찾지 못했어요. 웹캠이 있는 컴퓨터에서 열어 주세요.',
      NotReadableError: '다른 프로그램(Zoom, Teams 등)이 카메라를 쓰고 있어요. 그 프로그램을 닫고 다시 시도해 주세요.',
      NoSupport: '이 브라우저는 카메라를 지원하지 않아요. 최신 Chrome에서 열어 주세요.',
    };
    showError(messages[e.name] || '준비 중 문제가 생겼어요. 인터넷 연결을 확인하고 다시 시도해 주세요.');
  }
}

// ---------- 처음으로 (홈 화면) ----------
function goHome() {
  session++;
  running = false;
  if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; } // 카메라 끄기
  video.pause();
  video.srcObject = null;
  renderer?.clearSource();
  resetExperience();
  updateHandUi([]);
  closeShot();
  show(ui.hud, false); show(ui.sizeRow, false); show(ui.loading, false); show(ui.error, false);
  show(ui.intro, true);
}

function resetExperience() {
  wipe.reset();
  lives = [];
  renderer?.clearWipes();
  ui.hint.classList.remove('gone');
  ui.done.classList.remove('show');
}

// ---------- 닦기 → 손을 부드럽게 따라가는 둥근 붓 ----------
// 손 위치는 1초에 30번 정도만 들어와서 그대로 그리면 뚝뚝 끊겨 보여요.
// 그래서 붓은 매 프레임(1초에 60번) 손 위치를 향해 미끄러지듯 따라가며, 지나간 길(호)을 칠해요.
// 한 번 칠해진 곳은 모양이 바뀌지 않아서 떨림이 없어요.
let lives = []; // { stroke, p, r, settling, age }

function updateBrush(dt) {
  const W = canvas.width, H = canvas.height;
  // 손바닥 = 넓은 붓(크기 슬라이더), 손가락 = 얇은 붓
  const radius = (mode) => mode === 'finger'
    ? Math.max(H * 0.025, renderer.bandHalf * H * FINGER_SIZE)
    : renderer.bandHalf * H;
  for (const s of wipe.activeStrokes) {
    if (!lives.some((l) => l.stroke === s)) {
      const p0 = s.points[0];
      lives.push({ stroke: s, p: { x: p0.x * W, y: p0.y * H }, r: radius(s.mode) * 0.5, age: 0 });
    }
  }
  for (const s of wipe.takeFinished()) {
    const l = lives.find((x) => x.stroke === s);
    if (l) l.settling = true; // 손을 멈춰도 붓이 손 위치까지 마저 미끄러진 뒤 멈춤
  }
  const k = 1 - Math.exp(-dt * FOLLOW);
  const segs = [];
  for (const l of lives) {
    const pts = l.stroke.points, last = pts[pts.length - 1];
    const tx = last.x * W, ty = last.y * H;
    const prev = { ...l.p };
    l.p.x += (tx - l.p.x) * k;
    l.p.y += (ty - l.p.y) * k;
    const R = radius(l.stroke.mode);
    l.r += (R - l.r) * (1 - Math.exp(-dt * 8)); // 붓 크기도 부드럽게 커짐
    l.age += dt;
    segs.push({ ax: prev.x, ay: prev.y, bx: l.p.x, by: l.p.y, r: l.r });
    if (l.settling && (Math.hypot(tx - l.p.x, ty - l.p.y) < 1 || l.age > 8)) l.dead = true;
  }
  lives = lives.filter((l) => !l.dead);
  renderer.paint(segs);
}

// ---------- 매 프레임 ----------
let lastCoverageCheck = 0;
let prevT = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  if (!renderer) return;
  const dt = Math.min(0.1, (now - prevT) / 1000);
  prevT = now;

  // 1) 손 인식
  if (running && tracker && stream && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const result = tracker.detectForVideo(video, now);
    const hands = handsToScreen(result, renderer.coverFactor(), mirror);
    wipe.update(hands, now / 1000);
    updateHandUi(hands);
  }

  // 2) 붓으로 칠하기 + 시간이 지나면 흐려지며 다시 덮이기
  updateBrush(dt);
  if (running) renderer.evolve(dt);

  if (wipe.started) ui.hint.classList.add('gone');

  renderer.render({ mirror });

  // 3) 가끔 닦인 비율 확인
  if (running && wipe.started && now - lastCoverageCheck > 500) {
    lastCoverageCheck = now;
    const cov = renderer.measureCoverage();
    if (cov > DONE_RATIO) ui.done.classList.add('show');
    else if (cov < DONE_RATIO * 0.7) ui.done.classList.remove('show'); // 다시 덮이면 문구도 사라짐
  }
}
requestAnimationFrame(frame);

function updateHandUi(hands) {
  const seen = hands.length > 0;
  ui.status.classList.toggle('on', seen);
  ui.statusText.textContent = seen ? '손 인식됨' : '손을 화면에 보여 주세요';
  // 표시 링: 손바닥이면 손바닥 중심, 손가락이면 검지 끝에 (손가락일 땐 작게)
  const h = hands.find((x) => x.mode) || hands[0];
  ui.dot.classList.toggle('visible', seen);
  ui.dot.classList.toggle('wiping', wipe.wipingNow);
  ui.dot.classList.toggle('finger', h?.mode === 'finger');
  if (h) {
    const x = h.mode === 'finger' ? h.tipX : h.cx, y = h.mode === 'finger' ? h.tipY : h.cy;
    ui.dot.style.transform = `translate(${x * innerWidth}px, ${y * innerHeight}px)`;
  }
}

// ---------- 촬영 ----------
let shotCanvas = null;   // 촬영 순간의 화면
let shooting = false;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function shoot() {
  if (shooting || !running) return;
  shooting = true;
  ui.hint.classList.add('gone');
  show(ui.countdown, true);
  for (const n of [3, 2, 1]) {
    ui.countdown.innerHTML = `<span>${n}</span>`;
    await wait(900);
  }
  show(ui.countdown, false);
  shotCanvas = cap.snapshot(canvas);        // 화면(영상 + 베일)만 찍힘, 버튼 등은 안 찍힘
  ui.flash.classList.remove('go'); void ui.flash.offsetWidth; ui.flash.classList.add('go');
  ui.shotImg.src = shotCanvas.toDataURL('image/jpeg', 0.85);
  show(ui.shareBtn, cap.canShareFiles());
  show(ui.shot, true);
  shooting = false;
}

function closeShot() { show(ui.shot, false); }

$('save-btn').addEventListener('click', () => shotCanvas && cap.download(shotCanvas));
ui.shareBtn.addEventListener('click', async () => {
  try { if (shotCanvas) await cap.share(shotCanvas); } catch (e) { console.warn(e); }
});
$('close-shot-btn').addEventListener('click', closeShot);
$('shoot-btn').addEventListener('click', shoot);

// ---------- 마우스 테스트 모드 ----------
if (MOUSE) {
  let down = false;
  const fake = (e) => {
    const x = e.clientX / innerWidth, y = e.clientY / innerHeight;
    // Shift 키를 누른 채 드래그하면 손가락 모드로 테스트
    return [{ minX: x - 0.03, maxX: x + 0.03, cx: x, cy: y, tipX: x, tipY: y, mode: e.shiftKey ? 'finger' : 'palm' }];
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (!running) return;
    down = true; wipe.update(fake(e), performance.now() / 1000);
  });
  window.addEventListener('pointerup', () => { if (down) wipe.endAll(); down = false; });
  window.addEventListener('pointermove', (e) => { if (down && running) wipe.update(fake(e), performance.now() / 1000); });
}

// 테스트용: 개발자 도구에서 window.__veil 로 상태 확인
window.__veil = { wipe, renderer };

$('start-btn').addEventListener('click', start);
$('retry-btn').addEventListener('click', start);
$('reset-btn').addEventListener('click', resetExperience);
$('home-btn').addEventListener('click', goHome);
$('error-home-btn').addEventListener('click', goHome);
