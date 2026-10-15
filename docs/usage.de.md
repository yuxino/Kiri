# Kiri verwenden

[简体中文](usage.zh-CN.md) · [English](usage.md) · [繁體中文](usage.zh-TW.md) · [日本語](usage.ja.md) · **Deutsch** · [한국어](usage.ko.md) · [Français](usage.fr.md)

[Zurück zur README](readme/de.md)

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

Klicken Sie vor der Auswahl eines Zeichenwerkzeugs auf die Schieberegler der Screenshot-Leiste, um Breite und Höhe am Auswahlrand zu bearbeiten. Werte sind Ausgabepixel, auch bei Retina. Enter oder Verlassen eines Feldes übernimmt den Wert. Esc verwirft die Eingabe; ein zweites Esc bricht die Aufnahme ab. Pfeiltasten ändern um ein Pixel, mit Shift um zehn. Ein erneuter Klick verbirgt die Werte. Nach Beginn der Anmerkungen steuern die Schieberegler deren Aussehen.

Wenn sich auf macOS nach der Auswahl die Bildschirmanordnung, Auflösung oder Skalierung ändert, starten Sie vor der Videoaufnahme eine neue Erfassung. Beenden und speichern Sie eine pausierte Aufnahme zuerst.

Beim Schreiben einer Anmerkung macht Ctrl/Cmd+Z Textänderungen rückgängig; Shift+Enter fügt eine Zeile ein. Esc beendet zuerst die Texteingabe; ein zweites Esc bricht die Erfassung ab. Beim Schließen eines bearbeiteten Bildes mit ungespeicherten Änderungen können Sie speichern, verwerfen oder weiter bearbeiten.

Wenn bei der ersten Aufnahme auf GNOME Wayland kein Berechtigungsdialog erscheint, öffnen Sie die Bibliothek und fordern im Fehlerbanner Zugriff an. Erlauben Sie Screenshots im GNOME-Dialog und versuchen Sie die Aufnahme erneut. Kiri verwirft das Berechtigungsbild. Siehe [Linux-Leitfaden](linux.md).

Die Aufnahmevorbereitung bietet MP4 / GIF, Start und vier nebeneinanderliegende Symbole: Systemton, Mikrofon, Mauszeiger und Klickmarkierungen. Start löst immer einen Countdown von drei Sekunden aus; GIF-Aufnahmen sind ohne Ton. Das Panel passt sich an Auswahl und Bildschirmränder an.

Der kleine Pfeil neben dem Mikrofon öffnet die Auswahl der verfügbaren Eingabegeräte, ohne das Standardgerät des Systems zu ändern. Ist das gewählte Gerät nicht verfügbar oder wird es getrennt, meldet Kiri einen Fehler, statt unbemerkt zu einem anderen Mikrofon zu wechseln.

## Scroll-Screenshots

Wähle unter macOS, Windows oder Linux X11 einen Screenshot-Bereich und vor dem Hinzufügen von Anmerkungen **Scroll-Screenshot**. Markiere nur den vertikal scrollenden Inhalt, ohne feste Kopf-, Fuß- und Seitenleisten. Lass neben der Auswahl Platz für die Vorschau. Passt das Fenster nicht außerhalb der Auswahl, verkleinere den Bereich. Unter Wayland ist diese Funktion derzeit nicht verfügbar.

Scrolle in der ursprünglichen Anwendung langsam nach unten. Die seitliche Vorschau zeigt die übernommenen Bildteile. Hält der Abgleich an, scrolle etwas in den bereits erfassten Inhalt zurück und anschließend weiter nach unten. Wiederholte Inhalte, Animationen, das Verschieben des Fensters oder eine geänderte Skalierung können eine zuverlässige Verbindung verhindern. Kiri entfernt feste Leisten nicht automatisch und scrollt nicht selbst.

Mit **Fertig** wird das Bild wie ein normaler Screenshot kopiert und gespeichert. **Esc** bricht auch aus der ursprünglichen Anwendung ab. **Enter** schließt ab, wenn das Vorschaufenster fokussiert ist; drücke den eingestellten Aufnahme-Shortcut erneut, um es zu fokussieren. Lässt sich der letzte Abschnitt nicht verbinden, wähle **Weiter anpassen** oder ausdrücklich **Erfassten Teil speichern**. Die Ausgabe ist auf 8192 Pixel pro Seite und 32 MiPixels (33.554.432 Pixel) begrenzt. Beim Erreichen der Grenze bleibt der erfasste Teil zur bestätigten Speicherung erhalten.

## Screenshot-Anmerkungen

Wählen Sie eine vorhandene Anmerkung aus, um ihren Stil zu ändern. Mosaik bietet Freihand, Rechteck und Ellipse sowie Pixel- und Unschärfeeffekte mit einstellbarer Stärke. Mit Wasserzeichen (W) schreiben Sie direkt ins Bild und wählen Einzel- oder Kacheldarstellung, Deckkraft, Winkel und Abstand. Gespeicherte Wasserzeichen bleiben bearbeitbar.

