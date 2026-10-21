<div align="center">
  <img src="../../src-tauri/icons/128x128.png" width="112" alt="Kiri">
  <h1>Kiri</h1>
  <p>スクリーンショット、文字認識、画面録画。データはこのコンピューターに保存されます。</p>
  <p>macOS、Windows、Linux に対応。</p>
  <p><a href="https://kiri.yuxino.cn">公式サイト</a> · <a href="https://github.com/yuxino/kiri/releases/latest">最新版をダウンロード</a></p>
  <p><a href="../../README.md">简体中文</a> · <a href="en.md">English</a> · <a href="zh-TW.md">繁體中文</a> · <strong>日本語</strong> · <a href="de.md">Deutsch</a> · <a href="ko.md">한국어</a> · <a href="fr.md">Français</a></p>
  <p>
    <a href="https://github.com/yuxino/kiri/releases/latest"><img src="https://img.shields.io/github/v/release/yuxino/kiri?style=flat&amp;logo=github&amp;logoColor=white" alt="Release"></a>
    <a href="https://github.com/yuxino/kiri/actions/workflows/build.yml?query=branch%3Amain"><img src="https://img.shields.io/github/actions/workflow/status/yuxino/kiri/build.yml?style=flat&amp;logo=githubactions&amp;logoColor=white&amp;branch=main&amp;event=push&amp;label=CI" alt="CI"></a>
    <a href="../../LICENSE"><img src="https://img.shields.io/github/license/yuxino/kiri?style=flat&amp;logo=opensourceinitiative&amp;logoColor=white" alt="MIT"></a>
  </p>
</div>

![Kiri](../assets/readme-preview.png)

## 機能

- ウィンドウや範囲を撮影し、文字、矢印、モザイクを追加。画像を最前面に固定して参照できます。保存後も拡大表示して編集できます。
- 上下に自由にスクロールして長い画像を撮影できます。撮影済みの場所に戻っても重複しません（macOS、Windows、Linux X11）。
- ローカル OCR で画像の文字を抽出し、QR コードを読み取れます。
- システム音声やマイクを含む MP4、または音声なしの GIF を録画できます。
- 一つの動画のクリップを切り取り、並べ替えて新しい MP4 として書き出せます。
- ローカルデータの検索、タグ付け、お気に入り登録、書き出し。誤って削除したデータはゴミ箱から復元できます。
- 設定でキーを押してグローバルショートカットを登録・無効化・初期化できます。録画の操作キーは録画中のみ有効です（[Wayland はデスクトップ側で設定](../linux.md)）。
- 「設定 → 一般」でログイン時の起動を有効にできます。初期設定はオフで、ログイン時はライブラリを開かずにバックグラウンドで起動します。

## はじめに

1. macOS では `⇧⌘A`、Windows / Linux X11 では `Shift+Ctrl+A` で撮影画面を開きます。
2. スクリーンショット、録画、OCR を選び、ウィンドウをクリックするか範囲をドラッグします。
3. スクリーンショットは `Enter` で完了、`Esc` でキャンセル。完了した画像はクリップボードとライブラリに保存されます。

[インストールと使い方](../usage.ja.md) · [動画編集](../video-editing.ja.md) · [Linux](../linux.md) · [問題を報告](https://github.com/yuxino/kiri/issues)

## 謝辞

コードの提供、不具合の報告、試用や共有をしてくださる皆さんに感謝します。

[Linux の初期対応](https://github.com/yuxino/kiri/pull/20)を提供した [@kerwin2046](https://github.com/kerwin2046)、[Windows の文字拡大時の撮影位置](https://github.com/yuxino/kiri/pull/61)を修正した [@LLLin000](https://github.com/LLLin000) に特に感謝します。

フィードバックや共有をしてくださった [V2EX](https://www.v2ex.com/)、[LINUX DO](https://linux.do/)、[Appinn](https://www.appinn.com/)、[NodeLoc](https://www.nodeloc.com/) の皆さんにも感謝します。

[すべての貢献者](https://github.com/yuxino/kiri/graphs/contributors) · [貢献ガイド](../../CONTRIBUTING.md) · [プライバシー](../privacy/en.md) · [MIT](../../LICENSE) © 2026 yuxino
