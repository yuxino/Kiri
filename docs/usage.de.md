# Kiri verwenden

[简体中文](usage.zh-CN.md) · [English](usage.md) · [繁體中文](usage.zh-TW.md) · [日本語](usage.ja.md) · **Deutsch** · [한국어](usage.ko.md) · [Français](usage.fr.md) · [Русский](usage.ru.md)

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

Updates: macOS und installierte Windows-Versionen prüfen beim Öffnen des Hauptfensters auf Updates. Das Label „Update“ neben Einstellungen weist auf eine neuere Version hin; laden und installieren Sie sie unter Einstellungen → Über Kiri. Sie können auch manuell prüfen. Bei unterbrochenen In-App-Downloads unter macOS und installierten Windows-Versionen bleiben bereits geladene Daten auch nach einem Neustart erhalten und lassen sich über **Download fortsetzen** weiterführen; fertige Pakete werden vor der Installation weiterhin signaturgeprüft. Linux und Windows Portable benötigen ein neues Paket von Releases. Einstellungen und Aufnahmen der Portable-Version bleiben im Windows-Benutzerprofil.

macOS Dock: Einstellungen → Im Dock anzeigen schaltet das Dock-Symbol sofort um und merkt sich die Wahl. Tray und Aufnahme-Tastenkürzel bleiben auch ohne Dock-Symbol verfügbar.

## Aufnahmen endgültig löschen

Wählen Sie im Menü einer Aufnahme **Endgültig löschen** oder markieren Sie mehrere Einträge und klicken Sie in der Leiste über dem Raster auf **Endgültig löschen (Anzahl)**. Die rote Aktion verlangt eine Bestätigung und lässt sich nicht rückgängig machen. **In den Papierkorb** bleibt für wiederherstellbares Löschen erhalten; zum Entfernen ausgewählter Aufnahmen müssen Sie den Papierkorb nicht leeren.

## Sprache

Einstellungen → Allgemein → Sprache bietet English, 简体中文, 繁體中文, 日本語, Deutsch, 한국어, Français und Русский. Ihre Wahl gilt sofort für alle Kiri-Fenster und bleibt nach einem Neustart erhalten. Beim ersten Start wird die Systemsprache verwendet. Die Oberflächensprache ändert keine installierten Linux-OCR-Sprachdaten.

## Aufnehmen

Drücken Sie ⇧⌘A auf macOS oder Shift+Ctrl+A auf Windows / Linux X11 und wählen Sie ein Fenster oder ziehen Sie einen Bereich. Auf Wayland verwenden Sie die Aufnahme-Schaltfläche oder weisen `kiri --capture` in den Desktop-Einstellungen zu. Unterstützte Desktops bieten Einstellungen → Tastenkürzel → Wayland-Desktop-Tastenkürzel für genehmigte Aufnahme-, Pause/Fortsetzen- und Beenden-Tastenkürzel. Ubuntu 24.04 / GNOME 46 behält die Befehlslösung bei.

Unter macOS, Windows und Linux öffnet die Kiri-Programmdatei mit `--capture`, `--record`, `--ocr` oder `--library` die Bereichsauswahl für Screenshots, die Bereichsauswahl für Aufnahmen, die Texterkennung beziehungsweise das Hauptfenster, auch wenn Kiri noch nicht läuft.

Wählen Sie Screenshot, Aufnahme oder OCR. Die Screenshot-Leiste bietet auch QR-Erkennung. Enter bestätigt einen Screenshot; Esc bricht ab. Screenshots landen in der Zwischenablage und lokalen Bibliothek.

Im OCR-Modus startet das Loslassen der Maustaste die Texterkennung für den gewählten Bereich. **Text kopieren** kopiert das gesamte Ergebnis und schließt das Overlay. Für einen Ausschnitt markieren Sie den Text und drücken Ctrl+C oder ⌘C. Wählen Sie **Bereich neu auswählen**, um einen anderen Ausschnitt zu testen, auch nach einem leeren Ergebnis. Das Panel zeigt an, ob das Ergebnis im Textverlauf gespeichert wurde.

