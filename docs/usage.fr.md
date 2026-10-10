# Utiliser Kiri

[简体中文](usage.zh-CN.md) · [English](usage.md) · [繁體中文](usage.zh-TW.md) · [日本語](usage.ja.md) · [Deutsch](usage.de.md) · [한국어](usage.ko.md) · **Français**

[Retour au README](../README_FR.md)

## Installation et mises à jour

[Télécharger la dernière version →](https://github.com/yuxino/kiri/releases/latest)

| Plateforme | Installation |
| --- | --- |
| macOS 14+ · Apple silicon et Intel | Ouvrez le `.dmg` Universal et glissez Kiri dans Applications. |
| Windows 11 · x64 | Exécutez l’installateur `.exe`, ou extrayez le ZIP Portable et lancez `kiri.exe`. |
| Ubuntu 24.04 · x64 · GNOME / X11 | Téléchargez le `.deb`, puis exécutez `sudo apt install ./kiri_VERSION_amd64.deb` avec le nom réel du fichier. |

macOS nécessite l’autorisation d’enregistrement de l’écran et de l’audio système. Les indicateurs de clic nécessitent aussi la surveillance des entrées, et l’enregistrement du microphone nécessite macOS 15+. L’application n’est pas notariée par Apple : si elle est bloquée, utilisez Réglages Système → Confidentialité et sécurité → Ouvrir quand même. Les paquets Windows ne sont pas signés Authenticode ; SmartScreen peut afficher un avertissement.

Linux : la capture Wayland prend en charge un seul écran connecté. L’enregistrement MP4 peut inclure le son du système et le microphone via le service audio local PulseAudio ou PipeWire. Les indicateurs de clic sont indisponibles. Les vidéos enregistrées permettent des coupes simples et l’export MP4 ; les effets vidéo avancés sont indisponibles. Consultez le [guide Linux](linux.md) pour la configuration et les commandes d’enregistrement.

Mises à jour : les versions macOS et Windows installées utilisent Réglages → À propos → Rechercher des mises à jour. Les utilisateurs Linux et Windows Portable téléchargent un nouveau paquet depuis Releases. Les réglages et captures Portable restent dans le profil utilisateur Windows.

Dock macOS : Réglages → Afficher dans le Dock modifie immédiatement l’icône et mémorise votre choix. Le menu de la barre des menus et le raccourci de capture restent disponibles quand elle est masquée.

## Langue

Réglages → Général → Langue propose English, 简体中文, 繁體中文, 日本語, Deutsch, 한국어 et Français. Votre choix s’applique immédiatement à toutes les fenêtres de Kiri et reste mémorisé après un redémarrage. Au premier lancement, Kiri suit la langue du système. Changer la langue d’interface ne change pas les données de langue OCR installées sous Linux.

## Capture

Appuyez sur ⇧⌘A sous macOS ou Shift+Ctrl+A sous Windows / Linux X11, puis sélectionnez une fenêtre ou faites glisser une zone. Sous Wayland, utilisez le bouton de capture ou attribuez `kiri --capture` dans les réglages du bureau. Les bureaux compatibles proposent aussi Réglages → Général → Raccourcis du bureau Wayland pour autoriser Capturer, Suspendre/Reprendre et Arrêter. Ubuntu 24.04 / GNOME 46 conserve la solution par commandes.

Choisissez Capture d’écran, Enregistrer ou OCR. La barre de capture propose aussi la reconnaissance QR. Entrée confirme une capture ; Échap annule. Les captures vont dans le presse-papiers et la bibliothèque locale. Vous pouvez changer le raccourci de capture dans les réglages sous macOS, Windows et X11.

Avant de choisir un outil d’annotation, cliquez sur les curseurs de la barre de capture pour afficher les champs de largeur et de hauteur aux bords de la sélection. Les réglages d’enregistrement proposent le même bouton. Les valeurs utilisent les pixels de sortie, y compris sur Retina. Entrée ou quitter un champ applique sa valeur ; Échap ignore la saisie, et un deuxième Échap annule la capture. Les flèches ajustent d’un pixel, ou de dix avec Maj. Cliquez à nouveau sur les curseurs pour masquer les champs. Après le début de l’annotation, ils règlent son apparence.

Sous macOS, si vous changez la disposition des écrans, la résolution ou l’échelle après avoir choisi une zone, recommencez une capture avant d’enregistrer. Si l’enregistrement est en pause, arrêtez-le et enregistrez-le d’abord.

Pendant la saisie d’une annotation, Ctrl/Cmd+Z annule les modifications du texte et Maj+Entrée ajoute une ligne. Échap quitte d’abord la saisie ; un deuxième Échap annule la capture. Fermer une image modifiée avec des changements non enregistrés propose Enregistrer, Ignorer ou Continuer à modifier.

Sous GNOME Wayland, si la première capture n’affiche pas de demande d’autorisation, ouvrez la bibliothèque et demandez l’accès depuis la bannière d’erreur. Autorisez les captures dans la boîte de dialogue GNOME, puis réessayez. Kiri supprime l’image d’autorisation. Consultez le [guide Linux](linux.md).

## Annotations de capture

Sélectionnez une annotation existante pour modifier son style. La mosaïque propose le dessin libre, le rectangle et l’ellipse, avec pixellisation ou flou et intensité réglable. Filigrane (W) permet de saisir du texte directement sur l’image, puis de choisir un affichage unique ou répété et de régler l’opacité, l’angle et l’espacement. Les filigranes restent modifiables après enregistrement.

## Conversion GIF

Pour convertir un MP4 de la bibliothèque en GIF, Kiri vérifie d’abord le décodage vidéo, puis commence l’encodage GIF. Vous pouvez annuler pendant la vérification ou la conversion, et annuler plusieurs tâches ensemble. La vidéo d’origine reste conservée. L’annulation est indisponible dès que l’enregistrement final dans la bibliothèque commence.

## Confidentialité

Les captures et le traitement des médias restent locaux. La reconnaissance distante est facultative et demande confirmation avant chaque envoi. Les captures modifiables conservent une image d’origine locale, y compris les pixels masqués par les annotations. Consultez la [politique de confidentialité](../PRIVACY.md).

## Autres documents

[Montage vidéo](video-editing.fr.md) · [Linux](linux.md) · [Documentation et vérification](README.md) · [Contribuer](../CONTRIBUTING.md) · [Sécurité](../SECURITY.md)
