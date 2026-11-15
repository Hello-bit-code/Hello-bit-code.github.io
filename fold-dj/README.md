# FOLD//MIX PRO v3 — 갤럭시 폴더블 DJ 웹 콘솔

- 두 데크에 각자의 로컬 음악 파일 불러오기 또는 DEMO 사용
- 조그휠 VINYL 모드 터치 스크래치 (AudioWorklet 기반 실험적 재생, 실제 하드웨어급 응답성 보장 불가)
- 8개 패드: HOT CUE / SAMPLER / BEAT ROLL / BEAT JUMP
- 각 데크 독립 FX: ECHO / DUB ECHO / DELAY / REVERB / FLANGER / PHASER
- 각 채널 TRIM, HI, MID, LOW, COLOR 5개 노브를 2열로 배치
- 모바일 A / MIXER / B 전환 화면, 고정 크로스페이더, 멀티 포인터 이벤트
- 4단계 조그/크로스페이더 연습: Baby / Forward / Transformer / Chirp
- BPM 추정 / 수동 TAP / BEAT SYNC, 믹스 녹음(WebM)

## 사용
HTTPS로 제공되는 `index.html`을 열거나 로컬 웹서버에서 실행합니다.
Chrome / Edge 계열 브라우저를 권장합니다.
각 데크의 `음원 선택`에서 음악을 고르면 음악은 서버에 업로드되지 않습니다.
DEMO로 샘플 비트를 재생하고 `스크래치 배우기`를 눌러 연습할 수 있습니다.

## 검증과 제한
JavaScript 구문 검사와 HTML 참조 정적 검사를 통과했습니다.
실제 갤럭시 기기/브라우저에서 멀티터치·스크래치 음향 테스트는 수행하지 못했습니다.
스크래치 오디오 엔진은 시험용 구현이며 출력 지연은 기기 성능·브라우저에 영향을 받습니다.
BPM 분석은 추정이고 절반/두 배 템포로 잘못 인식할 수 있어 TAP/수동 보정이 필요합니다.
YouTube Music 등 다른 앱 스트리밍 음원을 직접 수집하거나 믹싱하지 않습니다.
Pioneer DJ 장비의 외형과 조작 방식을 참고한 독립 제작 화면입니다.
