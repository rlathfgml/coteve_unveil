// =============================================================
// 손이 지나간 길 → 매끈한 호(arc) 하나로 바꾸기
//
// 팔을 휘두르면 손은 자연스럽게 원의 일부를 그려요.
// 시작점·중간점·현재점 세 점을 지나는 원을 찾아, 그 원 위의 '두꺼운 띠'로 베일을 지웁니다.
// (자유로운 낙서 자국이 아니라 항상 깔끔한 호 모양)
// =============================================================

export const ARC = {
  minRadius: 0.55,   // 호의 최소 반지름 (화면 높이 기준) — 너무 둥글게 말리지 않게
  maxRadius: 6.0,    // 호의 최대 반지름 — 거의 직선일 때
  minLength: 0.025,  // 이 길이(화면 가로 비율)보다 짧은 움직임은 아직 그리지 않음
};

/**
 * @param stroke {points:[{x,y}], width} 화면 비율 좌표
 * @param W,H 캔버스 픽셀 크기
 * @param halfPx 띠 두께의 절반(픽셀)
 * @returns {cx, cy, rho, mid, halfSpan, half} 또는 null
 */
export function strokeToArc(stroke, W, H, halfPx) {
  const pts = stroke.points.map((p) => ({ x: p.x * W, y: p.y * H }));
  if (pts.length < 2) return null;

  // 손이 지나간 길이
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  if (len < ARC.minLength * W) return null;

  const a = pts[0], b = pts[pts.length - 1];
  // 길이의 절반 지점 근처 점들의 평균 = 중간점 (흔들림 완화)
  let acc = 0, mi = 0;
  for (let i = 1; i < pts.length; i++) {
    acc += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (acc >= len / 2) { mi = i; break; }
  }
  const lo = Math.max(1, mi - 2), hi = Math.min(pts.length - 2, mi + 2);
  let m = { x: 0, y: 0 }, n = 0;
  for (let i = lo; i <= hi; i++) { m.x += pts[i].x; m.y += pts[i].y; n++; }
  m = n ? { x: m.x / n, y: m.y / n } : { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };

  const chord = Math.hypot(b.x - a.x, b.y - a.y);
  const half = chord / 2;
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  // 현에 수직인 방향
  let nx = -(b.y - a.y) / (chord || 1), ny = (b.x - a.x) / (chord || 1);
  // 중간점이 현에서 얼마나 벗어났나 (= 휘어진 정도)
  const sag = (m.x - mx) * nx + (m.y - my) * ny;

  let rho;
  if (Math.abs(sag) < 1e-3) rho = ARC.maxRadius * H;
  else rho = (half * half + sag * sag) / (2 * Math.abs(sag)); // 세 점을 지나는 원의 반지름
  rho = Math.min(ARC.maxRadius * H, Math.max(rho, ARC.minRadius * H, half * 1.02, halfPx * 1.6));

  // 원의 중심은 휘어진 쪽의 반대편
  let side = sag >= 0 ? -1 : 1;
  if (Math.abs(sag) < 1e-3) side = ny > 0 ? 1 : -1; // 거의 직선이면 중심을 화면 아래쪽에 (팔꿈치 쪽)
  const dist = Math.sqrt(Math.max(0, rho * rho - half * half));
  const cx = mx + nx * dist * side, cy = my + ny * dist * side;

  const angA = Math.atan2(a.y - cy, a.x - cx);
  const angB = Math.atan2(b.y - cy, b.x - cx);
  let span = angB - angA;
  span = Math.atan2(Math.sin(span), Math.cos(span)); // -π ~ π
  const mid = angA + span / 2;
  // 손 너비만큼 양 끝을 늘려 손이 있던 자리까지 덮음
  const extend = Math.max(stroke.width * W * 0.5, H * 0.04);
  const halfSpan = Math.abs(span) / 2 + extend / rho;

  return { cx, cy, rho, mid, halfSpan, half: halfPx };
}
