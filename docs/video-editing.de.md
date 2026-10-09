# Ein Video in Kiri bearbeiten

[简体中文](video-editing.zh-CN.md) · [English](video-editing.md) · [繁體中文](video-editing.zh-TW.md) · [日本語](video-editing.ja.md) · **Deutsch** · [한국어](video-editing.ko.md) · [Français](video-editing.fr.md)

Öffnen Sie ein Video aus der Bibliothek und wählen Sie „Zuschneiden und exportieren“ oberhalb des Bildes. Dieser Leitfaden beschreibt den aktuellen Quellstand; die Versionshinweise nennen die Funktionen Ihrer installierten Version.

**Linux:** unterstützt Schnitte bei Originalgeschwindigkeit, Löschen und Umordnen von Clips, Größenpresets sowie separaten MP4-Export mit Quellton. Geschwindigkeit, Anmerkungen, Sticker und Effekte unten sind nur auf macOS/Windows verfügbar. Gespeicherte Projekte mit nicht unterstützten Aktionen bleiben unverändert und schreibgeschützt. Die Quelle muss eine progressive Videospur mit quadratischen Pixeln und höchstens eine Audiospur enthalten, ohne Untertitel. Benötigte Codecs müssen installiert sein.

Ein Projekt bearbeitet ein Quellvideo. Sie können es in Clips teilen und umordnen; der Import mehrerer Videos verbindet sie nicht zu einer Zeitleiste.

## Aufnahme oder lokale Datei importieren

Kiri-Aufnahmen erscheinen in der Bibliothek. Für andere Dateien wählen Sie „Medien importieren“ oder ziehen PNG-, JPEG-, WebP-, MP4- oder MOV-Dateien in die Bibliothek. Bilder öffnen den Bildeditor, Videos den Videoeditor.

Importe behalten den ursprünglichen Namen und erscheinen nach dem Löschen der Filter oben in der Bibliothek. Bilder werden mit ihrer Ausrichtung in PNG umgewandelt; Videos werden kopiert. Originaldateien bleiben unverändert. Pro Import sind bis zu 32 Dateien möglich. Bilder müssen in die Speichergrenze des Decoders passen, höchstens 32 MB groß sein und keine Seite über 8192 Pixel haben. Videos sind auf 8 GB begrenzt.

## Clips schneiden und anpassen

- Klicken Sie auf die Zeitleiste zum Suchen. Ziehen Sie Clipenden zum Kürzen, teilen Sie am Abspielkopf, löschen Sie einen Clip oder ziehen Sie Clips in eine andere Reihenfolge.
- Wählen Sie einen Clip und stellen Sie 0,25–4× Geschwindigkeit ein. Dies gilt für Vorschau und Export.
- Passen Sie die Höhe der Zeitleiste an. Zusätzliche Spuren scrollen innerhalb der Zeitleiste, damit Platz für das Bild bleibt.
- Rückgängig und Wiederholen umfassen Schnitte, Reihenfolge, Geschwindigkeit, Effekte, Anmerkungen und Zeitangaben. Löschen betrifft den ausgewählten Clip, die Anmerkung, den Sticker oder den Effekt.

Die Wiedergabesteuerung liegt außerhalb des Bildes. Die Suchleiste unterstützt Tastatureingabe und zeigt Zeiten beim Überfahren. Beim Ziehen wird pausiert; beim Loslassen kehrt der vorherige Wiedergabestatus zurück. Geschwindigkeitsvorgaben und eigene Werte von 0,1–8× werden nur zum Ansehen gespeichert und ändern den Export nicht.

## Anmerkungen, Sticker und Effekte hinzufügen

Der Editor bietet Stift, Rechteck, Linie, Pfeil, bearbeitbaren Text sowie Pixel- und Unschärfe-Mosaikpinsel. Die Werkzeuge nutzen gespeicherte Darstellungseinstellungen; die Anfangsfarbe ist Rot. Video-Mosaik folgt einer Freihandlinie oder füllt ein Rechteck oder eine Ellipse.

