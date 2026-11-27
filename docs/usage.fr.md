# Utiliser Kiri

[简体中文](usage.zh-CN.md) · [English](usage.md) · [繁體中文](usage.zh-TW.md) · [日本語](usage.ja.md) · [Deutsch](usage.de.md) · [한국어](usage.ko.md) · **Français** · [Русский](usage.ru.md)

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

Mises à jour : les versions installées sous macOS et Windows recherchent les mises à jour à l’ouverture du panneau principal. Un libellé « Mise à jour » à côté des réglages signale une nouvelle version ; utilisez Réglages → À propos pour la télécharger et l’installer. Vous pouvez aussi vérifier manuellement. Les téléchargements interrompus dans l’application sur macOS et Windows (version installée) conservent leurs données même après un redémarrage et proposent **Reprendre le téléchargement** ; les paquets terminés restent vérifiés par signature avant l’installation. Les utilisateurs Linux et Windows Portable téléchargent un nouveau paquet depuis Releases. Les réglages et captures Portable restent dans le profil utilisateur Windows.

Dock macOS : Réglages → Afficher dans le Dock modifie immédiatement l’icône et mémorise votre choix. Le menu de la barre des menus et le raccourci de capture restent disponibles quand elle est masquée.

## Supprimer définitivement des captures

Dans le menu d’une capture, choisissez **Supprimer définitivement**, ou sélectionnez plusieurs éléments puis cliquez sur **Supprimer définitivement (nombre)** dans la barre au-dessus de la grille. L’action rouge demande confirmation et est irréversible. **Mettre à la corbeille** reste disponible pour une suppression récupérable ; vous n’avez pas besoin de vider la corbeille pour supprimer les captures sélectionnées.

## Langue

Réglages → Général → Langue propose English, 简体中文, 繁體中文, 日本語, Deutsch, 한국어, Français et Русский. Votre choix s’applique immédiatement à toutes les fenêtres de Kiri et reste mémorisé après un redémarrage. Au premier lancement, Kiri suit la langue du système. Changer la langue d’interface ne change pas les données de langue OCR installées sous Linux.

## Capture

Appuyez sur ⇧⌘A sous macOS ou Shift+Ctrl+A sous Windows / Linux X11, puis sélectionnez une fenêtre ou faites glisser une zone. Sous Wayland, utilisez le bouton de capture ou attribuez `kiri --capture` dans les réglages du bureau. Les bureaux compatibles proposent aussi Réglages → Raccourcis → Raccourcis du bureau Wayland pour autoriser Capturer, Suspendre/Reprendre et Arrêter. Ubuntu 24.04 / GNOME 46 conserve la solution par commandes.

Sous macOS, Windows et Linux, l’exécutable Kiri accepte aussi `--capture`, `--record`, `--ocr` et `--library` pour ouvrir respectivement la sélection de capture d’écran, la sélection d’enregistrement, la reconnaissance de texte et la fenêtre principale, que Kiri soit déjà lancé ou non.

Choisissez Capture d’écran, Enregistrer ou OCR. La barre de capture propose aussi la reconnaissance QR. Entrée confirme une capture ; Échap annule. Les captures vont dans le presse-papiers et la bibliothèque locale.

En mode OCR, relâchez le pointeur pour reconnaître la zone sélectionnée. **Copier le texte** copie tout le résultat et ferme la superposition. Pour copier une partie du texte, sélectionnez-le puis appuyez sur Ctrl+C ou ⌘C. Choisissez **Choisir une autre zone** pour essayer une autre zone, y compris après un résultat vide. Le panneau indique si le résultat a été enregistré dans l’historique du texte.

Les sélections d’écran et les captures enregistrées utilisent le modèle intégré Baidu PP-OCRv6 small sur macOS, Windows et Linux. Aucune configuration ni aucun téléchargement de modèle n’est nécessaire. Kiri peut réessayer localement lorsque le modèle ne trouve pas de texte ; sous macOS et Windows, une langue de reconnaissance système adaptée peut aussi aider pour des écritures comme le coréen. Si une icône de barre d’outils apparaît comme un caractère, sélectionnez uniquement le texte.

