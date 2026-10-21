<div align="center">
  <img src="../../src-tauri/icons/128x128.png" width="112" alt="Kiri">
  <h1>Kiri</h1>
  <p>스크린샷, 문자 인식, 화면 녹화. 캡처한 자료는 컴퓨터에 저장됩니다.</p>
  <p>macOS, Windows, Linux를 지원합니다.</p>
  <p><a href="https://kiri.yuxino.cn">공식 웹사이트</a> · <a href="https://github.com/yuxino/kiri/releases/latest">최신 버전 다운로드</a></p>
  <p><a href="../../README.md">简体中文</a> · <a href="en.md">English</a> · <a href="zh-TW.md">繁體中文</a> · <a href="ja.md">日本語</a> · <a href="de.md">Deutsch</a> · <strong>한국어</strong> · <a href="fr.md">Français</a></p>
  <p>
    <a href="https://github.com/yuxino/kiri/releases/latest"><img src="https://img.shields.io/github/v/release/yuxino/kiri?style=flat&amp;logo=github&amp;logoColor=white" alt="Release"></a>
    <a href="https://github.com/yuxino/kiri/actions/workflows/build.yml?query=branch%3Amain"><img src="https://img.shields.io/github/actions/workflow/status/yuxino/kiri/build.yml?style=flat&amp;logo=githubactions&amp;logoColor=white&amp;branch=main&amp;event=push&amp;label=CI" alt="CI"></a>
    <a href="../../LICENSE"><img src="https://img.shields.io/github/license/yuxino/kiri?style=flat&amp;logo=opensourceinitiative&amp;logoColor=white" alt="MIT"></a>
  </p>
</div>

![Kiri](../assets/readme-preview.png)

## 기능

- 창이나 영역을 캡처하고 텍스트, 화살표, 모자이크를 추가합니다. 스크린샷을 떠 있는 참고 이미지로 고정할 수 있습니다. 저장 후에도 확대하여 확인하고 계속 편집할 수 있습니다.
- 위아래로 자유롭게 스크롤해 긴 스크린샷을 만듭니다. 이미 캡처한 곳으로 돌아가도 중복으로 추가되지 않습니다(macOS, Windows, Linux X11).
- 로컬 OCR로 이미지 속 문자를 추출하고 QR 코드를 읽습니다.
- 시스템 소리와 마이크를 선택하여 MP4로 녹화하거나 소리 없는 GIF로 저장합니다.
- 한 동영상의 클립을 자르고 순서를 바꾼 뒤 새 MP4로 내보냅니다.
- 로컬 자료를 검색하고 태그와 즐겨찾기를 지정하거나 내보냅니다. 잘못 삭제한 자료는 휴지통에서 복원할 수 있습니다.
- 설정에서 키를 눌러 전역 단축키를 지정하거나 해제하고 기본값으로 복원합니다. 녹화 제어 키는 녹화 중에만 작동합니다([Wayland는 데스크톱에서 설정](../linux.md)).
- 설정 → 일반에서 로그인 시 시작을 직접 켤 수 있습니다. 기본값은 꺼짐이며, 로그인할 때 라이브러리를 열지 않고 백그라운드에서 시작합니다.

## 시작하기

1. macOS에서 `⇧⌘A`, Windows / Linux X11에서 `Shift+Ctrl+A`를 눌러 캡처 화면을 엽니다.
2. 스크린샷, 녹화 또는 OCR을 선택한 뒤 창을 클릭하거나 영역을 드래그합니다.
3. 스크린샷은 `Enter`로 완료하고 `Esc`로 취소합니다. 완료한 이미지는 클립보드에 복사되고 라이브러리에 저장됩니다.

[설치 및 사용 안내](../usage.ko.md) · [동영상 편집](../video-editing.ko.md) · [Linux](../linux.md) · [문제 신고](https://github.com/yuxino/kiri/issues)

## 감사합니다

코드를 작성하고, 문제를 신고하고, Kiri를 사용하거나 공유해 주신 모든 분께 감사합니다.

[초기 Linux 지원](https://github.com/yuxino/kiri/pull/20)을 제공한 [@kerwin2046](https://github.com/kerwin2046)와 [Windows 텍스트 배율에 따른 캡처 정렬](https://github.com/yuxino/kiri/pull/61)을 수정한 [@LLLin000](https://github.com/LLLin000)에게 특별히 감사드립니다.

의견을 주고 공유해 주신 [V2EX](https://www.v2ex.com/) · [LINUX DO](https://linux.do/) · [Appinn](https://www.appinn.com/) · [NodeLoc](https://www.nodeloc.com/) 커뮤니티 여러분께도 감사합니다.

[모든 기여자](https://github.com/yuxino/kiri/graphs/contributors) · [기여 안내](../../CONTRIBUTING.md) · [개인정보 처리방침](../privacy/en.md) · [MIT](../../LICENSE) © 2026 yuxino
