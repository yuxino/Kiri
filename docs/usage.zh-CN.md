# Kiri 使用说明

[返回 README](../README_ZH.md) · [English](usage.md)

## 安装与更新

[下载最新版本 →](https://github.com/yuxino/kiri/releases/latest)

| 平台 | 安装方式 |
| --- | --- |
| macOS 14+ · Apple 芯片与 Intel | 打开 Universal `.dmg`，将 Kiri 拖入“应用程序”。 |
| Windows 11 · x64 | 运行 `.exe` 安装包，或解压 Portable ZIP 后运行 `kiri.exe`。 |
| Ubuntu 24.04 · x64 · GNOME / X11 | 下载 `.deb`，执行 `sudo apt install ./kiri_VERSION_amd64.deb`，文件名替换为实际下载的版本。 |

macOS 需要“屏幕与系统音频录制”权限；点击高亮还需要“输入监控”，麦克风录制需要 macOS 15+。应用未经过 Apple 公证，若被拦截，请在“系统设置 → 隐私与安全性 → 仍要打开”中放行。Windows 安装包未经过 Authenticode 签名，SmartScreen 可能提示警告。

Linux：Wayland 捕获支持连接一台显示器；MP4 录屏可通过本地 PulseAudio 或 PipeWire 音频服务录制系统声音和麦克风，暂不支持点击高亮；已保存的视频支持基础剪辑与 MP4 导出，暂不支持高级视频特效。配置与录屏控制方式见 [Linux 指南](linux.md)。

更新：macOS 与 Windows 安装版使用“设置 → 关于 → 检查更新”；Linux 与 Windows 绿色版从 Releases 下载新版安装包。绿色版的设置和素材仍保存在 Windows 用户目录中。

macOS Dock：设置中的「在 Dock 中显示」会立即切换图标显示，并记住选择；隐藏后仍可使用菜单栏和截图快捷键。

## 截图与录屏

按 ⇧⌘A（macOS）或 Shift+Ctrl+A（Windows / Linux X11），点击窗口或拖出一个区域。Wayland 使用“截图”按钮，或在桌面设置中绑定 `kiri --capture`。支持该接口的桌面还可以通过设置 → 通用 → Wayland 桌面快捷键，由桌面授权并分配截图、暂停/继续和停止的按键。Ubuntu 24.04 / GNOME 46 仍使用命令快捷键。

选择截图、录屏或 OCR。截图工具栏也提供「识别二维码」。Enter 确认截图，Esc 取消捕获。截图会复制到剪贴板并保存在本地素材库。macOS、Windows 和 X11 可在设置中修改截图快捷键。

选择标注工具前，点击截图工具栏的滑杆按钮，选区边上会显示可编辑的宽高标签；录屏设置中也有同样的按钮。数值以输出像素为单位，Retina 屏幕也一样。Enter 或离开输入框应用尺寸；Esc 放弃当前输入，再按一次取消捕获。上下方向键每次调整一个像素，配合 Shift 调整十个。再次点击滑杆可收起标签。开始标注后，滑杆按钮仍用于展开样式控件。

macOS 上，选区后若更改显示器布局、分辨率或缩放，请重新截图选择区域，再开始录制；若录屏已暂停，请先停止并保存。

输入标注文字时，Ctrl/Cmd+Z 撤销文字，Shift+Enter 换行。Esc 先退出本次文字编辑，再按一次取消捕获。关闭已保存图片的编辑器时，如有未保存修改，会询问保存、放弃或继续编辑。

在 GNOME Wayland 上，如果首次截图没有出现授权窗口，请打开 Kiri 素材库，在错误提示中点击请求授权。在 GNOME 弹窗中允许截图，然后重新发起截图；授权时产生的图片不会进入 Kiri。详见 [Linux 指南](linux.md)。

## 隐私

素材与媒体处理都留在本机。远程 OCR 可选，每次上传前都会询问。可编辑截图会在本地保留源图，其中仍可能包含被标注遮住的内容。详见[隐私说明](../PRIVACY_ZH.md)。

## 更多文档

[视频剪辑](video-editing.zh-CN.md) · [Linux](linux.md) · [文档索引与 QA](README.md) · [贡献指南](../CONTRIBUTING.md) · [安全策略](../SECURITY.md)