### Raccourcis

Réglages → Raccourcis réunit les raccourcis globaux et l’aide-mémoire des touches dans l’application. Sous macOS, Windows et X11, cliquez sur le champ d’une action et appuyez sur la touche ou combinaison souhaitée. Les touches de fonction F1–F24, Print Screen, les touches multimédias et les combinaisons avec Control, Alt/Option ou Command/Windows s’enregistrent directement lorsqu’elles sont prises en charge et disponibles (sous Windows, Print Screen seul ou avec modificateurs s’enregistre directement sans avertissement de touche de saisie). Les autres touches simples ou combinaisons avec Maj uniquement affichent un aperçu et demandent **Utiliser cette touche**, car elles affectent aussi la saisie ou la navigation dans d’autres applications ; pour les commandes d’enregistrement, cet effet ne dure que pendant l’enregistrement. L’ancienne attribution reste en place tant que la modification n’a pas réussi.

Sous macOS, les raccourcis ordinaires ne nécessitent pas la surveillance des entrées. Les raccourcis avec touches multimédias utilisent une interception d’événements et exigent l’autorisation d’accessibilité existante. Si elle manque, Kiri signale une erreur et conserve l’ancienne attribution sans afficher de demande d’autorisation ni modifier vos permissions.

Échap annule. Tab ou Maj+Tab quitte l’enregistrement ; avec une touche en attente, Tab permet d’atteindre le bouton de confirmation. Échap et Tab peuvent eux-mêmes être enregistrés s’ils sont combinés avec Control, Alt/Option ou Command/Windows. Appuyer uniquement sur des modificateurs ne crée pas de raccourci. Effacer supprime une attribution, et les lignes modifiées ou effacées proposent directement **Rétablir la valeur par défaut**.

Les quatre **actions de lancement** restent disponibles tant que Kiri est en cours d’exécution :

| Action | macOS | Windows / Linux X11 |
| --- | --- | --- |
| Capture d’écran | ⇧⌘A | Shift+Ctrl+A |
| Enregistrer | ⌥⇧⌘R | Alt+Shift+Ctrl+R |
| Reconnaître le texte | ⌥⇧⌘O | Alt+Shift+Ctrl+O |
| Afficher la fenêtre principale | ⌥⇧⌘L | Alt+Shift+Ctrl+L |

Les deux actions **Pendant l’enregistrement** fonctionnent dans les autres applications pendant un enregistrement, y compris en pause :

| Action | macOS | Windows / Linux X11 |
| --- | --- | --- |
| Suspendre/Reprendre l’enregistrement | ⌥⇧⌘P | Alt+Shift+Ctrl+P |
| Arrêter et sauvegarder l’enregistrement | ⌥⇧⌘S | Alt+Shift+Ctrl+S |

Kiri enregistre ces deux raccourcis natifs au début de l’enregistrement et les libère lorsque l’arrêt commence ou en cas d’échec. Ils ne réservent pas de touches lorsque Kiri est inactif, pendant la sélection ou le compte à rebours. Si un raccourci d’enregistrement est indisponible, l’enregistrement continue et Kiri signale le problème ; utilisez les commandes flottantes sous macOS/Windows ou le menu de la barre d’état pour suspendre ou arrêter, puis choisissez une autre combinaison dans Réglages → Raccourcis.

Enregistrer et Reconnaître le texte ouvrent la sélection de zone dans le mode correspondant. L’enregistrement attend toujours Démarrer et le compte à rebours ; l’OCR distant demande toujours confirmation. Votre combinaison existante pour les captures est conservée ; si elle coïncide avec une nouvelle valeur par défaut, cette nouvelle action démarre non attribuée. Un remplacement en doublon ou indisponible laisse l’ancienne attribution intacte. L’enregistrement système ne détecte pas tous les raccourcis internes d’autres applications ; choisissez une autre combinaison si l’une gêne votre flux de travail.

