# Monter une vidéo dans Kiri

[简体中文](video-editing.zh-CN.md) · [English](video-editing.md) · [繁體中文](video-editing.zh-TW.md) · [日本語](video-editing.ja.md) · [Deutsch](video-editing.de.md) · [한국어](video-editing.ko.md) · **Français**

Ouvrez une vidéo de la bibliothèque et choisissez « Découper et exporter » au-dessus de l’image. Ce guide décrit le code actuel ; consultez les notes de version pour les commandes disponibles dans votre version installée.

**Linux :** prend en charge les coupes à vitesse d’origine, la suppression et la réorganisation des clips, les tailles prédéfinies et l’export MP4 séparé avec l’audio source. Les changements de vitesse, annotations, autocollants et effets ci-dessous restent réservés à macOS/Windows. Les projets enregistrés utilisant des opérations indisponibles restent intacts et en lecture seule. La source doit contenir une piste vidéo progressive à pixels carrés et au maximum une piste audio, sans sous-titres. Les codecs nécessaires doivent être installés.

Un projet modifie une seule vidéo source. Vous pouvez la diviser en clips et les réorganiser, mais importer plusieurs vidéos ne les assemble pas dans une même chronologie.

## Importer un enregistrement ou un fichier local

Les enregistrements Kiri apparaissent dans la bibliothèque. Pour d’autres fichiers, choisissez « Importer des médias » ou glissez des fichiers PNG, JPEG, WebP, MP4 ou MOV dans la bibliothèque. Les images utilisent l’éditeur d’images ; les vidéos utilisent l’éditeur vidéo.

Les imports conservent les noms d’origine et apparaissent en tête de la bibliothèque une fois les filtres effacés. Les images sont converties en PNG avec leur orientation appliquée ; les vidéos sont copiées. Les fichiers d’origine restent inchangés. Chaque import accepte jusqu’à 32 fichiers. Les images doivent respecter la limite mémoire du décodeur, peser au maximum 32 Mo et ne dépasser 8192 pixels sur aucun côté. Les vidéos sont limitées à 8 Go.

## Couper et ajuster les clips

- Cliquez sur la chronologie pour déplacer la lecture. Faites glisser les bords pour couper, scindez à la tête de lecture, supprimez un clip ou faites glisser les clips pour les réorganiser.
- Sélectionnez un clip pour régler sa vitesse entre 0,25 et 4×. Cela modifie l’aperçu du montage et la vidéo exportée.
- Réglez la hauteur de la chronologie. Les pistes supplémentaires défilent à l’intérieur pour laisser de la place à l’image.
- Annuler et Rétablir couvrent les coupes, l’ordre, la vitesse, les effets, les annotations et le timing. Supprimer agit sur le clip, l’annotation, l’autocollant ou l’effet sélectionné.

Les commandes de lecture sont hors de l’image. La barre de recherche accepte le clavier et affiche les temps au survol. Le déplacement met la vidéo en pause et rétablit l’état précédent au relâchement. Les vitesses de lecture prédéfinies et personnalisées de 0,1 à 8× sont mémorisées pour la lecture uniquement ; elles ne changent pas la vitesse d’export.

## Ajouter annotations, autocollants et effets

L’éditeur propose les outils de capture : crayon, rectangle, ligne, flèche, texte modifiable et pinceaux de mosaïque pixelisée ou floue. Ils utilisent vos réglages d’apparence enregistrés ; la couleur initiale est rouge. Les mosaïques vidéo suivent un trait libre ou remplissent un rectangle ou une ellipse.

Une nouvelle marque est sélectionnée après le dessin. Utilisez l’inspecteur pour changer la couleur, l’épaisseur ou la mosaïque, et faites glisser les poignées pour modifier la forme. « Modifier le texte » change le contenu ; la police, la couleur et le fond apparaissent immédiatement. Les pistes de texte montrent leur contenu. Échap annule la modification de texte en cours.

Ajoutez des autocollants PNG, JPEG ou WebP fixes depuis la barre d’outils. Ils conservent la transparence et leurs proportions au redimensionnement. Vous pouvez sélectionner et déplacer annotations, autocollants et masques directement sur l’image.

Les effets comprennent un zoom de 1,5 à 4× limité dans le temps, avec entrée et sortie réglables, des masques flous ou pixelisés et des masques unis avec une couleur personnalisée. Faites glisser l’image zoomée pour recadrer. Vous pouvez ajouter une zone éclairée, un recadrage avec fond et marge en gardant le rapport d’image, ou des fondus d’entrée et de sortie avec durée et couleur. Les options moins fréquentes sont sous « Finitions ». Les changements apparaissent immédiatement.

Chaque annotation, autocollant et effet possède son propre timing. Faites glisser le milieu d’une piste pour la déplacer dans le temps, ses bords pour changer la durée, ou sa poignée gauche verticalement pour modifier l’ordre des calques. La liste défile près d’un bord. Les superpositions supérieures couvrent les inférieures dans l’aperçu et l’export. Les réglages de toute l’image ont un groupe ordonné distinct. Les temps suivent la chronologie de la vidéo terminée après les coupes et changements de vitesse.

## Enregistrer et reprendre plus tard

Les modifications, calques temporels, autocollants et la position actuelle s’enregistrent automatiquement dans la bibliothèque locale. Rouvrez la source pour continuer, ou appuyez sur Cmd/Ctrl+S pour enregistrer immédiatement. Fermer la fenêtre termine la saisie de texte et attend l’enregistrement. En cas d’échec, vous pouvez réessayer ou continuer. Fermer explicitement sans enregistrer conserve le dernier projet enregistré avec succès.

Le projet modifiable et le MP4 exporté sont séparés. L’export ne remplace pas la vidéo source.

## Exporter un MP4

Choisissez « Exporter » en haut à droite. Le menu de qualité montre les dimensions réelles de sortie.

| Réglage | Taille de sortie |
| --- | --- |
| Haute qualité | Conserve les dimensions source |
| Partage courant | Côté le plus long jusqu’à 1080 pixels |
| Fichier compact | Côté le plus long jusqu’à 720 pixels |

Les petites sources ne sont jamais agrandies. La taille du fichier dépend de la source et de la durée du montage. L’export crée une copie dans la bibliothèque, affiche la progression d’encodage et peut être annulé avant l’enregistrement final. L’annulation conserve votre projet et n’ajoute aucune vidéo partielle.

Les exports conservent l’audio synchronisé. Linux normalise l’audio en AAC stéréo à 48 kHz, applique l’orientation vidéo et conserve le rythme des images à fréquence variable et des images maintenues. macOS conserve la hauteur du son lors des changements de vitesse ; Windows la change avec la vitesse. Sous Windows, les effets nécessitent actuellement une source sans métadonnées de rotation. Les enregistrements Kiri remplissent cette condition.

[Utilisation](usage.fr.md) · [Retour à Kiri](../README_FR.md)
