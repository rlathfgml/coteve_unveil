// =============================================================
// 촬영 → SNS용 이미지 만들기
//  - 피드: 1080 × 1350 (4:5) / 스토리: 1080 × 1920 (9:16)
//  - 화면(영상 + 베일)을 가운데 기준으로 꽉 차게 자르고, 아래에 로고·문구를 얹음
// =============================================================

export const FORMATS = {
  feed: { w: 1080, h: 1350, label: '피드 4:5' },
  story: { w: 1080, h: 1920, label: '스토리 9:16' },
};

let logoPromise = null;
// Logo.svg 는 크기 정보가 없어서, 크기를 넣은 뒤 이미지로 불러와요
function loadLogo() {
  if (!logoPromise) {
    logoPromise = fetch('Logo.svg')
      .then((r) => r.text())
      .then((txt) => {
        const sized = txt.replace('<svg ', '<svg width="1366" height="255" ');
        const url = URL.createObjectURL(new Blob([sized], { type: 'image/svg+xml' }));
        const img = new Image();
        img.src = url;
        return img.decode().then(() => img);
      })
      .catch(() => null);
  }
  return logoPromise;
}
loadLogo();

/** 지금 화면을 복사해 둠 (WebGL 캔버스 → 일반 캔버스) */
export function snapshot(canvas) {
  const c = document.createElement('canvas');
  c.width = canvas.width;
  c.height = canvas.height;
  c.getContext('2d').drawImage(canvas, 0, 0);
  return c;
}

/** 복사해 둔 화면으로 SNS용 이미지를 만듦 */
export async function compose(shot, formatKey, accentDeep) {
  const { w, h } = FORMATS[formatKey];
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');

  // 화면을 꽉 차게(가운데 기준) 배치
  const s = Math.max(w / shot.width, h / shot.height);
  const dw = shot.width * s, dh = shot.height * s;
  ctx.drawImage(shot, (w - dw) / 2, (h - dh) / 2, dw, dh);

  // 아래쪽을 살짝 어둡게 해서 로고가 잘 보이게
  const g = ctx.createLinearGradient(0, h * 0.72, 0, h);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, accentDeep.replace('rgb(', 'rgba(').replace(')', ',0.45)'));
  ctx.fillStyle = g;
  ctx.fillRect(0, h * 0.72, w, h * 0.28);

  // 문구
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.shadowColor = 'rgba(0,0,0,0.18)';
  ctx.shadowBlur = 18;
  ctx.font = `800 ${Math.round(w * 0.052)}px Pretendard, -apple-system, sans-serif`;
  const logo = await loadLogo();
  const logoW = w * 0.3;
  const logoH = logo ? logoW * (255 / 1366) : 0;
  const bottom = h - h * 0.05;
  ctx.fillText('Reveal Your Smile.', w / 2, bottom - logoH - w * 0.035);

  // 로고
  if (logo) ctx.drawImage(logo, (w - logoW) / 2, bottom - logoH, logoW, logoH);
  ctx.shadowBlur = 0;
  return out;
}

export function toBlob(canvas) {
  return new Promise((res) => canvas.toBlob(res, 'image/png'));
}

/** 이미지 파일로 내려받기 */
export async function download(canvas, formatKey) {
  const blob = await toBlob(canvas);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  a.href = url;
  a.download = `coteve_unveil_${formatKey}_${stamp}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** 기기의 공유 기능으로 바로 보내기 (지원하는 브라우저만) */
export async function share(canvas) {
  const blob = await toBlob(canvas);
  const file = new File([blob], 'coteve_unveil.png', { type: 'image/png' });
  await navigator.share({ files: [file], title: 'coteve — Reveal Your Smile.' });
}

export function canShareFiles() {
  try {
    const f = new File([new Blob()], 'x.png', { type: 'image/png' });
    return !!navigator.canShare && navigator.canShare({ files: [f] });
  } catch { return false; }
}