Sous Wayland, les touches restent gérées par le bureau. Attribuez `kiri --capture`, `kiri --record`, `kiri --ocr` ou `kiri --library` dans les réglages clavier de votre bureau, et `kiri --toggle-recording-pause` ainsi que `kiri --stop-recording` pour les commandes d’enregistrement. La configuration Portal facultative conserve ses actions Capturer, Suspendre/Reprendre et Arrêter. Ces commandes d’enregistrement n’agissent que sur un enregistrement en cours, mais le bureau peut garder leurs touches réservées lorsque Kiri est inactif ; Kiri ne peut pas libérer les raccourcis gérés par le bureau entre deux enregistrements.

Avant de choisir un outil d’annotation, cliquez sur les curseurs de la barre de capture pour afficher les champs de largeur et de hauteur aux bords de la sélection. Les valeurs utilisent les pixels de sortie, y compris sur Retina. Entrée ou quitter un champ applique sa valeur ; Échap ignore la saisie, et un deuxième Échap annule la capture. Les flèches ajustent d’un pixel, ou de dix avec Maj. Cliquez à nouveau sur les curseurs pour masquer les champs. Après le début de l’annotation, ils règlent son apparence.

Sous macOS, si vous changez la disposition des écrans, la résolution ou l’échelle après avoir choisi une zone, recommencez une capture avant d’enregistrer. Si l’enregistrement est en pause, arrêtez-le et enregistrez-le d’abord.

Pendant la saisie, Ctrl/Cmd+Z annule les modifications du texte. Entrée valide le texte ordinaire, les étiquettes et les filigranes sans terminer la capture ; Maj+Entrée ajoute une ligne. Dans une description numérotée, Entrée ajoute une ligne. Ctrl/Cmd+Entrée valide toute saisie de texte. Lorsque le canevas de capture a le focus et qu’aucun champ de texte n’est ouvert, Entrée termine la capture. Échap annule d’abord l’édition du texte ; un deuxième Échap annule la capture. Fermer une image modifiée avec des changements non enregistrés propose Enregistrer, Ignorer ou Continuer à modifier.

Sous GNOME Wayland, si la première capture n’affiche pas de demande d’autorisation, ouvrez la bibliothèque et demandez l’accès depuis la bannière d’erreur. Autorisez les captures dans la boîte de dialogue GNOME, puis réessayez. Kiri supprime l’image d’autorisation. Consultez le [guide Linux](linux.md).

Le panneau de préparation propose MP4 / GIF, Démarrer et quatre icônes côte à côte : son du système, microphone, pointeur et indicateurs de clic. Le démarrage lance toujours un compte à rebours de trois secondes ; les GIF sont sans son. Le panneau s’adapte à la sélection et aux bords de l’écran.

La petite flèche à côté du microphone permet de choisir un périphérique d’entrée réel sans modifier celui par défaut du système. Si le périphérique choisi est indisponible ou déconnecté, Kiri affiche une erreur au lieu de changer de microphone silencieusement.

Sous macOS et Windows, les commandes d’enregistrement suivent la sélection et évitent les bords de l’écran sans prendre le focus clavier. Glisser déplace le panneau en cours ; la capture suivante le replace selon la nouvelle sélection. La pause conserve la durée déjà enregistrée et la reprise la poursuit. Utilisez les raccourcis d’enregistrement configurés, les boutons de commande ou le menu de la barre d’état. Il n’existe pas de touches simples Espace/Échap intégrées pour l’enregistrement ; une touche simple explicitement confirmée comme raccourci d’enregistrement suit cette attribution. Un bouton explicitement ciblé conserve son activation normale par Espace/Entrée. Échap continue d’annuler la capture et le compte à rebours. Les anciennes versions de Windows peuvent encore afficher la bordure système plein écran. Linux utilise les raccourcis natifs X11, les raccourcis Wayland gérés par le bureau, les actions de la barre d’état ou les commandes.