Bildschirmauswahlen und gespeicherte Screenshots verwenden unter macOS, Windows und Linux das mitgelieferte Modell Baidu PP-OCRv6 small. Einrichtung oder Modelldownload sind nicht nötig. Findet das Modell keinen Text, kann Kiri lokal erneut prüfen; unter macOS und Windows hilft dabei auch eine passende System-Erkennungssprache für Schriften wie Koreanisch. Wird ein Leistensymbol als Zeichen erkannt, markieren Sie nur den Text.

### Tastenkürzel

Einstellungen → Tastenkürzel bündelt globale Tastenkürzel und die Tastenübersicht in der App. Unter macOS, Windows und X11 klicken Sie in das Tastenfeld einer Aktion und drücken die gewünschte Taste oder Kombination. Funktionstasten F1–F24, Print Screen, Medientasten sowie Kombinationen mit Control, Alt/Option oder Command/Windows werden direkt gespeichert, sofern sie unterstützt und verfügbar sind (unter Windows wird Print Screen allein oder mit Zusatztasten direkt ohne Schreib-Warnung gespeichert). Andere Einzeltasten oder reine Shift-Kombinationen zeigen eine Vorschau und erfordern **Taste verwenden**, da sie auch Eingaben oder Navigation in anderen Apps beeinflussen; bei Aufnahmesteuerungen gilt diese Wirkung nur während einer Aufnahme. Die bisherige Belegung bleibt bis zum Erfolg erhalten.

Unter macOS benötigen gewöhnliche Tastenkürzel keine Eingabeüberwachung. Medientasten nutzen einen abfangenden Event-Tap und setzen eine bestehende Bedienungshilfen-Freigabe voraus. Fehlt sie, meldet Kiri einen Fehler und behält die alte Belegung bei, ohne ein Freigabe-Popup auszulösen oder Berechtigungen zu ändern.

Esc bricht ab. Tab oder Shift+Tab verlässt die Aufzeichnung; bei einer ausstehenden Taste führt Tab zur Bestätigungsschaltfläche. Esc und Tab selbst können zusammen mit Control, Alt/Option oder Command/Windows gespeichert werden. Reine Modifikatortasten setzen keine Belegung. Löschen entfernt eine Belegung; geänderte oder geleerte Zeilen bieten direkt **Standard wiederherstellen**.

Die vier **Startaktionen** bleiben aktiv, solange Kiri läuft:

| Aktion | macOS | Windows / Linux X11 |
| --- | --- | --- |
| Screenshot | ⇧⌘A | Shift+Ctrl+A |
| Aufnehmen | ⌥⇧⌘R | Alt+Shift+Ctrl+R |
| Text erkennen | ⌥⇧⌘O | Alt+Shift+Ctrl+O |
| Hauptfenster anzeigen | ⌥⇧⌘L | Alt+Shift+Ctrl+L |

Die zwei Aktionen **Während der Aufnahme** funktionieren während laufender Aufnahmen (auch im Pause-Zustand) über alle Anwendungen hinweg:

| Aktion | macOS | Windows / Linux X11 |
| --- | --- | --- |
| Aufnahme pausieren / fortsetzen | ⌥⇧⌘P | Alt+Shift+Ctrl+P |
| Aufnahme beenden und speichern | ⌥⇧⌘S | Alt+Shift+Ctrl+S |

Kiri registriert diese beiden nativen Belegungen beim Start einer Aufnahme und gibt sie wieder frei, sobald das Beenden beginnt oder die Aufnahme fehlschlägt. Im Leerlauf, bei der Bereichswahl und im Countdown reservieren sie keine Tasten. Ist ein Aufnahme-Kürzel nicht verfügbar, läuft die Aufnahme weiter und Kiri meldet das Problem; nutzen Sie dann die schwebenden Steuerelemente unter macOS/Windows oder das Tray-Menü und wählen Sie anschließend unter Einstellungen → Tastenkürzel eine andere Kombination.

