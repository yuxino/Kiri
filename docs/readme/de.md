<div align="center">
  <img src="../../src-tauri/icons/128x128.png" width="112" alt="Kiri">
  <h1>Kiri</h1>
  <p>Screenshots, Texterkennung und Bildschirmaufnahmen. Ihre Aufnahmen bleiben lokal.</p>
  <p>Für macOS, Windows und Linux.</p>
  <p><a href="https://kiri.yuxino.cn">Website</a> · <a href="https://github.com/yuxino/kiri/releases/latest">Aktuelle Version herunterladen</a></p>
  <p><a href="../../README.md">简体中文</a> · <a href="en.md">English</a> · <a href="zh-TW.md">繁體中文</a> · <a href="ja.md">日本語</a> · <strong>Deutsch</strong> · <a href="ko.md">한국어</a> · <a href="fr.md">Français</a> · <a href="ru.md">Русский</a></p>
  <p>
    <a href="https://github.com/yuxino/kiri/releases/latest"><img src="https://img.shields.io/github/v/release/yuxino/kiri?style=flat&amp;logo=github&amp;logoColor=white" alt="Release"></a>
    <a href="https://github.com/yuxino/kiri/releases"><img src="https://img.shields.io/github/downloads/yuxino/kiri/total?style=flat&amp;labelColor=665478&amp;color=8b8196" alt="Downloads gesamt"></a>
    <a href="https://github.com/yuxino/kiri/actions/workflows/build.yml?query=branch%3Amain"><img src="https://img.shields.io/github/actions/workflow/status/yuxino/kiri/build.yml?style=flat&amp;logo=githubactions&amp;logoColor=white&amp;branch=main&amp;event=push&amp;label=CI" alt="CI"></a>
    <a href="../../LICENSE"><img src="https://img.shields.io/github/license/yuxino/kiri?style=flat&amp;logo=opensourceinitiative&amp;logoColor=white" alt="MIT"></a>
  </p>
  <p>
    <a href="https://github.com/yuxino/kiri/releases/latest"><img src="https://img.shields.io/badge/macOS-14%2B-555?style=flat&amp;logo=apple&amp;logoColor=white" alt="macOS 14+"></a>
    <a href="https://github.com/yuxino/kiri/releases/latest"><img src="https://img.shields.io/badge/Windows-x64-0078D4?style=flat&amp;logo=data%3Aimage%2Fsvg%2Bxml%3Bbase64%2CPHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI%2BPHBhdGggZmlsbD0id2hpdGUiIGQ9Ik0wIDBoMTF2MTFIMHptMTMgMGgxMXYxMUgxM3pNMCAxM2gxMXYxMUgwem0xMyAwaDExdjExSDEzeiIvPjwvc3ZnPg%3D%3D&amp;logoColor=white" alt="Windows x64"></a>
    <a href="https://github.com/yuxino/kiri/releases/latest"><img src="https://img.shields.io/badge/Linux-x86__64-FCC624?style=flat&amp;logo=linux&amp;logoColor=white" alt="Linux x86_64"></a>
  </p>
</div>

![Kiri](../assets/readme-preview.png)

## Funktionen

- Fenster oder Bereiche aufnehmen, Text, Pfeile und Mosaik hinzufügen und Screenshots als schwebende Referenzen anheften. Nach dem Speichern vergrößern und weiterbearbeiten.
- Nach oben oder unten scrollen und einen langen Screenshot erstellen; bereits erfasste Bereiche werden nicht doppelt hinzugefügt (macOS, Windows, Linux X11).
- Text mit integriertem Offline-OCR aus Bildern kopieren, den Textverlauf nutzen, optional Text in neuen Screenshots suchen und QR-Codes lesen.
- MP4 mit optionalem Systemton und Mikrofon aufnehmen oder als GIF ohne Ton speichern.
- Clips eines Videos kürzen und umordnen, dann eine neue MP4-Datei exportieren.
- Lokale Aufnahmen suchen, mit Tags versehen, favorisieren und exportieren; versehentlich Gelöschtes aus dem Papierkorb wiederherstellen.
- Globale Tastenkürzel direkt in den Einstellungen festlegen, deaktivieren oder zurücksetzen; Aufnahmesteuerungen gelten nur während einer Aufnahme ([Wayland nutzt Desktop-Einstellungen](../linux.md)).
- Unter Einstellungen → Allgemein lässt sich der Start bei der Anmeldung aktivieren. Er ist standardmäßig aus und startet Kiri im Hintergrund, ohne die Bibliothek zu öffnen.

## Erste Schritte

1. Drücken Sie `⇧⌘A` auf macOS oder `Shift+Ctrl+A` auf Windows / Linux X11, um die Aufnahme zu öffnen.
2. Wählen Sie Screenshot, Aufnahme oder OCR, dann ein Fenster oder einen aufgezogenen Bereich.
3. Bestätigen Sie Screenshots mit `Enter`; `Esc` bricht ab. Fertige Screenshots landen in der Zwischenablage und Bibliothek.

[Installation und Hilfe](../usage.de.md) · [Videobearbeitung](../video-editing.de.md) · [Linux](../linux.md) · [Fehler melden](https://github.com/yuxino/kiri/issues)

## Danke

Vielen Dank an alle, die Code schreiben, Probleme melden, Kiri ausprobieren oder teilen.

Besonderer Dank gilt [@kerwin2046](https://github.com/kerwin2046) für die [erste Linux-Unterstützung](https://github.com/yuxino/kiri/pull/20), [@LLLin000](https://github.com/LLLin000) für die [Korrektur der Screenshot-Ausrichtung bei Windows-Textskalierung](https://github.com/yuxino/kiri/pull/61) und [@AlexZander85](https://github.com/AlexZander85) für die [russische Übersetzung der Oberfläche](https://github.com/yuxino/kiri/pull/204).

Danke auch an die Communitys von [V2EX](https://www.v2ex.com/), [LINUX DO](https://linux.do/), [Appinn](https://www.appinn.com/), [NodeLoc](https://www.nodeloc.com/) für Rückmeldungen und Weiterempfehlungen.

[Alle Mitwirkenden](https://github.com/yuxino/kiri/graphs/contributors) · [Mitwirken](../../CONTRIBUTING.md) · [Datenschutz](../privacy/en.md) · [MIT](../../LICENSE) © 2026 yuxino
