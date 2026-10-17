# Utiliser Kiri

[简体中文](usage.zh-CN.md) · [English](usage.md) · [繁體中文](usage.zh-TW.md) · [日本語](usage.ja.md) · [Deutsch](usage.de.md) · [한국어](usage.ko.md) · **Français**

[Retour au README](readme/fr.md)

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

Avant de choisir un outil d’annotation, cliquez sur les curseurs de la barre de capture pour afficher les champs de largeur et de hauteur aux bords de la sélection. Les valeurs utilisent les pixels de sortie, y compris sur Retina. Entrée ou quitter un champ applique sa valeur ; Échap ignore la saisie, et un deuxième Échap annule la capture. Les flèches ajustent d’un pixel, ou de dix avec Maj. Cliquez à nouveau sur les curseurs pour masquer les champs. Après le début de l’annotation, ils règlent son apparence.

Sous macOS, si vous changez la disposition des écrans, la résolution ou l’échelle après avoir choisi une zone, recommencez une capture avant d’enregistrer. Si l’enregistrement est en pause, arrêtez-le et enregistrez-le d’abord.

Pendant la saisie d’une annotation, Ctrl/Cmd+Z annule les modifications du texte et Maj+Entrée ajoute une ligne. Échap quitte d’abord la saisie ; un deuxième Échap annule la capture. Fermer une image modifiée avec des changements non enregistrés propose Enregistrer, Ignorer ou Continuer à modifier.

Sous GNOME Wayland, si la première capture n’affiche pas de demande d’autorisation, ouvrez la bibliothèque et demandez l’accès depuis la bannière d’erreur. Autorisez les captures dans la boîte de dialogue GNOME, puis réessayez. Kiri supprime l’image d’autorisation. Consultez le [guide Linux](linux.md).

Le panneau de préparation propose MP4 / GIF, Démarrer et quatre icônes côte à côte : son du système, microphone, pointeur et indicateurs de clic. Le démarrage lance toujours un compte à rebours de trois secondes ; les GIF sont sans son. Le panneau s’adapte à la sélection et aux bords de l’écran.

La petite flèche à côté du microphone permet de choisir un périphérique d’entrée réel sans modifier celui par défaut du système. Si le périphérique choisi est indisponible ou déconnecté, Kiri affiche une erreur au lieu de changer de microphone silencieusement.

## Captures défilantes

Sur macOS, Windows ou Linux X11, sélectionnez une zone de capture puis **Capture défilante**, avant d'ajouter des annotations. Sélectionnez uniquement le contenu qui défile verticalement, sans les en-têtes, pieds de page et barres latérales fixes. Laissez de la place pour le panneau d'aperçu à côté de la sélection. S'il ne peut pas rester en dehors, réduisez la zone. Cette fonction est actuellement indisponible sous Wayland.

Faites défiler lentement vers le bas dans l'application d'origine. Le panneau latéral affiche les parties dont le raccord a été validé. Si l'assemblage s'arrête, remontez légèrement dans le contenu déjà capturé, puis reprenez vers le bas. Des contenus répétitifs, des animations, un déplacement de fenêtre ou un changement d'échelle peuvent empêcher un raccord fiable. Kiri ne retire pas automatiquement les barres fixes et ne fait pas défiler à votre place.

Cliquez sur **Terminer** pour copier et enregistrer comme une capture habituelle. **Échap** annule aussi depuis l'application d'origine. **Entrée** termine lorsque le panneau d'aperçu a le focus ; appuyez à nouveau sur votre raccourci de capture pour lui donner le focus. Si la dernière partie ne peut pas être raccordée, choisissez **Continuer à ajuster** ou explicitement **Enregistrer la partie capturée**. La sortie est limitée à 8192 pixels par côté et à 32 MiPixels (33 554 432 pixels). À la limite, la partie validée est conservée pour un enregistrement explicite.

## Annotations de capture

Sélectionnez une annotation existante pour modifier son style. La mosaïque propose le dessin libre, le rectangle et l’ellipse, avec pixellisation ou flou et intensité réglable. Filigrane (W) permet de saisir du texte directement sur l’image, puis de choisir un affichage unique ou répété et de régler l’opacité, l’angle et l’espacement. Les filigranes restent modifiables après enregistrement.