Aufnehmen und Text erkennen öffnen die Bereichswahl im jeweiligen Modus. Eine Aufnahme wartet weiterhin auf Start und Countdown; Remote-OCR verlangt weiterhin eine Bestätigung. Ihre vorhandene Screenshot-Kombination bleibt erhalten; stimmt sie mit einer neuen Vorgabe überein, startet die neue Aktion ohne Belegung. Eine doppelte oder nicht verfügbare Ersetzung lässt die bisherige Belegung unverändert. Die Registrierung erkennt nicht jedes interne Kürzel anderer Apps; wählen Sie bei Konflikten eine andere Kombination.

Unter Wayland verwaltet weiterhin der Desktop die Tasten. Hinterlegen Sie `kiri --capture`, `kiri --record`, `kiri --ocr` oder `kiri --library` in den Tastatureinstellungen des Desktops und `kiri --toggle-recording-pause` sowie `kiri --stop-recording` für Aufnahmen. Die optionale Portal-Einrichtung behält ihre Aktionen für Aufnahme, Pause/Fortsetzen und Stopp. Die Aufnahmebefehle wirken nur auf eine laufende Aufnahme, doch kann der Desktop ihre Tasten im Leerlauf reserviert halten; Kiri kann desktopverwaltete Belegungen zwischen Aufnahmen nicht freigeben.

Klicken Sie vor der Auswahl eines Zeichenwerkzeugs auf die Schieberegler der Screenshot-Leiste, um Breite und Höhe am Auswahlrand zu bearbeiten. Werte sind Ausgabepixel, auch bei Retina. Enter oder Verlassen eines Feldes übernimmt den Wert. Esc verwirft die Eingabe; ein zweites Esc bricht die Aufnahme ab. Pfeiltasten ändern um ein Pixel, mit Shift um zehn. Ein erneuter Klick verbirgt die Werte. Nach Beginn der Anmerkungen steuern die Schieberegler deren Aussehen.

Wenn sich auf macOS nach der Auswahl die Bildschirmanordnung, Auflösung oder Skalierung ändert, starten Sie vor der Videoaufnahme eine neue Erfassung. Beenden und speichern Sie eine pausierte Aufnahme zuerst.

Während der Texteingabe macht Ctrl/Cmd+Z Textänderungen rückgängig. Enter bestätigt normalen Text, Beschriftungen und Wasserzeichen, ohne den Screenshot abzuschließen; Shift+Enter fügt eine Zeile ein. In nummerierten Beschreibungen fügt Enter eine Zeile ein. Ctrl/Cmd+Enter bestätigt jede Texteingabe. Hat die Screenshot-Fläche den Fokus und ist kein Textfeld geöffnet, schließt Enter den Screenshot ab. Esc verwirft zuerst die aktuelle Textbearbeitung; ein zweites Esc bricht die Erfassung ab. Beim Schließen eines bearbeiteten Bildes mit ungespeicherten Änderungen können Sie speichern, verwerfen oder weiter bearbeiten.

Wenn bei der ersten Aufnahme auf GNOME Wayland kein Berechtigungsdialog erscheint, öffnen Sie die Bibliothek und fordern im Fehlerbanner Zugriff an. Erlauben Sie Screenshots im GNOME-Dialog und versuchen Sie die Aufnahme erneut. Kiri verwirft das Berechtigungsbild. Siehe [Linux-Leitfaden](linux.md).

Die Aufnahmevorbereitung bietet MP4 / GIF, Start und vier nebeneinanderliegende Symbole: Systemton, Mikrofon, Mauszeiger und Klickmarkierungen. Start löst immer einen Countdown von drei Sekunden aus; GIF-Aufnahmen sind ohne Ton. Das Panel passt sich an Auswahl und Bildschirmränder an.

