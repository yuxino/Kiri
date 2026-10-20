<div align="center">
  <img src="../../src-tauri/icons/128x128.png" width="112" alt="Kiri">
  <h1>Kiri</h1>
  <p>Captures d’écran, reconnaissance de texte et enregistrement d’écran. Vos captures restent locales.</p>
  <p>Pour macOS, Windows et Linux.</p>
  <p><a href="https://kiri.yuxino.cn">Site web</a> · <a href="https://github.com/yuxino/kiri/releases/latest">Télécharger la dernière version</a></p>
  <p><a href="../../README.md">简体中文</a> · <a href="en.md">English</a> · <a href="zh-TW.md">繁體中文</a> · <a href="ja.md">日本語</a> · <a href="de.md">Deutsch</a> · <a href="ko.md">한국어</a> · <strong>Français</strong></p>
  <p>
    <a href="https://github.com/yuxino/kiri/releases/latest"><img src="https://img.shields.io/github/v/release/yuxino/kiri?style=flat&amp;logo=github&amp;logoColor=white" alt="Release"></a>
    <a href="https://github.com/yuxino/kiri/actions/workflows/build.yml?query=branch%3Amain"><img src="https://img.shields.io/github/actions/workflow/status/yuxino/kiri/build.yml?style=flat&amp;logo=githubactions&amp;logoColor=white&amp;branch=main&amp;event=push&amp;label=CI" alt="CI"></a>
    <a href="../../LICENSE"><img src="https://img.shields.io/github/license/yuxino/kiri?style=flat&amp;logo=opensourceinitiative&amp;logoColor=white" alt="MIT"></a>
  </p>
</div>

![Kiri](../assets/readme-preview.png)

## Fonctions

- Capturez une fenêtre ou une zone, ajoutez du texte, des flèches ou une mosaïque, et épinglez les images comme références flottantes. Zoomez et poursuivez les retouches après l’enregistrement.
- Faites défiler vers le haut ou le bas pour créer une longue capture ; revenir sur une zone capturée ne l’ajoute pas deux fois (macOS, Windows, Linux X11).
- Extrayez le texte avec la reconnaissance locale et lisez les codes QR.
- Enregistrez un MP4 avec le son du système et le microphone en option, ou un GIF sans son.
- Coupez et réorganisez les clips d’une même vidéo, puis exportez un nouveau MP4.
- Recherchez, étiquetez, ajoutez aux favoris et exportez vos captures locales ; récupérez les suppressions accidentelles dans la corbeille.
- Définissez, désactivez ou rétablissez les raccourcis globaux dans les réglages ; les commandes d’enregistrement ne sont actives que pendant celui-ci ([Wayland utilise les réglages du bureau](../linux.md)).

## Premiers pas

1. Appuyez sur `⇧⌘A` sous macOS ou `Shift+Ctrl+A` sous Windows / Linux X11 pour ouvrir la capture.
2. Choisissez Capture d’écran, Enregistrer ou OCR, puis cliquez sur une fenêtre ou faites glisser une zone.
3. Pour une capture d’écran, `Entrée` termine et `Échap` annule. L’image est copiée dans le presse-papiers et enregistrée dans la bibliothèque.

[Installation et aide](../usage.fr.md) · [Montage vidéo](../video-editing.fr.md) · [Linux](../linux.md) · [Signaler un problème](https://github.com/yuxino/kiri/issues)

## Merci

Merci à toutes les personnes qui écrivent du code, signalent des problèmes, essaient Kiri ou le partagent.

Merci en particulier à [@kerwin2046](https://github.com/kerwin2046) pour la [prise en charge initiale de Linux](https://github.com/yuxino/kiri/pull/20), et à [@LLLin000](https://github.com/LLLin000) pour la [correction de l’alignement des captures avec la mise à l’échelle du texte Windows](https://github.com/yuxino/kiri/pull/61).

Merci également aux communautés [V2EX](https://www.v2ex.com/), [LINUX DO](https://linux.do/), [Appinn](https://www.appinn.com/), [NodeLoc](https://www.nodeloc.com/) pour leurs retours et leurs partages.

[Tous les contributeurs](https://github.com/yuxino/kiri/graphs/contributors) · [Contribuer](../../CONTRIBUTING.md) · [Confidentialité](../privacy/en.md) · [MIT](../../LICENSE) © 2026 yuxino
