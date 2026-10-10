# Kiri verwenden

[简体中文](usage.zh-CN.md) · [English](usage.md) · [繁體中文](usage.zh-TW.md) · [日本語](usage.ja.md) · **Deutsch** · [한국어](usage.ko.md) · [Français](usage.fr.md)

[Zurück zur README](../README_DE.md)

## Installieren und aktualisieren

[Aktuelle Version herunterladen →](https://github.com/yuxino/kiri/releases/latest)

| Plattform | Installation |
| --- | --- |
| macOS 14+ · Apple silicon und Intel | Universal-`.dmg` öffnen und Kiri in „Programme“ ziehen. |
| Windows 11 · x64 | `.exe`-Installer ausführen oder Portable ZIP entpacken und `kiri.exe` starten. |
| Ubuntu 24.04 · x64 · GNOME / X11 | `.deb` herunterladen und `sudo apt install ./kiri_VERSION_amd64.deb` mit dem tatsächlichen Dateinamen ausführen. |

macOS benötigt die Berechtigung für Bildschirm- und Systemaudioaufnahme. Klickmarkierungen benötigen zusätzlich Eingabeüberwachung; Mikrofonaufnahme erfordert macOS 15+. Die App ist nicht von Apple notarisiert. Bei einer Blockierung verwenden Sie Systemeinstellungen → Datenschutz & Sicherheit → Dennoch öffnen. Windows-Pakete sind nicht Authenticode-signiert; SmartScreen kann warnen.

Linux: Wayland-Aufnahme unterstützt einen angeschlossenen Bildschirm. MP4-Aufnahmen können Systemton und Mikrofon über den lokalen PulseAudio- oder PipeWire-Dienst enthalten. Klickmarkierungen sind noch nicht verfügbar. Gespeicherte Videos unterstützen einfache Schnitte und MP4-Export; erweiterte Videoeffekte sind nicht verfügbar. Einrichtung und Aufnahmesteuerung stehen im [Linux-Leitfaden](linux.md).

Updates: macOS und installierte Windows-Versionen verwenden Einstellungen → Über Kiri → Nach Updates suchen. Linux und Windows Portable benötigen ein neues Paket von Releases. Einstellungen und Aufnahmen der Portable-Version bleiben im Windows-Benutzerprofil.

macOS Dock: Einstellungen → Im Dock anzeigen schaltet das Dock-Symbol sofort um und merkt sich die Wahl. Tray und Aufnahme-Tastenkürzel bleiben auch ohne Dock-Symbol verfügbar.

## Sprache

Einstellungen → Allgemein → Sprache bietet English, 简体中文, 繁體中文, 日本語, Deutsch, 한국어 und Français. Ihre Wahl gilt sofort für alle Kiri-Fenster und bleibt nach einem Neustart erhalten. Beim ersten Start wird die Systemsprache verwendet. Die Oberflächensprache ändert keine installierten Linux-OCR-Sprachdaten.

## Aufnehmen

Drücken Sie ⇧⌘A auf macOS oder Shift+Ctrl+A auf Windows / Linux X11 und wählen Sie ein Fenster oder ziehen Sie einen Bereich. Auf Wayland verwenden Sie die Aufnahme-Schaltfläche oder weisen `kiri --capture` in den Desktop-Einstellungen zu. Unterstützte Desktops bieten Einstellungen → Allgemein → Wayland-Desktop-Tastenkürzel für genehmigte Aufnahme-, Pause/Fortsetzen- und Beenden-Tastenkürzel. Ubuntu 24.04 / GNOME 46 behält die Befehlslösung bei.

Wählen Sie Screenshot, Aufnahme oder OCR. Die Screenshot-Leiste bietet auch QR-Erkennung. Enter bestätigt einen Screenshot; Esc bricht ab. Screenshots landen in der Zwischenablage und lokalen Bibliothek. Auf macOS, Windows und X11 lässt sich das Aufnahme-Tastenkürzel in Einstellungen ändern.

Klicken Sie vor der Auswahl eines Zeichenwerkzeugs auf die Schieberegler der Screenshot-Leiste, um Breite und Höhe am Auswahlrand zu bearbeiten. Die Aufnahmeeinstellungen haben dieselbe Schaltfläche. Werte sind Ausgabepixel, auch bei Retina. Enter oder Verlassen eines Feldes übernimmt den Wert. Esc verwirft die Eingabe; ein zweites Esc bricht die Aufnahme ab. Pfeiltasten ändern um ein Pixel, mit Shift um zehn. Ein erneuter Klick verbirgt die Werte. Nach Beginn der Anmerkungen steuern die Schieberegler deren Aussehen.

Wenn sich auf macOS nach der Auswahl die Bildschirmanordnung, Auflösung oder Skalierung ändert, starten Sie vor der Videoaufnahme eine neue Erfassung. Beenden und speichern Sie eine pausierte Aufnahme zuerst.

Beim Schreiben einer Anmerkung macht Ctrl/Cmd+Z Textänderungen rückgängig; Shift+Enter fügt eine Zeile ein. Esc beendet zuerst die Texteingabe; ein zweites Esc bricht die Erfassung ab. Beim Schließen eines bearbeiteten Bildes mit ungespeicherten Änderungen können Sie speichern, verwerfen oder weiter bearbeiten.

Wenn bei der ersten Aufnahme auf GNOME Wayland kein Berechtigungsdialog erscheint, öffnen Sie die Bibliothek und fordern im Fehlerbanner Zugriff an. Erlauben Sie Screenshots im GNOME-Dialog und versuchen Sie die Aufnahme erneut. Kiri verwirft das Berechtigungsbild. Siehe [Linux-Leitfaden](linux.md).

## Screenshot-Anmerkungen

Wählen Sie eine vorhandene Anmerkung aus, um ihren Stil zu ändern. Mosaik bietet Freihand, Rechteck und Ellipse sowie Pixel- und Unschärfeeffekte mit einstellbarer Stärke. Mit Wasserzeichen (W) schreiben Sie direkt ins Bild und wählen Einzel- oder Kacheldarstellung, Deckkraft, Winkel und Abstand. Gespeicherte Wasserzeichen bleiben bearbeitbar.

## GIF-Konvertierung

Beim Konvertieren einer gespeicherten MP4-Datei prüft Kiri zuerst die Video-Dekodierung und beginnt dann mit der GIF-Kodierung. Prüfung und Konvertierung lassen sich abbrechen; mehrere Aufgaben können gemeinsam abgebrochen werden. Das Originalvideo bleibt erhalten. Sobald das abschließende Speichern in der Bibliothek beginnt, ist kein Abbruch mehr möglich.

## Datenschutz

Aufnahmen und Medienverarbeitung bleiben lokal. Remote-OCR ist optional und fragt vor jedem Upload nach. Bearbeitbare Screenshots behalten das Originalbild lokal, einschließlich der durch Anmerkungen verdeckten Pixel. Lesen Sie die [Datenschutzrichtlinie](../PRIVACY.md).

## Weitere Dokumente

[Videobearbeitung](video-editing.de.md) · [Linux](linux.md) · [Dokumentation und QA](README.md) · [Mitwirken](../CONTRIBUTING.md) · [Sicherheit](../SECURITY.md)
