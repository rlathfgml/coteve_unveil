// =============================================================
// 촬영 → 이미지 저장
//  - 화면에 보이는 그대로(영상 + 베일), 웹 화면과 같은 비율로 저장
//  - 로고·문구·버튼 등은 들어가지 않음
// =============================================================

/** 지금 화면을 복사해 둠 (WebGL 캔버스 → 일반 캔버스, 화면과 같은 크기·비율) */
export function snapshot(canvas) {
  const c = document.createElement('canvas');
  c.width = canvas.width;
  c.height = canvas.height;
  c.getContext('2d').drawImage(canvas, 0, 0);
  return c;
}

export function toBlob(canvas) {
  return new Promise((res) => canvas.toBlob(res, 'image/png'));
}

/** 이미지 파일로 내려받기 */
export async function download(canvas) {
  const blob = await toBlob(canvas);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
  a.href = url;
  a.download = `coteve_unveil_${stamp}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** 기기의 공유 기능으로 바로 보내기 (지원하는 브라우저만) */
export async function share(canvas) {
  const blob = await toBlob(canvas);
  const file = new File([blob], 'coteve_unveil.png', { type: 'image/png' });
  await navigator.share({ files: [file] });
}

export function canShareFiles() {
  try {
    const f = new File([new Blob()], 'x.png', { type: 'image/png' });
    return !!navigator.canShare && navigator.canShare({ files: [f] });
  } catch { return false; }
}
