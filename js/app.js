// =============================================================
// 전체 흐름: 시작 버튼 → 카메라 켜기 → 손 인식 → 베일 그리기
// =============================================================
import { VeilRenderer } from './veil-renderer.js';
import { createHandTracker, handsToScreen } from './hand-tracker.js';
import { WipeController } from './wipe-controller.js';

const $ = (id) => document.getElementById(id);
const canvas = $('stage');
const video = $('cam');
const ui = {
  intro: $('intro'), loading: $('loading'), error: $('error'), errorMsg: $('error-msg'),
  hud: $('hud'), status: $('status'), statusText: $('status-text'),
  hint: $('hint'), done: $('done-copy'), dot: $('hand-dot'),
};

// 주소 끝에 ?test 를 붙이면: 카메라 대신 레퍼런스 이미지 + 마우스 드래그로 테스트
// 주소 끝에 ?mouse 를 붙이면: 카메라 + 마우스 드래그도 함께 사용
const params = new URLSearchParams(location.search);
const TEST = params.has('test');
const MOUSE = TEST || params.has('mouse');

let renderer;
try {
  renderer = new VeilRenderer(canvas);
} catch (e) {
  showError('이 브라우저에서는 그래픽 기능(WebGL2)을 쓸 수 없어요. 최신 Chrome, Edge, Safari에서 열어 주세요.');
}

const wipe = new WipeController();
let tracker = null;
let mirror = true;
let running = false;
let lastVideoTime = -1;

// 화면에 보이는 경계는 목표 위치를 부드럽게 따라가요
const view = { left: 0.5, right: 0.5, open: 0 };

function show(el, on) { el.classList.toggle('hidden', !on); }

function showError(msg) {
  show(ui.intro, false); show(ui.loading, false); show(ui.hud, false);
  ui.errorMsg.textContent = msg;
  show(ui.error, true);
}

async function start() {
  show(ui.intro, false); show(ui.error, false); show(ui.loading, true);
  try {
    if (TEST) {
      const img = new Image();
      img.src = 'cotev_visual.png';
      await img.decode();
      renderer.setSource(img);
      mirror = false;
    } else {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw Object.assign(new Error(), { name: 'NoSupport' });
      }
      const [stream, t] = await Promise.all([
        navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        }),
        createHandTracker(),
      ]);
      tracker = t;
      video.srcObject = stream;
      await video.play();
      renderer.setSource(video);
    }
    show(ui.loading, false);
    show(ui.hud, true);
    running = true;
  } catch (e) {
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

function resetExperience() {
  wipe.reset();
  view.open = 0;
  ui.hint.classList.remove('gone');
  ui.done.classList.remove('show');
}

// ---------- 매 프레임 ----------
let prevT = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  if (!renderer) return;
  const dt = Math.min(0.1, (now - prevT) / 1000);
  prevT = now;

  // 1) 손 인식
  if (running && tracker && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const result = tracker.detectForVideo(video, now);
    const hands = handsToScreen(result, renderer.coverFactor(), mirror);
    wipe.update(hands, now / 1000);
    updateHandUi(hands);
  }

  // 2) 화면 경계를 목표 쪽으로 부드럽게 이동
  if (wipe.started) {
    if (view.open === 0) {
      // 처음 닦기 시작한 순간: 손 위치에서 창이 열리기 시작
      const mid = (wipe.left + wipe.right) / 2;
      view.left = view.right = mid;
    }
    const k = 1 - Math.exp(-dt * 10);
    view.left += (wipe.left - view.left) * k;
    view.right += (wipe.right - view.right) * k;
    view.open = Math.min(1, Math.max(0.0001, (view.right - view.left) / 0.08));
    ui.hint.classList.add('gone');
    if (wipe.complete) ui.done.classList.add('show');
  }

  renderer.render({ left: view.left, right: view.right, open: view.open, mirror });
}
requestAnimationFrame(frame);

function updateHandUi(hands) {
  const seen = hands.length > 0;
  ui.status.classList.toggle('on', seen);
  ui.statusText.textContent = seen ? '손 인식됨' : '손을 화면에 보여 주세요';
  const h = hands[0];
  ui.dot.classList.toggle('visible', seen);
  ui.dot.classList.toggle('wiping', wipe.wipingNow);
  if (h) ui.dot.style.transform = `translate(${h.cx * innerWidth}px, ${h.cy * innerHeight}px)`;
}

// ---------- 마우스 테스트 모드 ----------
if (MOUSE) {
  let down = false;
  const fake = (e) => {
    const x = e.clientX / innerWidth, y = e.clientY / innerHeight;
    return [{ minX: x - 0.03, maxX: x + 0.03, cx: x, cy: y, open: true }];
  };
  canvas.addEventListener('pointerdown', (e) => { down = true; wipe.update(fake(e), performance.now() / 1000); });
  window.addEventListener('pointerup', () => { down = false; wipe.update([], performance.now() / 1000); });
  window.addEventListener('pointermove', (e) => { if (down) wipe.update(fake(e), performance.now() / 1000); });
}

// 테스트용: 개발자 도구에서 window.__veil 로 상태 확인
window.__veil = { wipe, view };

$('start-btn').addEventListener('click', start);
$('retry-btn').addEventListener('click', start);
$('reset-btn').addEventListener('click', resetExperience);