Texte (T), Note numérotée (N) et Bulle de texte (B) ont chacun leur bouton dans les barres d’outils de capture et d’édition d’image. Choisissez la note numérotée, cliquez pour la placer et saisissez sa description directement sur l’image ; Retour ajoute une ligne. Déplacez séparément le numéro et le cadre transparent de la description, et réglez la taille, la couleur et le style plein ou contour.

Cliquez une fois sur un texte, une note numérotée, une étiquette ou un filigrane existant pour le sélectionner, faites-le glisser pour le déplacer et double-cliquez pour le modifier. Supprimez une annotation sélectionnée avec `Delete`, `Backspace` ou **Supprimer l’annotation** ; annulez avec `⌘Z` / `Ctrl+Z`. Pendant la saisie, ces touches suppriment uniquement du texte.

Pendant la saisie de texte, d’une description numérotée ou d’une légende, un premier geste sur une zone vide termine l’édition et retire la sélection ; le suivant utilise l’outil actif. Avec les outils de texte ou de forme, une sélection existante est aussi retirée avant qu’un autre geste crée une annotation. L’outil reste sélectionné. Le stylo et la mosaïque permettent de continuer à dessiner. Cliquer sur l’image pendant la saisie d’un filigrane termine celle-ci ; une nouvelle édition reprend le même filigrane.

Les annotations se superposent dans leur ordre de création. Une mosaïque ajoutée ensuite traite les textes, formes et filigranes précédents ; les annotations ajoutées après apparaissent au-dessus. Déplacer ou modifier une annotation conserve sa position dans les calques.

## Références et couleurs

Un double-clic sur une partie sans annotation de la sélection termine aussi la capture ; le texte existant reste modifiable par double-clic. L’épingle de la barre d’outils enregistre et épingle l’image, comme Épingler sur la carte de fin. Faites glisser l’image pour la déplacer et son coin inférieur droit pour la redimensionner proportionnellement. Le survol affiche les commandes pour désépingler et fermer.

En mode Capture, survolez l’écran pour agrandir les pixels d’origine et voir leurs coordonnées et leur couleur HEX. `⌘C` sur macOS ou `Ctrl+C` copie la couleur tout en conservant la sélection. La loupe disparaît pendant l’annotation.

## Conversion GIF

Pour convertir un MP4 de la bibliothèque en GIF, Kiri vérifie d’abord le décodage vidéo, puis commence l’encodage GIF. Vous pouvez annuler pendant la vérification ou la conversion, et annuler plusieurs tâches ensemble. La vidéo d’origine reste conservée. L’annulation est indisponible dès que l’enregistrement final dans la bibliothèque commence.

## Bibliothèque et retours

La sélection multiple permet de cocher des éléments ou de tout sélectionner pour les déplacer dans la corbeille ; un clic ordinaire les ouvre toujours. La corbeille permet une restauration groupée et demande confirmation dans la fenêtre principale avant d’être vidée. Renommer modifie aussi le nom du fichier en gardant son type. Copier le fichier dans le menu contextuel sert à coller dans un dossier ; Copier colle toujours l’image.

Pour signaler un problème, copiez les informations de l’application, du système et des écrans depuis Réglages → À propos. Les captures, identifiants et chemins personnels sont exclus.

Dans Paramètres → À propos, vous pouvez aussi ouvrir les dossiers des paramètres et des journaux, ainsi que GitHub. Sous Windows, le menu inclut les journaux d’erreurs et le dossier temporaire du système. Aucune suppression de fichiers n’est effectuée.

## Confidentialité

Les captures et le traitement des médias restent locaux. La reconnaissance distante est facultative et demande confirmation avant chaque envoi. Les captures modifiables conservent une image d’origine locale, y compris les pixels masqués par les annotations. Consultez la [politique de confidentialité](privacy/en.md).

## Autres documents

[Montage vidéo](video-editing.fr.md) · [Linux](linux.md) · [Documentation et vérification](README.md) · [Contribuer](../CONTRIBUTING.md) · [Sécurité](../SECURITY.md)
