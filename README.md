# Calque CAO

Inspection de pièces d'acier (poutre H, profilé U, boîte) par superposition du modèle CAO sur la vidéo du téléphone, dans l'esprit de Twyn (Visometry).

**Application :** https://nc1fusion.github.io/calque-cao/

## Utilisation

1. Choisir la pièce (bouton en haut à droite) : **ouvrir un fichier STEP**, ou une pièce simple (boîte, poutre H, profilé U) avec ses dimensions et ses trous.
2. **Démarrer la caméra** (ou ouvrir une vidéo/photo pour tester).
3. Placer le modèle, au choix :
   - **Viser avec le contour** (caméra) : aligner la pièce sous le contour blanc en bougeant le téléphone ; le modèle s'accroche tout seul.
   - **Figer l'image** puis amener le contour sur la pièce avec les doigts (glisser, pincer, tourner, ou « pivoter » à un doigt). En lâchant, le modèle s'accroche aux arêtes, même s'il n'était qu'à peu près en place.
   - **Trouver la pièce automatiquement** (expérimental) : recherche de la pièce dans l'image, avec « Autre position » pour passer d'une proposition à l'autre.
   - **Placer avec des coins** : l'ancienne méthode (4 coins touchés).
4. **Lancer le suivi**.
5. Tourner lentement autour de la pièce et **capturer** chaque face. Le bilan vote sur toutes les captures : trous conformes, décalés (avec l'écart en mm), absents, pas encore vus.

Ne pas zoomer pendant l'inspection : la focale trouvée au départ est conservée.

## Format des trous

Un trou par ligne, en mm :

```
ame 100 70 22          # âme : x depuis le bout gauche, z depuis le bas, diamètre
aile-haut 150 -55 18   # aile du haut : x, y sur la largeur, diamètre
aile-bas 300 55 18     # aile du bas
```

y = 0 au milieu pour une poutre H, y = 0 au dos de l'âme pour un profilé U.

## Comment ça marche

- **Fichier STEP** : lu sur le téléphone par [occt-import-js](https://github.com/kovacsv/occt-import-js) (OpenCascade compilé en WebAssembly, chargé depuis jsDelivr la première fois, ~8 Mo, licence LGPL-2.1). Les arêtes vives sont celles entre deux faces du STEP qui font un angle ; les trous sont les faces cylindriques creuses (diamètre, axe, épaisseur et position retrouvés automatiquement).
- **Accrochage** : après un geste, le recalage part de la position donnée et de quelques positions voisines (pivotée de ±15°/±30°, inclinée de ±15°, glissée le long de la pièce) et garde la mieux alignée.
- **Recherche automatique** (expérimentale) : des centaines de vues du modèle sont comparées aux arêtes de l'image (cartes de distance par orientation d'arête), puis les meilleures sont affinées.

- **Position de départ** : les coins touchés donnent la pose de la caméra (PnP, moindres carrés de Levenberg-Marquardt, plusieurs départs).
- **Recalage sur les arêtes** (principe de RAPiD, ViSP, VisionLib) : des points le long des arêtes visibles du modèle cherchent le gradient le plus fort perpendiculairement à l'arête ; la pose est corrigée par moindres carrés robustes (poids de Tukey), du grossier au fin. La visibilité vient d'un tampon de profondeur.
- **Suivi vidéo** : même recalage, image par image, à partir de la pose précédente, dans un fil de calcul séparé (Web Worker).
- **Contrôle des trous** : le cercle du modèle est déplacé dans le plan de la plaque (±15 mm) pour trouver où se trouve vraiment le trou. Le décalage commun aux trous d'une même plaque (petite erreur de pose) est retiré avant de juger chaque trou.

Tout le calcul se fait sur le téléphone ; rien n'est envoyé ailleurs.

## Limites connues (prototype)

- Testé sur des images de synthèse et une vraie photo de boîte ; pas encore sur une vraie poutre.
- La recherche automatique trouve la bonne position dans environ 2 cas sur 3 aux tests ; sinon, placer à la main (l'accrochage après un geste est fiable dans les tests).
- Congés et pente intérieure des ailes du U ignorés.
- Fiable pour des trous décalés d'environ 10 mm ou plus, ou absents ; zone grise entre 5 et 8 mm selon la distance et la résolution.

## Fichiers

- `index.html`, `css/app.css`, `js/app.js` : interface
- `js/solveur.js` : pose depuis des coins (PnP)
- `js/modeles.js` : modèles paramétriques (boîte, poutre H, profilé U, trous)
- `js/recalage.js` : recalage sur arêtes, suivi, accrochage, contrôle des trous
- `js/travailleur.js` : fil de calcul