Der kleine Pfeil neben dem Mikrofon öffnet die Auswahl der verfügbaren Eingabegeräte, ohne das Standardgerät des Systems zu ändern. Ist das gewählte Gerät nicht verfügbar oder wird es getrennt, meldet Kiri einen Fehler, statt unbemerkt zu einem anderen Mikrofon zu wechseln.

Unter macOS und Windows folgen die Aufnahmesteuerelemente der Auswahl und weichen Bildschirmrändern aus, ohne den Tastaturfokus zu übernehmen. Ziehen verschiebt das aktuelle Panel; die nächste Aufnahme richtet es wieder an der neuen Auswahl aus. Pausieren erhält die bereits aufgenommene Zeit, Fortsetzen zählt weiter. Nutzen Sie die festgelegten Aufnahme-Kürzel, die Steuertasten oder das Tray-Menü. Es gibt keine fest eingebauten Space/Esc-Einzeltasten für die Aufnahme; eine ausdrücklich als Aufnahme-Kürzel bestätigte Einzeltaste folgt dieser Belegung. Eine fokussierte Schaltfläche unterstützt weiterhin normales Auslösen per Space/Enter. Esc bricht weiterhin Erfassung und Countdown ab. Ältere Windows-Versionen zeigen eventuell weiterhin den systemeigenen Vollbild-Rahmen. Linux nutzt native X11-Kürzel, desktopverwaltete Wayland-Kürzel, Tray-Aktionen oder Befehle.

## Scrollaufnahmen

Wählen Sie den scrollenden Inhalt und vor dem Hinzufügen von Anmerkungen **Scrollaufnahme** in der Screenshot-Leiste. Beginnen Sie an beliebiger Stelle und scrollen Sie wie gewohnt nach oben oder unten. Bereits erfasster Inhalt wird beim Zurückscrollen nicht doppelt hinzugefügt. Lesepausen beenden die Aufnahme nicht. **Fertig** kopiert und speichert das Bild; vor dem Speichern bricht Esc ab. Enter bleibt für die ursprüngliche Anwendung verfügbar.

**Anheften** beendet die Aufnahme, kopiert und speichert das Bild und öffnet es mit einer Aktion über anderen Fenstern. Kann die Referenz nicht geöffnet werden, bleibt das gespeicherte Bild erhalten und lässt sich über die Abschlussvorschau erneut anheften. Wird nur **Erfassten Bereich speichern** angeboten, speichern Sie zuerst dieses Teilergebnis und heften es dann über die Abschlussvorschau an.

Während einer Scrollaufnahme führt `kiri --finish-scroll-capture` dieselbe Prüfung vor dem vollständigen Speichern wie **Fertig** aus; ein Teilergebnis wird nie automatisch stattdessen gespeichert. `kiri --cancel-scroll-capture` bricht vor Beginn des Speicherns ab. Beide Befehle steuern nur die laufende Sitzung und starten keine neue Aufnahme.

Der ausgewählte Bereich bleibt während der Aufnahme sichtbar markiert; außerhalb wird der Bildschirm abgedunkelt. Klicks, Mausrad und Trackpad-Gesten erreichen weiterhin die ursprüngliche Anwendung. Diese Anzeige verändert die Auswahl nicht und erscheint nicht im gespeicherten Bild.

Die Vorschau folgt dem aktuellen Ausschnitt der Originalaufnahme und passt ihn an die Panelbreite an. Ihr Maßstab bleibt gleich, wenn die Aufnahme länger wird. Scrollen Sie in der Vorschau zum Prüfen; sobald der Zeiger den Bereich verlässt, folgt sie wieder der Quelle. Ziehen Sie die Titelzeile, um das Fenster zu verschieben; bei kompakten Bedienelementen ziehen Sie den Statustext. Das Fenster bleibt auf dem aufgenommenen Bildschirm und unter X11 außerhalb der Auswahl.

Nach dem Scrollen entfernt Kiri erkannte feste Kopf- und Fußleisten. An nicht erneut besuchten Außenrändern können Schatten bleiben. Fordert Kiri zur Wiederherstellung auf, scrollen Sie durch den betroffenen Bereich zurück, bevor Sie das vollständige Bild speichern.

