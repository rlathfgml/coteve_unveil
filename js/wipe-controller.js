// =============================================================
// '닦기' 동작 판단 + 손이 지나간 길(스트로크) 기록
//
// - 손을 편 채(손바닥) 또는 검지를 편 채(손가락)로 일정 속도 이상 움직이면 닦기 시작
// - 한 번 시작하면, 같은 손 모양이 유지되는 동안은 천천히 움직여도 계속 따라가며 닦음
//   (잠깐 손을 놓치거나 모양이 흐트러져도 keepGap 초 안에 돌아오면 이어서 닦음)
// - 손바닥 → 손바닥 중심을 따라 넓게, 손가락 → 검지 끝을 따라 얇게
// =============================================================

export const WIPE = {
  startSpeed: 0.45,   // 닦기 시작으로 인정하는 손 속도 (초당 화면 비율) — 클수록 덜 민감
  keepGap: 0.4,       // 손을 잠깐 놓치거나 모양이 흐트러져도 닦기를 이어가는 시간 (초)
  matchRadius: 0.4,   // 직전 프레임과 같은 손으로 볼 최대 이동 거리
  smoothing: 0.45,    // 손 위치 흔들림 줄이기 (0~1, 클수록 부드럽지만 늦게 따라옴)
};

export class WipeController {
  constructor() { this.reset(); }

  reset() {
    this.tracks = [];
    this.finished = [];   // 끝난 닦기
    this.started = false;
    this.wipingNow = false;
  }

  /** 지금 진행 중인 닦기들 */
  get activeStrokes() {
    return this.tracks.filter((t) => t.stroke).map((t) => t.stroke);
  }

  /** 끝난 닦기를 꺼내 감 */
  takeFinished() {
    const f = this.finished;
    this.finished = [];
    return f;
  }

  _end(stroke) {
    if (stroke) this.finished.push(stroke);
  }

  /** @param hands handsToScreen() 결과, @param t 초 단위 시간 */
  update(hands, t) {
    const next = [];
    const used = new Set();
    this.wipingNow = false;

    for (const h of hands) {
      // 직전 프레임의 같은 손 찾기 (손바닥 중심이 가장 가까운 것)
      let best = null, bestD = WIPE.matchRadius;
      for (const tr of this.tracks) {
        if (used.has(tr)) continue;
        const d = Math.hypot(tr.rx - h.cx, tr.ry - h.cy);
        if (d < bestD) { best = tr; bestD = d; }
      }
      if (best) used.add(best);

      // 닦는 위치: 손바닥이면 손바닥 중심, 손가락이면 검지 끝
      const px = h.mode === 'finger' ? h.tipX : h.cx;
      const py = h.mode === 'finger' ? h.tipY : h.cy;
      const tr = { rx: h.cx, ry: h.cy, px, py, x: px, y: py, mode: h.mode, t, speed: 0, stroke: null, lostSince: null };

      if (best && t - best.t < WIPE.keepGap) {
        const dt = Math.max(t - best.t, 1 / 120);
        const sameMode = best.mode === h.mode;
        if (sameMode && h.mode) {
          const a = WIPE.smoothing;
          tr.x = best.x * a + px * (1 - a);
          tr.y = best.y * a + py * (1 - a);
          const raw = Math.hypot(px - best.px, py - best.py) / dt;
          tr.speed = best.speed * 0.5 + raw * 0.5;
        }
        let stroke = best.stroke;

        if (stroke) {
          if (h.mode === stroke.mode) {
            const last = stroke.points[stroke.points.length - 1];
            if (Math.hypot(tr.x - last.x, tr.y - last.y) > 0.002) stroke.points.push({ x: tr.x, y: tr.y });
            this.wipingNow = true;
          } else if (h.mode === null) {
            // 손 모양이 잠깐 흐트러짐: 바로 끊지 않고 잠시 기다림
            tr.lostSince = best.lostSince ?? t;
            tr.x = best.x; tr.y = best.y; tr.mode = stroke.mode;
            if (t - tr.lostSince > WIPE.keepGap) { this._end(stroke); stroke = null; }
          } else {
            // 손바닥 ↔ 손가락 전환: 지금 닦기를 끝내고 새로 시작할 수 있게
            this._end(stroke); stroke = null;
          }
        }

        if (!stroke && h.mode && sameMode && tr.speed > WIPE.startSpeed) {
          stroke = { mode: h.mode, points: [{ x: best.x, y: best.y }, { x: tr.x, y: tr.y }], width: h.maxX - h.minX };
          this.started = true;
          this.wipingNow = true;
        }
        tr.stroke = stroke;
      } else if (best) {
        this._end(best.stroke);
      }
      next.push(tr);
    }

    // 이번 프레임에 안 보인 손: 잠깐은 기억해 두었다가(다시 나타나면 이어서 닦기), 오래 안 보이면 마무리
    for (const old of this.tracks) {
      if (used.has(old)) continue;
      if (t - old.t < WIPE.keepGap) next.push(old);
      else this._end(old.stroke);
    }
    this.tracks = next;
  }

  /** 마우스 테스트용: 손을 뗐을 때 진행 중인 닦기를 모두 마무리 */
  endAll() {
    for (const tr of this.tracks) { this._end(tr.stroke); tr.stroke = null; }
    this.tracks = [];
  }
}
