// =============================================================
// '닦기' 동작 판단 + 닦인 영역 기억
//
// - 손을 편 채로 좌→우 / 우→좌로 일정 속도 이상 움직이면 '닦는 중'
// - 손이 지나간 가로 구간을 하나의 창(왼쪽 경계 ~ 오른쪽 경계)으로 넓혀 감
//   → 작은 구멍이나 자유형 자국 없이, 베일 경계가 좌우로만 밀려남
// - 한 번 닦인 곳은 다시 가려지지 않음 (창은 넓어지기만 함)
// =============================================================

export const WIPE = {
  startSpeed: 0.35,   // 닦기 시작으로 인정하는 손 속도 (초당 화면 가로 비율)
  keepSpeed: 0.12,    // 닦는 중일 때 유지되는 최소 속도
  snapEdge: 0.06,     // 화면 끝에서 이만큼 가까워지면 끝까지 닦인 것으로 처리
  maxGap: 0.25,       // 이 시간(초) 이상 손이 안 보이면 새 동작으로 취급
  matchRadius: 0.4,   // 직전 프레임과 같은 손으로 볼 최대 이동 거리
  requireOpenHand: true,
};

export class WipeController {
  constructor() {
    this.tracks = [];
    this.reset();
  }

  reset() {
    this.left = null;   // 닦인 창 왼쪽 경계 (null = 아직 안 닦임)
    this.right = null;
    this.tracks = [];
    this.wipingNow = false;
  }

  get started() { return this.left !== null; }
  get complete() { return this.started && this.left < 0 && this.right > 1; }

  /** @param hands handsToScreen() 결과, @param t 초 단위 시간 */
  update(hands, t) {
    const next = [];
    const used = new Set();
    this.wipingNow = false;
    for (const h of hands) {
      // 직전 프레임의 같은 손 찾기 (가장 가까운 것)
      let best = null, bestD = WIPE.matchRadius;
      for (const tr of this.tracks) {
        const d = Math.hypot(tr.cx - h.cx, tr.cy - h.cy);
        if (d < bestD && !used.has(tr)) { best = tr; bestD = d; }
      }
      if (best) used.add(best);
      const tr = { ...h, t, vx: 0, wiping: false };
      if (best && t - best.t < WIPE.maxGap) {
        const dt = Math.max(t - best.t, 1 / 120); // 같은 시각에 들어온 입력도 처리
        const raw = (h.cx - best.cx) / dt;
        tr.vx = best.vx * 0.5 + raw * 0.5;
        const speed = Math.abs(tr.vx);
        const openOk = !WIPE.requireOpenHand || h.open;
        tr.wiping = openOk && (best.wiping ? speed > WIPE.keepSpeed : speed > WIPE.startSpeed);
        if (tr.wiping) {
          // 이번 프레임에 손이 쓸고 지나간 가로 구간
          this._expand(Math.min(best.minX, h.minX), Math.max(best.maxX, h.maxX));
          this.wipingNow = true;
        }
      }
      next.push(tr);
    }
    this.tracks = next;
  }

  _expand(lo, hi) {
    lo = Math.max(lo, -0.02);
    hi = Math.min(hi, 1.02);
    if (this.left === null) { this.left = lo; this.right = hi; }
    else { this.left = Math.min(this.left, lo); this.right = Math.max(this.right, hi); }
    // 화면 끝 근처까지 닦으면 경계를 화면 밖으로 완전히 밀어냄
    if (this.left < WIPE.snapEdge) this.left = -0.35;
    if (this.right > 1 - WIPE.snapEdge) this.right = 1.35;
  }
}