Wenn sich eine Ansicht nicht zuordnen lässt, bleibt das zusammenhängende Ergebnis erhalten. Scrollen Sie zum erfassten Inhalt zurück und dann durch die fehlende Stelle. Mit dem Scrollbalken übersprungener, nie angezeigter Inhalt muss erneut sichtbar werden. **Erfassten Bereich speichern** speichert ausdrücklich nur das aktuelle Teilergebnis und ergänzt keine fehlenden oder unsicheren Inhalte. Nach einem Speicherfehler können Sie denselben erhaltenen Stand erneut speichern.

Verfügbar auf macOS, Windows und Linux X11, nicht auf Wayland. Unter macOS muss die Auswahl vollständig in einem normalen Anwendungsfenster liegen. Die Aufnahme bleibt an dieses Fenster gebunden; fremde schwebende Fenster und andere Fenster derselben Anwendung werden ausgeschlossen. Wenn das Quellfenster verschoben oder seine Größe geändert wird oder es nicht mehr verfügbar ist, stoppt die Aufnahme und behält den bisherigen Stand. Windows und X11 erfassen weiterhin den Bildschirmbereich und schließen fremde schwebende Fenster nicht automatisch aus; halten Sie diese außerhalb der Auswahl.

Große leere oder wiederholte Bereiche, horizontales Scrollen, Zoom und Layoutänderungen können die Zuordnung unterbrechen. X11 benötigt außerhalb der Auswahl Platz für die kompakten Bedienelemente von 220 × 76 plus etwas Abstand. macOS und Windows können bei Bedarf von der Aufnahme ausgeschlossene Bedienelemente innerhalb der Auswahl platzieren. Beim Größenlimit speichern Sie den erfassten Bereich und beginnen eine neue Aufnahme.

## Screenshot-Anmerkungen

Gespeicherte Bilder nutzen dieselben Anmerkungswerkzeuge: Ein Werkzeug oder Objekt auswählen, um seine Optionen zu zeigen. Ohne Auswahl bleibt die Bildfläche frei. Lange Bilder werden an die Fensterbreite angepasst; schmale Bilder werden nicht automatisch vergrößert. Scrollen bewegt die Ansicht. Unten lassen sich Zoom, Breite, gesamtes Bild und Originalgröße wählen. Pinch oder Strg/Command-Scrollen zoomt; Leertaste und Ziehen verschiebt die Ansicht. Der Ansichtszoom ändert keine gespeicherten Pixel.

Wählen Sie eine vorhandene Anmerkung aus, um ihren Stil zu ändern. Mosaik bietet Freihand, Rechteck und Ellipse sowie Pixel- und Unschärfeeffekte mit einstellbarer Stärke. Mit Wasserzeichen (W) schreiben Sie direkt ins Bild und passen Deckkraft, Winkel und Abstand des gekachelten Wasserzeichens an. Gespeicherte Wasserzeichen bleiben bearbeitbar.

Die Werkzeugeinstellungen bleiben bei der Hauptleiste, wenn Sie Anmerkungen auswählen oder anpassen. Über die kleinen Griffe lassen sich Leiste und Eigenschaften getrennt verschieben. Mit fokussiertem Griff bewegen die Pfeiltasten um 2 Pixel, mit Shift um 10. Manuelle Positionen bleiben während dieser Aufnahme auch bei Auswahl- oder Werkzeugwechsel erhalten; die nächste Aufnahme verwendet wieder die automatische Platzierung. Das Eigenschaftenfenster weicht der Hauptleiste und den Bildschirmrändern aus. Ausgeblendete Optionen bleiben geschlossen, bis Sie sie über die Leiste wieder öffnen.