## Captures défilantes

Sélectionnez le contenu à faire défiler, puis **Capture défilante** dans la barre de capture avant d’ajouter des annotations. Commencez où vous voulez et faites défiler normalement vers le haut ou le bas. Revenir sur du contenu capturé n’ajoute pas de doublons. Une pause pour lire ne termine pas la capture. **Terminé** copie et enregistre ; Échap annule avant le début de l’enregistrement. Entrée reste disponible dans l’application d’origine.

**Épingler** termine la capture, copie et enregistre l’image, puis l’ouvre au-dessus des autres fenêtres en une seule action. Si la référence ne s’ouvre pas, l’image enregistrée reste disponible dans l’aperçu de fin pour réessayer. Lorsque seule l’action **Enregistrer la zone capturée** est proposée, enregistrez d’abord ce résultat partiel, puis épinglez-le depuis l’aperçu de fin.

Pendant une capture défilante, `kiri --finish-scroll-capture` effectue les mêmes vérifications avant l’enregistrement complet que **Terminé**, sans enregistrer automatiquement un résultat partiel à la place. `kiri --cancel-scroll-capture` annule avant le début de l’enregistrement. Ces commandes contrôlent uniquement la session en cours et ne démarrent aucune capture.

La sélection reste visible pendant la capture et l’extérieur est assombri. Les clics, la molette et les gestes du pavé tactile atteignent directement l’application d’origine. Ce repère ne change pas la sélection et n’apparaît pas dans l’image enregistrée.

L’aperçu suit la partie actuelle de la capture originale, ajustée à la largeur du panneau. Son échelle reste la même lorsque la capture s’allonge. Faites défiler cet aperçu pour l’examiner, puis éloignez le pointeur pour reprendre le suivi. Faites glisser le titre pour déplacer le panneau, ou le texte d’état en mode compact. Le panneau reste sur l’écran capturé et, sous X11, hors de la sélection.

Après défilement, Kiri retire les en-têtes et pieds de page fixes identifiés. Des ombres peuvent rester aux bords que vous n’avez pas revisités. Si Kiri demande une reprise, revenez sur la zone concernée avant d’enregistrer l’image complète.

Si une vue ne peut pas être raccordée, Kiri conserve le résultat continu et vous invite à revenir au contenu capturé. Revenez, puis parcourez la zone manquante. Le contenu sauté avec la barre de défilement doit être affiché pour être capturé. **Enregistrer la zone capturée** sauvegarde uniquement le résultat partiel actuel, sans compléter les contenus manquants ou incertains. En cas d’échec de sauvegarde, le résultat est conservé pour réessayer.

Disponible sur macOS, Windows et Linux X11, mais pas sur Wayland. Sur macOS, la sélection doit tenir entièrement dans une fenêtre d’application normale. La capture reste liée à cette fenêtre et exclut les fenêtres flottantes externes ainsi que les autres fenêtres de la même application. Déplacer, redimensionner ou rendre indisponible la fenêtre source arrête la capture en conservant la progression. Windows et X11 capturent toujours la zone d’écran et n’excluent pas automatiquement les fenêtres flottantes externes : gardez-les hors de la sélection.

Les grandes zones vides ou répétitives, le défilement horizontal, le zoom et les changements de mise en page peuvent interrompre le raccordement. Sous X11, laissez hors de la sélection de la place pour les commandes compactes de 220 × 76 et un petit espacement. macOS et Windows peuvent placer les commandes exclues de la capture dans la sélection si nécessaire. À la limite de taille, enregistrez la zone capturée et commencez une nouvelle capture.

## Annotations de capture

Les images enregistrées reprennent les outils de capture : sélectionnez un outil ou une annotation pour afficher ses options. Sans sélection, la place reste à l’image. Les images longues s’adaptent à la largeur de la fenêtre ; les images plus étroites ne sont pas agrandies automatiquement. Faites défiler pour les parcourir ; les commandes du bas règlent le zoom, la largeur, l’image entière ou la taille réelle. Pincez ou maintenez Ctrl/Command en faisant défiler pour zoomer ; Espace et glisser déplacent l’image. Le zoom ne modifie pas les pixels enregistrés.

