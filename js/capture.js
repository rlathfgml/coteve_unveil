// =============================================================
// 촬영 → 이미지 저장
//  - 화면에 보이는 그대로(영상 + 베일), 웹 화면과 같은 비율로 저장
//  - 로고·문구·버튼 등은 들어가지 않음
//  - 영상: 화면을 그대로 녹화 (가능하면 SNS에 바로 올리기 좋은 MP4, 안 되면 WebM)
// =============================================================

/** 이 브라우저에서 녹화할 수 있는 형식 고르기 */
function pickVideoType() {
  const types = [
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  return types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
}

export function canRecord() {
  return !!(window.MediaRecorder && HTMLCanvasElement.prototype.captureStream && pickVideoType());
}

/** 화면 녹화 시작 → { stop(): Promise<Blob> } */
export function startRecording(canvas) {
  const type = pickVideoType();
  const stream = canvas.captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.start(250);
  return {
    stop: () => new Promise((resolve) => {
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        resolve(new Blob(chunks, { type: type.split(';')[0] || 'video/webm' }));
      };
      if (rec.state !== 'inactive') rec.stop(); else rec.onstop();
    }),
  };
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
const extOf = (blob) => (blob.type.includes('mp4') ? 'mp4' : blob.type.includes('webm') ? 'webm' : 'png');

/** 파일(Blob) 내려받기 */
export function downloadBlob(blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `coteve_unveil_${stamp()}.${extOf(blob)}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** 파일(Blob)을 기기의 공유 기능으로 보내기 */
export async function shareBlob(blob) {
  const file = new File([blob], `coteve_unveil.${extOf(blob)}`, { type: blob.type });
  await navigator.share({ files: [file] });
}

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
