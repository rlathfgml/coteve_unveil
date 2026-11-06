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

export async function createHandTracker() {
  const fileset = await FilesetResolver.forVisionTasks(WASM);
  const make = (delegate) =>
    HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL, delegate },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  try {
    return await make('GPU'); // 그래픽카드로 빠르게
  } catch (e) {
    console.warn('GPU 사용 불가, CPU로 전환', e);
    return await make('CPU');
  }
}

// 손가락이 펴져 있는지 확인 (손끝이 마디보다 손목에서 더 멀면 '펴짐')
function countExtended(lm) {
  const w = lm[0];
  const dist = (a) => Math.hypot(a.x - w.x, a.y - w.y);
  const pairs = [[8, 6], [12, 10], [16, 14], [20, 18]];
  return pairs.reduce((n, [tip, pip]) => n + (dist(lm[tip]) > dist(lm[pip]) * 1.08 ? 1 : 0), 0);
}

/**
 * MediaPipe 결과(영상 좌표)를 화면 좌표(0~1, 거울 반전 + cover 잘림 반영)로 바꿔
 * 손마다 { minX, maxX, cx, cy, open } 를 돌려줘요.
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
    hands.push({ minX, maxX, cx, cy, open: countExtended(lm) >= 3 });
  }
  return hands;
}
