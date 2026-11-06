# coteve — Unveil Your Smile (베일 닦기 웹 체험)

웹캠 영상 위에 컬러 베일이 덮여 있고, 손날로 화면을 쓸면 손이 지나간 길을 따라 호(arc) 모양으로 베일이 걷혀 선명한 얼굴이 드러나는 웹 체험입니다. 닦을 때마다 지워진 영역이 계속 더해집니다.

- 베일 컬러 4종 선택 (분홍 #FF80A0 / 보라 #AB7EFF / 하늘 #80EAFF / 민트 #8EFFC3)
- '닦이는 크기' 슬라이더로 닦이는 띠 두께 조절
- '처음으로' 버튼으로 홈 화면 복귀 (카메라도 꺼짐)
- '촬영하기' → 3초 카운트다운 → 피드(4:5)/스토리(9:16) 이미지 저장 또는 공유

## 실행 방법
1. 터미널에서 이 폴더로 이동: `cd ~/Desktop/Coteve_Ai`
2. 서버 켜기: `node server.js`
3. Chrome에서 http://localhost:5173 열기 → "체험 시작하기" → 카메라 "허용"
4. 끝낼 때는 터미널에서 `Control + C`

## 테스트 주소
- `http://localhost:5173/?test` : 카메라 없이 레퍼런스 이미지 + 마우스 드래그로 그래픽 확인
- `http://localhost:5173/?mouse` : 카메라 + 마우스 드래그 함께 사용

## 파일 구성
- `index.html`, `styles.css` : 화면과 버튼, 문구
- `js/veil-renderer.js` : 베일 그래픽 (블러·컬러·Inner Glow·호 모양). 맨 위 `LOOK` 값으로 번짐/호 모양 조절
- `js/wipe-controller.js` : 닦기 동작 판단, 손이 지나간 길 기록. 맨 위 `WIPE` 값으로 민감도 조절
- `js/arc.js` : 손이 지나간 길 → 매끈한 호로 변환. 맨 위 `ARC` 값으로 휘는 정도 조절
- `js/capture.js` : 촬영, SNS용 이미지 만들기/저장/공유
- `js/hand-tracker.js` : MediaPipe 손 인식
- `js/app.js` : 전체 흐름
- `server.js` : 내 컴퓨터에서 미리보기용 간단한 서버

## 배포 시 참고
카메라는 보안상 `https://` 주소(또는 localhost)에서만 작동합니다. 정적 파일만으로 구성되어 있어 Vercel, Netlify, GitHub Pages 등에 그대로 올릴 수 있습니다. (`server.js`는 배포에 필요 없음)
