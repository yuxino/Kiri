<div align="center">
  <img src="../../src-tauri/icons/128x128.png" width="112" alt="Kiri">
  <h1>Kiri</h1>
  <p>截圖、文字辨識與螢幕錄影，素材儲存在本機。</p>
  <p>支援 macOS、Windows 和 Linux。</p>
  <p><a href="https://kiri.yuxino.cn">官網</a> · <a href="https://github.com/yuxino/kiri/releases/latest">下載最新版本</a></p>
  <p><a href="../../README.md">简体中文</a> · <a href="en.md">English</a> · <strong>繁體中文</strong> · <a href="ja.md">日本語</a> · <a href="de.md">Deutsch</a> · <a href="ko.md">한국어</a> · <a href="fr.md">Français</a></p>
  <p>
    <a href="https://github.com/yuxino/kiri/releases/latest"><img src="https://img.shields.io/github/v/release/yuxino/kiri?style=flat&amp;logo=github&amp;logoColor=white" alt="Release"></a>
    <a href="https://github.com/yuxino/kiri/actions/workflows/build.yml?query=branch%3Amain"><img src="https://img.shields.io/github/actions/workflow/status/yuxino/kiri/build.yml?style=flat&amp;logo=githubactions&amp;logoColor=white&amp;branch=main&amp;event=push&amp;label=CI" alt="CI"></a>
    <a href="../../LICENSE"><img src="https://img.shields.io/github/license/yuxino/kiri?style=flat&amp;logo=opensourceinitiative&amp;logoColor=white" alt="MIT"></a>
  </p>
</div>

![Kiri](../assets/readme-preview.png)

## 功能

- 擷取視窗或區域，加入文字、箭頭與馬賽克，也能將截圖置頂作為參考。儲存後可放大檢視並繼續編輯。
- 上下自由捲動並拼成長截圖，返回已擷取內容不會重複拼接（macOS、Windows、Linux X11）。
- 使用本機 OCR 擷取圖片中的文字，辨識 QR Code。
- 錄製 MP4，可選系統音訊與麥克風；也能儲存為無聲 GIF。
- 裁切、重新排列同一部影片的片段，再匯出新的 MP4。
- 搜尋、加標籤、加入收藏與匯出本機素材，誤刪可從垃圾桶還原。
- 在設定中直接錄入、停用或還原全域快捷鍵；錄影控制按鍵僅在錄影時生效（[Wayland 由桌面管理](../linux.md)）。

## 開始使用

1. 按 `⇧⌘A`（macOS）或 `Shift+Ctrl+A`（Windows / Linux X11）開啟擷取面板。
2. 選擇截圖、錄影或 OCR，點選視窗或拖曳選取區域。
3. 截圖按 `Enter` 完成，`Esc` 取消；完成後會複製到剪貼簿並儲存至素材庫。

[安裝與使用說明](../usage.zh-TW.md) · [影片剪輯](../video-editing.zh-TW.md) · [Linux](../linux.md) · [回報問題](https://github.com/yuxino/kiri/issues)

## 感謝

感謝每一位寫程式、回報問題、試用與分享的朋友。

特別感謝 [@kerwin2046](https://github.com/kerwin2046) 提供 [Linux 初始支援](https://github.com/yuxino/kiri/pull/20)，以及 [@LLLin000](https://github.com/LLLin000) 修復 [Windows 文字縮放下的截圖對齊](https://github.com/yuxino/kiri/pull/61)。

也感謝 [V2EX](https://www.v2ex.com/)、[LINUX DO](https://linux.do/)、[Appinn](https://www.appinn.com/)、[NodeLoc](https://www.nodeloc.com/) 社群朋友的回饋與分享。

[所有貢獻者](https://github.com/yuxino/kiri/graphs/contributors) · [貢獻指南](../../CONTRIBUTING.md) · [隱私政策](../privacy/en.md) · [MIT](../../LICENSE) © 2026 yuxino