Sélectionnez une annotation existante pour modifier son style. La mosaïque propose le dessin libre, le rectangle et l’ellipse, avec pixellisation ou flou et intensité réglable. Filigrane (W) permet de saisir du texte directement sur l’image, puis de régler l’opacité, l’angle et l’espacement du filigrane répété. Les filigranes restent modifiables après enregistrement.

Les options restent près de la barre principale quand vous sélectionnez ou ajustez des annotations. Faites glisser les petites poignées pour déplacer séparément la barre et les propriétés. Avec une poignée ciblée, les flèches déplacent de 2 pixels, ou de 10 avec Maj. Les positions manuelles restent valables pour cette capture, même après un changement de zone ou d’outil ; la capture suivante reprend le placement automatique. Le panneau de propriétés évite la barre principale et les bords de l’écran. Les options masquées restent fermées jusqu’à leur réouverture depuis la barre.

Texte (T), Note numérotée (N) et Bulle de texte (B) ont chacun leur bouton dans les barres d’outils de capture et d’édition d’image. Choisissez la note numérotée, cliquez pour la placer et saisissez sa description directement sur l’image ; Retour ajoute une ligne. Déplacez séparément le numéro et le cadre transparent de la description, et réglez la taille, la couleur et le style plein ou contour.

Cliquez une fois sur un texte, une note numérotée, une étiquette ou un filigrane existant pour le sélectionner, faites-le glisser pour le déplacer et double-cliquez pour le modifier. Supprimez une annotation sélectionnée avec `Delete`, `Backspace` ou **Supprimer l’annotation** ; annulez avec `⌘Z` / `Ctrl+Z`. Pendant la saisie, ces touches suppriment uniquement du texte.

Avec Rectangle, Ligne ou Flèche, faites glisser sur une zone vide pour dessiner immédiatement la forme suivante ; un simple clic vide retire seulement la sélection. Avec Texte, Note numérotée ou Bulle de texte, retirez la sélection existante avant de placer la suivante. Pendant la saisie de texte, le premier geste sur une zone vide valide seulement l’édition et retire la sélection ; le suivant place une annotation. La confirmation IME conserve son comportement natif. Le stylo et la mosaïque permettent des traits continus. Cliquer sur l’image termine la saisie du filigrane ; la prochaine édition reprend le même filigrane.

Un clic droit sur le canevas de capture valide une saisie de texte ouverte, annule un glissement inachevé ou, sinon, retire la sélection de l’objet et revient à Sélectionner. Les annotations terminées, la zone de capture et l’historique d’annulation sont conservés. Avant de commencer à annoter, un clic droit efface la zone sélectionnée ; un autre quitte la capture. Les champs de saisie conservent leurs menus contextuels natifs.

Les annotations se superposent dans leur ordre de création. Une mosaïque ajoutée ensuite traite les textes, formes et filigranes précédents ; les annotations ajoutées après apparaissent au-dessus. Déplacer ou modifier une annotation conserve sa position dans les calques.

## Références et couleurs

Un double-clic sur une partie sans annotation de la sélection termine aussi la capture ; le texte existant reste modifiable par double-clic. L’épingle de la barre d’outils enregistre et épingle l’image, comme Épingler sur la carte de fin. Faites glisser l’image pour déplacer sa fenêtre et son coin inférieur droit pour redimensionner la fenêtre proportionnellement. Le survol ou le focus clavier affiche les commandes pour désépingler et fermer.