Text (T), Nummerierte Notiz (N) und Beschriftungsblase (B) haben eigene Schaltflächen in den Werkzeugleisten für Screenshots und Bildbearbeitung. Wählen Sie die nummerierte Notiz, klicken Sie zum Platzieren und geben Sie die Beschreibung direkt im Bild ein; Return fügt eine Zeile hinzu. Zahl und transparenter Beschreibungsrahmen lassen sich getrennt ziehen; Größe, Farbe und gefüllter Stil oder Kontur sind einstellbar.

Vorhandenen Text, nummerierte Hinweise, Beschriftungen und Wasserzeichen mit einem Klick auswählen, durch Ziehen verschieben und mit einem Doppelklick bearbeiten. Ausgewählte Anmerkungen mit `Delete`, `Backspace` oder **Anmerkung löschen** entfernen; mit `⌘Z` / `Ctrl+Z` rückgängig machen. Beim Tippen löschen die Tasten nur Text.

Mit Rechteck, Linie oder Pfeil zeichnet ein Ziehen auf freier Fläche sofort die nächste Form; ein einfacher Klick hebt nur die Auswahl auf. Bei Text, nummerierten Notizen und Beschriftungen muss eine bestehende Auswahl vor der nächsten Platzierung aufgehoben werden. Während der Texteingabe bestätigt die erste Geste auf freier Fläche nur die Bearbeitung und hebt die Auswahl auf; erst die nächste platziert eine Anmerkung. Die IME-Bestätigung behält ihr natives Verhalten. Stift und Mosaik zeichnen kontinuierlich. Ein Klick auf die Bildfläche beendet die Wasserzeicheneingabe; erneutes Bearbeiten verwendet dasselbe Wasserzeichen.

Ein Rechtsklick auf die Screenshot-Fläche bestätigt eine offene Texteingabe, verwirft einen noch laufenden Ziehvorgang oder hebt sonst die Objektauswahl auf und wechselt zu Auswählen. Fertige Anmerkungen, Aufnahmebereich und Rückgängig-Verlauf bleiben erhalten. Vor Beginn der Anmerkungen löscht ein Rechtsklick die Bereichsauswahl; ein weiterer verlässt die Erfassung. Eingabefelder behalten ihre nativen Kontextmenüs.

Anmerkungen liegen in der Reihenfolge ihrer Erstellung übereinander. Später gezeichnetes Mosaik verarbeitet vorherigen Text, Formen und Wasserzeichen; danach hinzugefügte Anmerkungen liegen darüber. Verschieben und Bearbeiten erhalten die Ebene.

## Referenzen und Farben

Ein Doppelklick auf eine freie Stelle im Screenshot-Bereich beendet die Aufnahme; vorhandener Text bleibt per Doppelklick bearbeitbar. Die Stecknadel in der Werkzeugleiste speichert und heftet den Screenshot an; Anheften auf der Abschlusskarte bleibt verfügbar. Ziehen am Bild verschiebt das Fenster, die untere rechte Ecke ändert die Fenstergröße proportional. Beim Darüberfahren oder Tastaturfokus erscheinen Lösen und Schließen.

Lange Referenzen öffnen sich von oben in lesbarer Breite; der Rest lässt sich durch Scrollen ansehen. Mausrad und Trackpad scrollen durch das Bild. Pinch oder Strg/Command-Scrollen zoomt um den Zeiger, ohne die Fenstergröße zu ändern. Ziehen mit gedrückter Leertaste oder mittlerer Maustaste verschiebt den Bildausschnitt; normales Ziehen bewegt weiterhin das Fenster. Beim Darüberfahren mit dem Mauszeiger oder bei Tastaturfokus erscheinen die Zoomregler. Das Prozentmenü bietet **Breite einpassen**, **Bild einpassen** und **Originalgröße**. Strg/Command +/− zoomt; Strg/Command+0 passt das Bild ein und Strg/Command+1 stellt die ursprüngliche Pixeldichte wieder her. Esc oder Strg/Command+W schließt die Referenz. Die Ansicht ändert das gespeicherte Bild nicht.

