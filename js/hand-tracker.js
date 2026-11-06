// =============================================================
// MediaPipe 손 인식 불러오기
// (구글이 만든 손 인식 AI. 인터넷에서 자동으로 내려받아요)
// =============================================================
import {
  FilesetResolver,
  HandLandmarker,
} from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs';

const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

// 인식 민감도
//  - detection: 처음 손을 '찾을 때' 기준 (높을수록 확실한 손만 인식 → 민감도 ↓)
//  - presence / tracking: 한 번 찾은 손을 '계속 따라갈 때' 기준 (낮을수록 놓치지 않고 잘 따라감)
export const SENSITIVITY = {
  detection: 0.7,
  presence: 0.3,
  tracking: 0.3,
};

export async function createHandTracker() {
  const fileset = await FilesetResolver.forVisionTasks(WASM);
  const make = (delegate) =>
    HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL, delegate },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: SENSITIVITY.detection,
      minHandPresenceConfidence: SENSITIVITY.presence,
      minTrackingConfidence: SENSITIVITY.tracking,
    });
  try {
    return await make('GPU'); // 그래픽카드로 빠르게
  } catch (e) {
    console.warn('GPU 사용 불가, CPU로 전환', e);
    return await make('CPU');
  }
}

// 손가락이 펴져 있는지 (손끝이 마디보다 손목에서 더 멀면 '펴짐')
function extendedFingers(lm) {
  const w = lm[0];
  const dist = (a) => Math.hypot(a.x - w.x, a.y - w.y);
  const pairs = [[8, 6], [12, 10], [16, 14], [20, 18]]; // 검지, 중지, 약지, 새끼
  return pairs.map(([tip, pip]) => dist(lm[tip]) > dist(lm[pip]) * 1.08);
}

/**
 * 손 모양 판단
 *  - 'palm'   : 손을 편 상태 (손가락 3개 이상 펴짐) → 손바닥으로 넓게 닦기
 *  - 'finger' : 검지만(또는 검지+중지) 펴고 약지·새끼는 접은 상태 → 손끝으로 얇게 닦기
 *  - null     : 그 외 (주먹 등) → 닦지 않음
 */
function handMode(lm) {
  const [index, middle, ring, pinky] = extendedFingers(lm);
  const count = [index, middle, ring, pinky].filter(Boolean).length;
  if (count >= 3) return 'palm';
  if (index && !ring && !pinky) return 'finger';
  return null;
}

/**
 * MediaPipe 결과(영상 좌표)를 화면 좌표(0~1, 거울 반전 + cover 잘림 반영)로 바꿔
 * 손마다 { minX, maxX, cx, cy, tipX, tipY, mode } 를 돌려줘요.
 */
export function handsToScreen(result, cover, mirror = true) {
  const hands = [];
  if (!result || !result.landmarks) return hands;
  for (const lm of result.landmarks) {
    let minX = Infinity, maxX = -Infinity;
    const pts = lm.map((p) => {
      const vx = mirror ? 1 - p.x : p.x;
      const sx = (vx - 0.5) / cover[0] + 0.5;
      const sy = (p.y - 0.5) / cover[1] + 0.5;
      if (sx < minX) minX = sx;
      if (sx > maxX) maxX = sx;
      return { x: sx, y: sy };
    });
    // 손바닥 중심 (손목 + 손가락 뿌리 마디들)
    const palm = [0, 5, 9, 13, 17].map((i) => pts[i]);
    const cx = palm.reduce((s, p) => s + p.x, 0) / palm.length;
    const cy = palm.reduce((s, p) => s + p.y, 0) / palm.length;
    hands.push({ minX, maxX, cx, cy, tipX: pts[8].x, tipY: pts[8].y, mode: handMode(lm) });
  }
  return hands;
}
