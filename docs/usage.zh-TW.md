# 使用 Kiri

[简体中文](usage.zh-CN.md) · [English](usage.md) · **繁體中文** · [日本語](usage.ja.md) · [Deutsch](usage.de.md) · [한국어](usage.ko.md) · [Français](usage.fr.md)

[返回 README](../README_ZH_TW.md)

## 安裝與更新

[下載最新版本 →](https://github.com/yuxino/kiri/releases/latest)

| 平台 | 安裝方式 |
| --- | --- |
| macOS 14+ · Apple 晶片與 Intel | 開啟 Universal `.dmg`，將 Kiri 拖到「應用程式」。 |
| Windows 11 · x64 | 執行 `.exe` 安裝程式，或解壓縮 Portable ZIP 後執行 `kiri.exe`。 |
| Ubuntu 24.04 · x64 · GNOME / X11 | 下載 `.deb`，將實際檔名代入 `sudo apt install ./kiri_VERSION_amd64.deb`。 |

macOS 需要「螢幕與系統音訊錄製」權限；點擊提示還需要「輸入監控」，麥克風錄音需要 macOS 15+。應用程式尚未經 Apple 公證：若受到阻擋，請到「系統設定 → 隱私權與安全性 → 強制打開」。Windows 套件沒有 Authenticode 簽章，SmartScreen 可能顯示警告。

Linux：Wayland 擷取目前支援一台已連接的螢幕。MP4 錄影可透過本機 PulseAudio 或 PipeWire 音訊服務加入系統音訊與麥克風。尚不支援點擊提示。已儲存影片可做基本剪輯並匯出 MP4，進階影片效果尚不支援。設定與錄影控制見 [Linux 指南](linux.md)。

更新：macOS 與 Windows 安裝版使用「設定 → 關於 → 檢查更新」。Linux 與 Windows Portable 使用者請從 Releases 下載新套件。Portable 的設定與素材仍保存在 Windows 使用者設定檔內。

macOS Dock：「設定 → 在 Dock 中顯示」可立即切換 Dock 圖示並記住選擇。隱藏後仍可使用選單列圖示與截圖快速鍵。

## 語言

在「設定 → 一般 → 語言」選擇 English、简体中文、繁體中文、日本語、Deutsch、한국어 或 Français。選擇會立即套用到所有 Kiri 視窗，重啟後仍會保留；首次啟動時跟隨系統語言。介面語言不會變更 Linux OCR 已安裝的語言資料。

## 擷取

在 macOS 按 ⇧⌘A，Windows / Linux X11 按 Shift+Ctrl+A，再選取視窗或拖曳區域。Wayland 可使用「截圖」按鈕，或在桌面設定將 `kiri --capture` 綁定到快速鍵。支援的桌面也提供「設定 → 一般 → Wayland 桌面快速鍵」，讓桌面授權截圖、暫停/繼續與停止操作。Ubuntu 24.04 / GNOME 46 保留指令方式。

選擇截圖、錄影或 OCR。截圖工具列也提供 QR Code 辨識。Enter 完成截圖，Esc 取消擷取。截圖會複製至剪貼簿並儲存到本機素材庫。macOS、Windows 與 X11 可在設定中更改截圖快速鍵。

選擇標註工具前，點選截圖工具列的滑桿按鈕，選取區域邊緣會顯示可編輯的寬度與高度；錄影設定也提供相同按鈕。數值為輸出像素，包含 Retina 螢幕。Enter 或離開輸入欄位套用數值；Esc 放棄目前輸入，再按一次 Esc 取消擷取。方向鍵調整一個像素，配合 Shift 調整十個。再點一次滑桿隱藏數值；開始標註後，滑桿用於外觀設定。

在 macOS 上，選取區域後若變更螢幕排列、解析度或縮放，請重新擷取再錄影。若錄影已暫停，請先停止並儲存。

輸入標註文字時，Ctrl/Cmd+Z 復原文字，Shift+Enter 換行。Esc 先結束文字編輯，再按一次才取消擷取。關閉已編輯的圖片時，若尚有未儲存變更，會提供儲存、捨棄或繼續編輯。

GNOME Wayland 首次擷取若沒有顯示權限對話框，請開啟素材庫，在錯誤橫幅中選擇「請求存取權限」，於 GNOME 對話框允許截圖後重試。Kiri 會捨棄用來授權的圖片。詳見 [Linux 指南](linux.md)。

## 截圖標註

選取既有標註即可修改樣式。馬賽克支援自由畫筆、矩形和橢圓，可選像素或模糊效果並調整強度。點擊浮水印（W）後直接在圖片中輸入文字，可選單處或平鋪，調整不透明度、角度和間距；儲存後仍可再次編輯。

## GIF 轉換

在素材庫中將 MP4 轉成 GIF 時，Kiri 會先檢查影片能否解碼，再開始編碼。檢查或轉換時可按「取消」；多個工作可按「全部取消」。取消會保留原始影片，最後儲存到素材庫的階段不能取消。

## 隱私

素材與媒體處理留在本機。遠端 OCR 可選，每次上傳前都會詢問。可編輯截圖會在本機保留原始圖片，包含被標註遮住的像素。請閱讀 [隱私政策](../PRIVACY.md)。

## 更多文件

[影片剪輯](video-editing.zh-TW.md) · [Linux](linux.md) · [文件與驗證](README.md) · [貢獻指南](../CONTRIBUTING.md) · [安全性](../SECURITY.md)