Im Screenshot-Modus zeigt die Lupe beim Bewegen des Mauszeigers die ursprünglichen Pixel, Koordinaten und den HEX-Farbwert. Mit `⌘C` auf macOS oder `Ctrl+C` kopierst du die Farbe; die Auswahl bleibt erhalten. Beim Annotieren wird die Lupe ausgeblendet.

## GIF-Konvertierung

Beim Konvertieren einer gespeicherten MP4-Datei prüft Kiri zuerst die Video-Dekodierung und beginnt dann mit der GIF-Kodierung. Prüfung und Konvertierung lassen sich abbrechen; mehrere Aufgaben können gemeinsam abgebrochen werden. Das Originalvideo bleibt erhalten. Sobald das abschließende Speichern in der Bibliothek beginnt, ist kein Abbruch mehr möglich.

## Textverlauf und Screenshot-Suche

Wählen Sie im Textverlauf einen Eintrag für **In den Papierkorb** oder **Erneut erkennen**. Letzteres nutzt das Quellbild des Eintrags und das aktuelle OCR-Verfahren. Kiri fragt nach, bevor eine Korrektur ersetzt oder das Bild an einen Remote-Anbieter gesendet wird. Findet OCR keinen Text oder schlägt fehl, bleibt der bisherige Text erhalten.

**Einstellungen → Texterkennung → Text in neuen Screenshots suchen** ist standardmäßig aus. Aktivieren Sie die Option, um neu gespeicherte Screenshots über die Bibliothekssuche anhand ihres Textinhalts zu finden. Das integrierte Modell läuft lokal auf Ihrem Gerät. Ältere und importierte Bilder lassen sich weiterhin manuell in den Textverlauf erkennen. Große Bilder oder Aufnahmen bei voller Hintergrund-Warteschlange werden unter Umständen nicht indiziert. Ausschalten stoppt die neue Indizierung und behält vorhandene Treffer bei.

## Bibliothek und Rückmeldungen

Mit der Mehrfachauswahl können Sie einzelne oder alle Einträge in den Papierkorb verschieben; normale Klicks öffnen sie weiterhin. Der Papierkorb bietet gemeinsames Wiederherstellen und eine Bestätigung im Hauptfenster vor dem Leeren. Umbenennen ändert auch den Dateinamen und erhält den Dateityp. Datei kopieren im Kontextmenü fügt Dateien in Ordner ein; Kopieren fügt weiterhin das Bild ein.

Klicken Sie auf einer Karte auf **Tag hinzufügen…**, um einen Tag einzugeben, oder ziehen Sie die Karte zum Zuweisen auf ein sichtbares Tag. Das Ziehen einer markierten Karte versieht die ausgewählten Aufnahmen gemeinsam mit diesem Tag. Über **Tags verwalten** in der Auswahlleiste fügen Sie ein Tag per Name hinzu oder entfernen ein bestimmtes Tag aus der Auswahl.

Für Fehlermeldungen lassen sich unter Einstellungen → Über App-, System- und Bildschirmdaten kopieren. Aufnahmen, Zugangsdaten und persönliche Pfade sind nicht enthalten.

Unter Einstellungen → Über lassen sich auch die Einstellungs- und Protokollordner sowie GitHub öffnen. Unter Windows stehen zusätzlich Fehlerprotokolle und der temporäre Systemordner zur Verfügung. Dabei werden keine Dateien gelöscht.

## Datenschutz

Aufnahmen und Medienverarbeitung bleiben lokal. Remote-OCR ist optional und fragt vor jedem Upload nach. Bearbeitbare Screenshots behalten das Originalbild lokal, einschließlich der durch Anmerkungen verdeckten Pixel. Lesen Sie die [Datenschutzrichtlinie](privacy/en.md).

## Weitere Dokumente

[Videobearbeitung](video-editing.de.md) · [Linux](linux.md) · [Dokumentation und QA](README.md) · [Mitwirken](../CONTRIBUTING.md) · [Sicherheit](../SECURITY.md)
