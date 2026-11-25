# VuPay

Application qui paie les utilisateurs pour regarder des vidéos d'annonceurs, en FCFA, avec retrait sur Orange Money, Wave, MTN MoMo et Moov Money.

Ce dossier contient **toute l'application** :

| Élément | Fichier |
|---|---|
| Le serveur (comptes, codes SMS, vidéos, gains, retraits) | `server.js` |
| Les branchements SMS et paiement Mobile Money | `providers.js` |
| L'appli que voient les utilisateurs (installable sur téléphone) | `public/index.html` |
| La page d'administration (statistiques, validation des retraits) | `public/admin.html` |
| Les réglages | `.env` (à créer à partir de `.env.example`) |
| Les vidéos de démonstration ajoutées au démarrage | `seed/demo-videos.json` |

Aucune bibliothèque à installer : il faut seulement **Node.js 22.5 ou plus récent** (la base de données SQLite est intégrée à Node).

---

## 1. Lancer l'appli sur ton ordinateur

1. Installe Node.js depuis nodejs.org (version 22 « LTS » ou plus récente).
2. Ouvre un terminal dans ce dossier.
3. Copie le fichier de réglages : `cp .env.example .env` (sous Windows : `copy .env.example .env`).
4. Lance : `npm start`
5. Ouvre `http://localhost:3000` dans ton navigateur.

Avec les réglages de départ :
- le code SMS s'affiche directement dans l'appli (`DEV_SHOW_OTP=1`) et dans le terminal ;
- les retraits sont **simulés** : aucun argent n'est envoyé (`PAYOUT_PROVIDER=simulation`) ;
- 8 vidéos de démonstration dessinées sont ajoutées (`SEED_DEMO=1`).

Les données sont enregistrées dans le dossier `data/` (base `vupay.db`, vidéos, miniatures). **Sauvegarde ce dossier régulièrement.**

---

## 2. Ajouter de vraies vidéos

Deux façons :

- **Depuis l'appli** : Profil → Espace annonceur. Tu choisis une vidéo MP4 (3 minutes maximum), le titre, la marque, le gain par vue, la question et les 4 réponses. Elle apparaît tout de suite pour tous les utilisateurs.
- **Retirer les vidéos de démonstration** : mets `SEED_DEMO=0` **avant le premier démarrage**. Si la base existe déjà, supprime le dossier `data/` (tout est effacé) ou désactive-les dans la base (`UPDATE videos SET active=0 WHERE kind='demo'`).

Pour des vidéos libres de droits avec des personnes, tu peux utiliser Pexels ou Pixabay (vérifie la licence de chaque vidéo).

---

## 3. Mettre l'appli en ligne