Text (T), Nummerierte Notiz (N) und Beschriftungsblase (B) haben eigene Schaltflächen in den Werkzeugleisten für Screenshots und Bildbearbeitung. Wählen Sie die nummerierte Notiz, klicken Sie zum Platzieren und geben Sie die Beschreibung direkt im Bild ein; Return fügt eine Zeile hinzu. Zahl und transparenter Beschreibungsrahmen lassen sich getrennt ziehen; Größe, Farbe und gefüllter Stil oder Kontur sind einstellbar.

Vorhandenen Text, nummerierte Hinweise, Beschriftungen und Wasserzeichen mit einem Klick auswählen, durch Ziehen verschieben und mit einem Doppelklick bearbeiten. Ausgewählte Anmerkungen mit `Delete`, `Backspace` oder **Anmerkung löschen** entfernen; mit `⌘Z` / `Ctrl+Z` rückgängig machen. Beim Tippen löschen die Tasten nur Text.

Während der Eingabe von Text, einer nummerierten Beschreibung oder einer Beschriftung beendet die erste Geste auf freier Fläche die Bearbeitung und hebt die Auswahl auf; erst die nächste verwendet das aktuelle Werkzeug. Bei Text- und Formwerkzeugen wird eine bestehende Auswahl ebenfalls zuerst aufgehoben, bevor eine neue Anmerkung entsteht. Das Werkzeug bleibt ausgewählt. Stift und Mosaik zeichnen weiter kontinuierlich. Ein Klick auf die Bildfläche beendet die Wasserzeicheneingabe; beim erneuten Bearbeiten wird dasselbe Wasserzeichen verwendet.

Anmerkungen liegen in der Reihenfolge ihrer Erstellung übereinander. Später gezeichnetes Mosaik verarbeitet vorherigen Text, Formen und Wasserzeichen; danach hinzugefügte Anmerkungen liegen darüber. Verschieben und Bearbeiten erhalten die Ebene.

## Referenzen und Farben

Ein Doppelklick auf eine freie Stelle im Screenshot-Bereich beendet die Aufnahme; vorhandener Text bleibt per Doppelklick bearbeitbar. Die Stecknadel in der Werkzeugleiste speichert und heftet den Screenshot an; Anheften auf der Abschlusskarte bleibt verfügbar. Ziehen verschiebt das Bild, die untere rechte Ecke ändert seine Größe proportional. Beim Darüberfahren erscheinen Lösen und Schließen.

Im Screenshot-Modus zeigt die Lupe beim Bewegen des Mauszeigers die ursprünglichen Pixel, Koordinaten und den HEX-Farbwert. Mit `⌘C` auf macOS oder `Ctrl+C` kopierst du die Farbe; die Auswahl bleibt erhalten. Beim Annotieren wird die Lupe ausgeblendet.

## GIF-Konvertierung

Beim Konvertieren einer gespeicherten MP4-Datei prüft Kiri zuerst die Video-Dekodierung und beginnt dann mit der GIF-Kodierung. Prüfung und Konvertierung lassen sich abbrechen; mehrere Aufgaben können gemeinsam abgebrochen werden. Das Originalvideo bleibt erhalten. Sobald das abschließende Speichern in der Bibliothek beginnt, ist kein Abbruch mehr möglich.

## Bibliothek und Rückmeldungen

Mit der Mehrfachauswahl können Sie einzelne oder alle Einträge in den Papierkorb verschieben; normale Klicks öffnen sie weiterhin. Der Papierkorb bietet gemeinsames Wiederherstellen und eine Bestätigung im Hauptfenster vor dem Leeren. Umbenennen ändert auch den Dateinamen und erhält den Dateityp. Datei kopieren im Kontextmenü fügt Dateien in Ordner ein; Kopieren fügt weiterhin das Bild ein.

Für Fehlermeldungen lassen sich unter Einstellungen → Über App-, System- und Bildschirmdaten kopieren. Aufnahmen, Zugangsdaten und persönliche Pfade sind nicht enthalten.

Unter Einstellungen → Über lassen sich auch die Einstellungs- und Protokollordner sowie GitHub öffnen. Unter Windows stehen zusätzlich Fehlerprotokolle und der temporäre Systemordner zur Verfügung. Dabei werden keine Dateien gelöscht.

## Datenschutz

Aufnahmen und Medienverarbeitung bleiben lokal. Remote-OCR ist optional und fragt vor jedem Upload nach. Bearbeitbare Screenshots behalten das Originalbild lokal, einschließlich der durch Anmerkungen verdeckten Pixel. Lesen Sie die [Datenschutzrichtlinie](privacy/en.md).

## Weitere Dokumente

[Videobearbeitung](video-editing.de.md) · [Linux](linux.md) · [Dokumentation und QA](README.md) · [Mitwirken](../CONTRIBUTING.md) · [Sicherheit](../SECURITY.md)
