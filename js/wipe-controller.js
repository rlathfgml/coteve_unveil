// =============================================================
// '닦기' 동작 판단 + 손이 지나간 길(스트로크) 기록
//
// - 손을 편 채로 좌→우 / 우→좌로 일정 속도 이상 움직이면 '닦는 중'
// - 닦는 동안 손바닥 중심이 지나간 길을 기록 → 이 길에 맞춰 호(arc)를 그려 베일을 지움
// - 손을 멈추거나 방향을 바꾸면 한 번의 닦기가 끝나고, 다음 움직임은 새 닦기로 이어짐
//   → 손이 움직이는 대로 계속 지워지고, 지워진 곳은 다시 가려지지 않음
// =============================================================

export const WIPE = {
  startSpeed: 0.35,   // 닦기 시작으로 인정하는 손 속도 (초당 화면 가로 비율)
  keepSpeed: 0.12,    // 닦는 중일 때 유지되는 최소 속도
  stopDelay: 0.12,    // 이 시간(초) 동안 느리면 한 번의 닦기가 끝난 것으로 처리
  maxGap: 0.25,       // 이 시간(초) 이상 손이 안 보이면 새 동작으로 취급
  matchRadius: 0.4,   // 직전 프레임과 같은 손으로 볼 최대 이동 거리
  smoothing: 0.5,     // 손 위치 흔들림 줄이기 (0~1, 클수록 부드럽지만 늦게 따라옴)
  requireOpenHand: true,
};

export class WipeController {
  constructor() { this.reset(); }

  reset() {
    this.tracks = [];
    this.finished = [];   // 끝난 닦기 (화면에 영구히 새길 것)
    this.started = false;
    this.wipingNow = false;
  }

  /** 지금 진행 중인 닦기들 (매 프레임 다시 그려짐) */
  get activeStrokes() {
    return this.tracks.filter((t) => t.stroke).map((t) => t.stroke);
  }

  /** 끝난 닦기를 꺼내 감 (렌더러가 영구 기록) */
  takeFinished() {
    const f = this.finished;
    this.finished = [];
    return f;
  }

  _end(stroke) {
    if (stroke && stroke.points.length > 1) this.finished.push(stroke);
  }

  /** @param hands handsToScreen() 결과, @param t 초 단위 시간 */
  update(hands, t) {
    const next = [];
    const used = new Set();
    this.wipingNow = false;

    for (const h of hands) {
      // 직전 프레임의 같은 손 찾기 (가장 가까운 것)
      let best = null, bestD = WIPE.matchRadius;
      for (const tr of this.tracks) {
        if (used.has(tr)) continue;
        const d = Math.hypot(tr.rx - h.cx, tr.ry - h.cy);
        if (d < bestD) { best = tr; bestD = d; }
      }
      if (best) used.add(best);

      const tr = { rx: h.cx, ry: h.cy, x: h.cx, y: h.cy, w: h.maxX - h.minX, t, vx: 0, slowSince: null, stroke: null };

      if (best && t - best.t < WIPE.maxGap) {
        const dt = Math.max(t - best.t, 1 / 120); // 같은 시각에 들어온 입력도 처리
        const a = WIPE.smoothing;
        tr.x = best.x * a + h.cx * (1 - a);
        tr.y = best.y * a + h.cy * (1 - a);
        const raw = (h.cx - best.rx) / dt;
        tr.vx = best.vx * 0.5 + raw * 0.5;
        const speed = Math.abs(tr.vx);
        const openOk = !WIPE.requireOpenHand || h.open;
        let stroke = best.stroke;

        // 방향이 바뀌면 지금 닦기를 끝내고 새로 시작
        if (stroke && Math.sign(tr.vx) !== stroke.dir && speed > WIPE.startSpeed) {
          this._end(stroke);
          stroke = null;
        }

        if (stroke) {
          if (speed < WIPE.keepSpeed || !openOk) {
            tr.slowSince = best.slowSince ?? t;
            if (t - tr.slowSince > WIPE.stopDelay) { this._end(stroke); stroke = null; }
          }
        } else if (openOk && speed > WIPE.startSpeed) {
          // 새 닦기 시작: 직전 위치부터 기록
          stroke = { dir: Math.sign(tr.vx), points: [{ x: best.x, y: best.y }], width: tr.w };
          this.started = true;
        }

        if (stroke) {
          const last = stroke.points[stroke.points.length - 1];
          if (Math.hypot(tr.x - last.x, tr.y - last.y) > 0.004) stroke.points.push({ x: tr.x, y: tr.y });
          stroke.width = Math.max(stroke.width * 0.9, tr.w);
          this.wipingNow = true;
        }
        tr.stroke = stroke;
      } else if (best) {
        this._end(best.stroke); // 너무 오래 안 보였던 손: 이전 닦기 마무리
      }
      next.push(tr);
    }

    // 화면에서 사라진 손의 닦기는 마무리
    for (const old of this.tracks) if (!used.has(old)) this._end(old.stroke);
    this.tracks = next;
  }

  /** 마우스 테스트용: 손을 뗐을 때 진행 중인 닦기를 모두 마무리 */
  endAll() {
    for (const tr of this.tracks) { this._end(tr.stroke); tr.stroke = null; }
    this.tracks = [];
  }
}