Il te faut un serveur qui fait tourner Node.js 22 avec un **disque permanent** pour le dossier `data/`, et une adresse en **HTTPS** (obligatoire pour installer l'appli sur téléphone).

Options simples :
- **Un petit serveur VPS** (Hostinger, OVH, DigitalOcean, Contabo…) : installe Node.js, copie le dossier, lance `npm start` avec un gestionnaire comme `pm2`, et mets Caddy ou Nginx devant pour le HTTPS.
- **Railway ou Render** : crée un service Node, commande de démarrage `npm start`, et ajoute un volume permanent monté sur `data/` (sans volume, tout est perdu à chaque redémarrage).

Avant d'ouvrir au public, dans `.env` :
- `DEV_SHOW_OTP=0`
- `ADMIN_TOKEN=` une longue phrase secrète
- `PUBLIC_URL=` ton adresse (ex. `https://vupay.sn`)
- un vrai fournisseur SMS et un vrai mode de retrait (sections 4 et 5)

---

## 4. Envoyer de vrais SMS

Choisis un fournisseur d'envoi de SMS qui couvre tes pays (par exemple l'API SMS d'Orange, un agrégateur local, ou un service international). Ensuite :

1. Mets `SMS_PROVIDER=http`, `SMS_API_URL` et `SMS_API_KEY` dans `.env`.
2. Ouvre `providers.js` et adapte `buildSmsRequest()` au format demandé par ton fournisseur (adresse, en-têtes, champs).

---

## 5. Payer les retraits en Mobile Money

Trois modes, à choisir avec `PAYOUT_PROVIDER` :

| Mode | Fonctionnement | Pour qui |
|---|---|---|
| `simulation` | Le retrait passe à « Envoyé » tout seul. **Aucun argent n'est envoyé.** | Tests uniquement |
| `manual` | La demande reste « En attente ». Tu envoies l'argent toi-même depuis ton compte marchand, puis tu cliques « Marquer envoyé » sur `/admin.html`. « Échoué » rembourse le solde. | Pour démarrer sans intégration |
| `http` | L'appli demande le paiement à ton agrégateur (CinetPay, PayDunya, Wave Business, etc.). Le résultat revient par le webhook `/api/webhooks/payout`. | Quand tu as un compte marchand avec API de transfert |

Pour le mode `http` : ouvre un compte marchand chez l'agrégateur, demande l'accès à l'API de **transfert / décaissement** (payout), puis adapte `buildPayoutRequest()` dans `providers.js` à leur documentation. Leur webhook doit appeler `POST /api/webhooks/payout` avec l'en-tête `X-Webhook-Secret` et `{ "reference": "...", "status": "success" | "failed" }` ; si leur format est différent, adapte cette route dans `server.js`.

La devise est choisie automatiquement : **XOF** pour les pays de l'UEMOA, **XAF** pour ceux de la CEMAC.

---

## 6. Installer l'appli sur un téléphone, puis la publier sur le Play Store

- **Sans store** : une fois en ligne en HTTPS, ouvre le site dans Chrome sur Android, puis « Ajouter à l'écran d'accueil » (ou le bouton « Installer VuPay » dans le Profil). L'appli s'ouvre en plein écran avec son icône.
- **Play Store** : va sur **pwabuilder.com**, entre l'adresse de ton site, et télécharge le paquet Android qu'il génère. Tu le publies ensuite avec un compte développeur Google Play (frais d'inscription unique). PWABuilder explique les étapes, dont le fichier `assetlinks.json` à placer dans `public/.well-known/`.

---

## 7. Page d'administration

Ouvre `https://ton-site/admin.html` et entre ton `ADMIN_TOKEN`. Tu y vois :
- le nombre d'utilisateurs, les vidéos validées du jour, le total versé, les retraits en attente et la somme des soldes à payer ;
- la liste des retraits, avec les boutons « Marquer envoyé » et « Échoué ».

---

## 8. Comment l'appli empêche la triche

- Chaque vidéo ne rapporte qu'une fois par jour et par compte.
- Le serveur note l'heure d'ouverture de la vidéo et **refuse la réponse** si le temps écoulé est plus court que la vidéo.
- La bonne réponse n'est jamais envoyée au téléphone : c'est le serveur qui vérifie.
- Pas d'avance rapide dans le lecteur, pause automatique quand on quitte l'écran.
- Un compte = un numéro vérifié par SMS.

À ajouter avant une grosse croissance : limite de comptes par appareil, contrôle des retraits importants, et surveillance des comptes qui répondent toujours trop vite.

---

## 9. Points à régler avant le lancement

- **Le modèle économique** : l'argent versé aux utilisateurs doit venir de ce que paient les annonceurs. Fixe un prix par vue facturé à l'annonceur supérieur au gain versé + frais de transfert.
- **Le cadre légal** : conditions d'utilisation, politique de confidentialité, déclaration des données personnelles auprès de l'autorité de ton pays, et règles de ton agrégateur de paiement (vérification d'identité au-delà de certains montants).
- **Les vidéos des annonceurs** : vérifie leur contenu avant diffusion (droits, contenus interdits).

---

## API (pour un développeur)

| Méthode | Route | Rôle |
|---|---|---|
| POST | `/api/otp/send` | Envoie un code SMS `{country, phone, mode}` |
| POST | `/api/otp/verify` | Vérifie le code, crée le compte si besoin, renvoie un jeton |
| GET / PATCH | `/api/me` | Profil, solde, historique / changer d'opérateur |
| GET | `/api/videos` | Vidéos disponibles (sans la bonne réponse) |
| POST | `/api/views` | Démarre une vidéo |
| POST | `/api/views/:id/answer` | Envoie la réponse, crédite le gain et le bonus |
| POST | `/api/withdrawals` | Demande de retrait |
| PUT | `/api/uploads` | Envoi du fichier vidéo (annonceur) |
| POST | `/api/videos` | Publie la vidéo avec sa question |
| GET | `/api/my-videos` | Vidéos de l'annonceur et nombre de vues |
| DELETE | `/api/videos/:id` | Retire une vidéo |
| POST | `/api/webhooks/payout` | Résultat d'un retrait envoyé par l'agrégateur |
| GET / POST | `/api/admin/...` | Statistiques et retraits (en-tête `X-Admin-Token`) |