Les références longues s’ouvrent en haut, avec une largeur lisible ; faites défiler pour voir la suite. La molette et le pavé tactile parcourent l’image. Un pincement ou Ctrl/Command avec défilement zoome autour du pointeur sans redimensionner la fenêtre. Faites glisser en maintenant Espace ou le bouton du milieu pour déplacer l’image ; un glissement normal déplace toujours la fenêtre. Le survol ou le focus clavier affiche les commandes de zoom. Le menu du pourcentage propose **Adapter la largeur**, **Image entière** et **Taille réelle**. Ctrl/Command +/− règle le zoom ; Ctrl/Command+0 affiche l’image entière et Ctrl/Command+1 rétablit la densité d’origine. Échap ou Ctrl/Command+W ferme la référence. L’affichage ne modifie pas l’image enregistrée.

En mode Capture, survolez l’écran pour agrandir les pixels d’origine et voir leurs coordonnées et leur couleur HEX. `⌘C` sur macOS ou `Ctrl+C` copie la couleur tout en conservant la sélection. La loupe disparaît pendant l’annotation.

## Conversion GIF

Pour convertir un MP4 de la bibliothèque en GIF, Kiri vérifie d’abord le décodage vidéo, puis commence l’encodage GIF. Vous pouvez annuler pendant la vérification ou la conversion, et annuler plusieurs tâches ensemble. La vidéo d’origine reste conservée. L’annulation est indisponible dès que l’enregistrement final dans la bibliothèque commence.

## Historique du texte et recherche dans les captures

Sélectionnez un élément dans l’historique du texte pour le **Mettre à la corbeille** ou **Relancer l’OCR**. Cette action utilise l’image source de l’élément et le moteur actuel. Kiri demande confirmation avant de remplacer une correction et avant d’envoyer l’image à un fournisseur distant. Si l’OCR ne trouve aucun texte ou échoue, le texte précédent reste enregistré.

**Réglages → Reconnaissance de texte → Chercher du texte dans les nouvelles captures** est désactivé par défaut. Activez-le pour retrouver les nouvelles captures enregistrées par le texte qu’elles contiennent via la recherche de la bibliothèque. Le modèle intégré s’exécute sur votre appareil. Les images plus anciennes ou importées peuvent toujours être reconnues manuellement dans l’historique du texte. La recherche peut manquer les images très grandes ou les captures réalisées lorsque la file d’attente en arrière-plan est pleine. Désactiver l’option arrête la nouvelle indexation tout en conservant les correspondances déjà indexées.

## Bibliothèque et retours

La sélection multiple permet de cocher des éléments ou de tout sélectionner pour les déplacer dans la corbeille ; un clic ordinaire les ouvre toujours. La corbeille permet une restauration groupée et demande confirmation dans la fenêtre principale avant d’être vidée. Renommer modifie aussi le nom du fichier en gardant son type. Copier le fichier dans le menu contextuel sert à coller dans un dossier ; Copier colle toujours l’image.

Cliquez sur **Ajouter une étiquette…** sur une capture pour saisir un nom d’étiquette, ou faites glisser la carte sur une étiquette visible pour l’appliquer. Faire glisser une carte cochée étiquette ensemble les captures sélectionnées. Utilisez **Gérer les étiquettes** dans la barre de sélection pour ajouter une étiquette par nom ou retirer une étiquette précise de la sélection.

Pour signaler un problème, copiez les informations de l’application, du système et des écrans depuis Réglages → À propos. Les captures, identifiants et chemins personnels sont exclus.

Dans Paramètres → À propos, vous pouvez aussi ouvrir les dossiers des paramètres et des journaux, ainsi que GitHub. Sous Windows, le menu inclut les journaux d’erreurs et le dossier temporaire du système. Aucune suppression de fichiers n’est effectuée.

## Confidentialité

Les captures et le traitement des médias restent locaux. La reconnaissance distante est facultative et demande confirmation avant chaque envoi. Les captures modifiables conservent une image d’origine locale, y compris les pixels masqués par les annotations. Consultez la [politique de confidentialité](privacy/en.md).

## Autres documents

[Montage vidéo](video-editing.fr.md) · [Linux](linux.md) · [Documentation et vérification](README.md) · [Contribuer](../CONTRIBUTING.md) · [Sécurité](../SECURITY.md)
