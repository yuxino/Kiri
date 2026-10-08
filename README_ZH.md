<div align="center">
  <img src="src-tauri/icons/128x128.png" width="112" alt="Kiri 应用图标">
  <h1>Kiri</h1>
  <p>截图、文字识别和录屏，素材保存在本机。</p>
  <p>
    <a href="https://kiri.yuxino.cn">官网</a>
    · <strong>简体中文</strong>
    · <a href="README.md">English</a>
  </p>
  <p>
    <a href="https://github.com/yuxino/kiri/releases/latest"><img src="https://img.shields.io/github/v/release/yuxino/kiri?style=flat&amp;logo=github&amp;logoColor=white" alt="最新版本"></a>
    <a href="https://github.com/yuxino/kiri/actions/workflows/build.yml?query=branch%3Amain"><img src="https://img.shields.io/github/actions/workflow/status/yuxino/kiri/build.yml?style=flat&amp;logo=githubactions&amp;logoColor=white&amp;branch=main&amp;event=push&amp;label=CI" alt="main 分支 CI 状态"></a>
    <a href="LICENSE"><img src="https://img.shields.io/github/license/yuxino/kiri?style=flat&amp;logo=opensourceinitiative&amp;logoColor=white" alt="MIT 许可证"></a>
  </p>
  <p>
    <a href="https://github.com/yuxino/kiri/releases/latest"><img src="https://img.shields.io/badge/macOS-14%2B-555?style=flat&amp;logo=apple&amp;logoColor=white" alt="macOS 14+"></a>
    <a href="https://github.com/yuxino/kiri/releases/latest"><img src="https://img.shields.io/badge/Windows-x64-0078D4?style=flat&amp;logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI%2BPHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0wIDBoMTF2MTFIMHptMTMgMGgxMXYxMUgxM3pNMCAxM2gxMXYxMUgwem0xMyAwaDExdjExSDEzeiIvPjwvc3ZnPg%3D%3D&amp;logoColor=white" alt="Windows x64"></a>
    <a href="docs/linux.md"><img src="https://img.shields.io/badge/Linux-Ubuntu%2024.04-FCC624?style=flat&amp;logo=linux&amp;logoColor=white" alt="Linux"></a>
  </p>
</div>

<p align="center">Kiri 是一款适用于 macOS、Windows 和 Linux 的截图与录屏工具。截图后可以画箭头、打马赛克、提取文字，图片和视频都保存在本机。</p>

![Kiri 标注界面预览，使用新绘制的插画素材](docs/assets/readme-preview.png)

## 功能

- 截取窗口或区域，裁剪、画图、加文字或马赛克，也能把截图置顶作参考。
- 用本地 OCR 复制图片里的文字，识别二维码。
- 录制 MP4，可选系统声音和麦克风；也可保存为无声 GIF。macOS 转换 GIF 时显示逐帧进度，失败后保留具体原因。
- 裁切、重排同一视频的片段，导出新的 MP4。
- 搜索、打标签、收藏与导出本地素材，误删可从回收站恢复。

## 开始使用

1. 按 `⇧⌘A`（macOS）或 `Shift+Ctrl+A`（Windows / Linux X11），点击窗口或拖出一个区域。
2. 选择截图、录屏或 OCR。
3. 按 `Enter` 确认截图，`Esc` 取消。截图会复制到剪贴板，也会保存在素材库。

开始标注或录屏前，点击滑杆按钮，可在选区边上直接输入宽高，单位为像素。

素材保存在本机。远程 OCR 可选，每次上传前都会询问。Linux 配置、MP4 声音录制、Wayland 快捷键和平台限制见 [Linux 指南](docs/linux.md)。

[使用与常见问题](docs/usage.zh-CN.md) · [视频剪辑](docs/video-editing.zh-CN.md) · [反馈问题](https://github.com/yuxino/kiri/issues) · [贡献指南](CONTRIBUTING.md)

## 贡献者

感谢每一位写代码、提问题、试用和分享的朋友 (๑•̀ㅂ•́)و✧

特别感谢 [@kerwin2046](https://github.com/kerwin2046) 提供 [Linux 初始支持](https://github.com/yuxino/kiri/pull/20)，以及 [@LLLin000](https://github.com/LLLin000) 修复 [Windows 文字缩放下的截图对齐](https://github.com/yuxino/kiri/pull/61)。

[查看所有贡献者](https://github.com/yuxino/kiri/graphs/contributors)

## 社区致谢

也感谢 [V2EX](https://www.v2ex.com/)、[LINUX DO](https://linux.do/)、[小众软件](https://www.appinn.com/)和 [NodeLoc](https://www.nodeloc.com/)社区朋友的试用、反馈与分享。

[MIT](LICENSE) © 2026 yuxino
