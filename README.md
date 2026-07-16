# Viewer IFC — visualiseur IFC pour iPhone (PWA)

Une application web installable sur l'écran d'accueil de votre iPhone, qui ouvre
vos maquettes **IFC** (IFC2x3 et IFC4.x) directement depuis l'app **Fichiers**,
en 3D, au doigt — et qui fonctionne **hors connexion** après le premier
chargement.

![Icône](icons/icon-192.png)

---

## Ce que fait l'app

- 📂 Importe un fichier `.ifc` ou `.ifczip` depuis l'app **Fichiers** (iCloud Drive inclus).
- 🧱 Affiche la **géométrie complète** de la maquette (pas de simplification).
- 👆 **Un doigt** : faire pivoter · 🤏 **Deux doigts** : zoomer · ✋ **Deux doigts glissés** : déplacer.
- 📱 Fonctionne en **vertical et en paysage**.
- 🔌 **Offline** après le premier chargement ; **installable** sur l'écran d'accueil.

> ⚠️ **Limite importante (iPhone).** Safari coupe une page qui consomme trop de
> mémoire, sans message d'erreur. En pratique :
> **< 20 Mo** : fiable partout · **20–50 Mo** : OK sur iPhone récent ·
> **> 50 Mo** : risqué, l'app vous prévient avant d'essayer.

---

## Partie 1 — Mettre l'app en ligne (GitHub Pages)

Vous n'avez rien à installer sur votre ordinateur. Tout se passe sur le site de
GitHub, dans le dépôt `ios-viewer`.

### Étape 1 — Vérifier que le code est bien sur GitHub

Les fichiers de cette app doivent être sur la branche **`main`** de votre dépôt
`nvalettepro-sudo/ios-viewer`. (Si vous lisez ce README sur GitHub, c'est
probablement déjà le cas.)

### Étape 2 — Activer GitHub Pages

1. Ouvrez votre dépôt sur GitHub : `https://github.com/nvalettepro-sudo/ios-viewer`
2. Cliquez sur l'onglet **Settings** (Réglages), tout en haut à droite.
3. Dans le menu de gauche, cliquez sur **Pages**.
4. Sous **Build and deployment** → **Source**, choisissez **Deploy from a branch**.
5. Sous **Branch**, sélectionnez **`main`** et le dossier **`/ (root)`**.
6. Cliquez sur **Save**.

### Étape 3 — Attendre la mise en ligne

Rechargez la page **Settings → Pages** au bout d'1 à 2 minutes. Une bannière
verte affichera l'adresse de votre app, du type :

```
https://nvalettepro-sudo.github.io/ios-viewer/
```

C'est **cette adresse** que vous ouvrirez sur votre iPhone. Notez-la.

---

## Partie 2 — Ouvrir et installer l'app sur votre iPhone

### Étape 1 — Ouvrir dans Safari

Sur votre iPhone, ouvrez **Safari** (obligatoirement Safari, pas Chrome) et allez
à l'adresse `https://nvalettepro-sudo.github.io/ios-viewer/`.

L'écran d'accueil de l'app s'affiche.

### Étape 2 — Installer sur l'écran d'accueil (recommandé)

1. Touchez le bouton **Partager** (le carré avec une flèche vers le haut), en bas.
2. Faites défiler et touchez **« Sur l'écran d'accueil »**.
3. Touchez **Ajouter**.

Une icône « Viewer IFC » (un cube) apparaît sur votre écran d'accueil. En la
lançant depuis là, l'app s'ouvre en plein écran, comme une vraie application, et
fonctionne même sans connexion.

### Étape 3 — Ouvrir une maquette

1. Touchez **« Importer un IFC »** (ou « Choisir un fichier »).
2. L'app **Fichiers** s'ouvre : naviguez vers votre `.ifc` (iCloud Drive, « Sur
   mon iPhone », etc.) et touchez-le.
3. La maquette se charge et s'affiche. Manipulez-la au doigt.

> 💡 Sur iPhone, on **ne peut pas** faire « Ouvrir avec » un `.ifc` depuis
> Fichiers vers l'app : c'est une limite d'iOS. On ouvre toujours l'app d'abord,
> puis on importe le fichier. C'est normal.

---

## Gestes

| Geste | Action |
|------|--------|
| Glisser **un** doigt | Faire pivoter la maquette |
| Pincer / écarter **deux** doigts | Zoom avant / arrière |
| Glisser **deux** doigts | Déplacer (panoramique) |
| Bouton **Recentrer** | Réajuster la vue sur toute la maquette |
| Bouton **Fermer** | Décharger le modèle et libérer la mémoire |

---

## En cas de souci

- **La page se recharge toute seule / écran noir pendant le chargement** :
  le fichier est probablement trop lourd pour la mémoire de votre iPhone.
  Essayez un modèle plus petit, ou attendez la Phase 2 (conversion Fragments).
- **Mon `.ifc` est grisé dans Fichiers** : ne devrait pas arriver ici (l'app
  n'impose pas de filtre). Vérifiez que le fichier a bien l'extension `.ifc`.
- **Rien ne s'affiche mais pas d'erreur** : le fichier peut ne contenir aucune
  géométrie (fichier de propriétés seul). L'app l'indique.
- **Une mise à jour ne s'affiche pas** : fermez complètement l'app installée puis
  rouvrez-la (le cache offline se rafraîchit au chargement suivant).

---

## Pour les curieux : comment c'est fait

- **web-ifc** (WebAssembly) lit le fichier IFC dans un *Web Worker* (pour ne pas
  figer l'interface) et en extrait la géométrie.
- **Three.js** affiche cette géométrie et gère la caméra (OrbitControls) calibrée
  pour le tactile.
- Un **service worker** met l'app en cache pour l'usage hors connexion.
- Tout est **auto-hébergé** (dossier `vendor/`) : aucune dépendance à un CDN
  externe au moment de l'utilisation.

Détails techniques et contraintes iOS : voir [`CLAUDE.md`](CLAUDE.md).

## Statut

- **Phase 1 (cette version)** : chargement direct IFC + rendu 3D + gestes + PWA. ✅
- **Phase 2 (à venir)** : conversion IFC → Fragments pour les très gros fichiers,
  à décider après vos tests sur vos vraies maquettes.