Eine neue Markierung wird ausgewählt. Ändern Sie Farbe, Strichbreite oder Mosaik im Eigenschaftenbereich und ziehen Sie die Griffe zum Umformen. „Text bearbeiten“ ändert den Inhalt; Schriftgröße, Farbe und Hintergrund erscheinen sofort. Textspuren zeigen ihren Inhalt. Esc verwirft die aktuelle Texteingabe.

Fügen Sie statische PNG-, JPEG- oder WebP-Sticker aus der Werkzeugleiste hinzu. Transparenz und Seitenverhältnis bleiben erhalten. Anmerkungen, Sticker und Masken lassen sich direkt im Bild auswählen und verschieben.

Effekte umfassen zeitlich begrenzten 1,5–4× Zoom mit einstellbarem Ein- und Ausstieg, Unschärfe- oder Pixelmasken sowie einfarbige Masken mit eigener Farbe. Ziehen Sie ein gezoomtes Bild zum Neurahmen. Außerdem gibt es Spotlight, Zuschnitt mit Hintergrund und Innenabstand bei erhaltenem Seitenverhältnis sowie Ein- und Ausblenden mit Dauer und Farbe. Seltenere Optionen stehen unter „Feinschliff“. Änderungen erscheinen sofort im Bild.

Jede Anmerkung, jeder Sticker und jeder Effekt hat eigene Zeitangaben. Ziehen Sie die Spurmitte zum Verschieben, die Enden zum Ändern der Dauer und den linken Griff vertikal zum Umordnen der Ebenen. Nahe dem Rand scrollt die Liste. Obere Überlagerungen verdecken untere in Vorschau und Export. Ganzbildanpassungen haben eine eigene geordnete Gruppe. Zeitangaben folgen der fertigen Zeitleiste nach Schnitten und Geschwindigkeitsänderungen.

## Speichern und später fortsetzen

Bearbeitung, zeitliche Ebenen, Sticker und aktuelle Position werden automatisch lokal gespeichert. Öffnen Sie das Quellvideo erneut oder drücken Sie Cmd/Ctrl+S zum sofortigen Speichern. Beim Schließen wird die Texteingabe abgeschlossen und auf das Speichern gewartet. Bei Fehlern können Sie erneut versuchen oder weiter bearbeiten. Ausdrückliches Schließen ohne Speichern behält das zuletzt erfolgreich gespeicherte Projekt.

Das bearbeitbare Projekt und die exportierte MP4 sind getrennt. Export ersetzt das Quellvideo nicht.

## MP4 exportieren

Wählen Sie „Exportieren“ oben rechts. Das Qualitätsmenü zeigt die tatsächlichen Ausgabemaße.

| Einstellung | Ausgabegröße |
| --- | --- |
| Hohe Qualität | Quellmaße bleiben erhalten |
| Für alltägliches Teilen | Längste Seite bis 1080 Pixel |
| Kleine Datei | Längste Seite bis 720 Pixel |

Kleine Quellen werden nie vergrößert. Die Dateigröße hängt von Quelle und bearbeiteter Dauer ab. Der Export erstellt eine Bibliothekskopie, zeigt den Kodierfortschritt und lässt sich vor dem abschließenden Speichern abbrechen. Ein Abbruch behält Ihr Projekt und fügt kein unfertiges Video hinzu.

Exporte behalten synchronen Ton. Linux normalisiert auf 48 kHz Stereo-AAC, wendet die Videoausrichtung an und bewahrt variable Bildraten sowie gehaltene Bilder mit ihren Anzeigedauern. macOS erhält bei Geschwindigkeitsänderungen die Tonhöhe; Windows ändert sie mit der Geschwindigkeit. Videoeffekte auf Windows erfordern derzeit Quellen ohne Rotationsmetadaten. Kiri-Aufnahmen erfüllen diese Voraussetzung.

[Benutzung](usage.de.md) · [Zurück zu Kiri](../README_DE.md)
