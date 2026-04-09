# Guide d'installation - Chat Bot Shopify avec Claude AI

## Pre-requis

- Un compte Shopify avec une boutique active
- Un compte Anthropic avec des credits API (minimum 5$) : https://console.anthropic.com
- Node.js installe sur ton PC (v20+) : https://nodejs.org
- Git installe : https://git-scm.com

---

## Etape 1 — Telecharger le projet

Ouvre un terminal et tape :

```bash
git clone https://github.com/TON-USERNAME/fell-in-drop-chat.git
cd fell-in-drop-chat
npm install
```

---

## Etape 2 — Creer l'application sur Shopify

1. Va sur https://dev.shopify.com
2. Clique sur **Apps** > **Create app** > **Create app manually**
3. Donne un nom a ton app (ex: "Mon Chat Bot")
4. Note le **Client ID** et la **Cle secrete** qui s'affichent

---

## Etape 3 — Configurer les cles

### Fichier .env

Copie le fichier d'exemple :

```bash
cp .env.example .env
```

Ouvre le fichier `.env` et remplis :

```
CLAUDE_API_KEY=ta-cle-api-anthropic
SHOPIFY_API_KEY=ton-client-id-shopify
SHOPIFY_API_SECRET=ta-cle-secrete-shopify
SHOPIFY_APP_URL=https://localhost:3000
```

### Fichier shopify.app.toml

Ouvre `shopify.app.toml` et remplace :

```toml
client_id = "ton-client-id-shopify"
```

---

## Etape 4 — Creer une boutique de developpement

Shopify exige une dev store pour tester les apps.

1. Va sur https://dev.shopify.com > **Stores** > **Create store**
2. Choisis "Development store"
3. Donne-lui un nom
4. Note l'URL `.myshopify.com` de cette boutique

---

## Etape 5 — Preparer la base de donnees

```bash
npx prisma generate
npx prisma migrate deploy
```

---

## Etape 6 — Lancer en mode developpement

```bash
npx shopify app dev --store ta-dev-store.myshopify.com
```

Le terminal va :
- Demarrer le serveur
- Creer un tunnel Cloudflare (une URL temporaire)
- Te donner un lien pour installer l'app

**Important** : note l'URL Cloudflare qui s'affiche (ex: `https://xxxx.trycloudflare.com`)

---

## Etape 7 — Installer l'app sur la boutique

1. Clique sur le lien [1] affiche dans le terminal pour installer l'app
2. Accepte les permissions

---

## Etape 8 — Activer le chat dans le theme

1. Va dans l'editeur de theme de ta boutique (le lien [2] du terminal)
2. Clique sur l'icone **puzzle** (App embeds / Integrations)
3. Active **"AI Chat Assistant"**
4. Dans le champ **"Server URL"**, colle ton URL Cloudflare (ex: `https://xxxx.trycloudflare.com`)
5. Personnalise le message d'accueil et la couleur si tu veux
6. Clique **Save**

---

## Etape 9 — Tester

Va sur ta boutique. Tu devrais voir :
- Une bulle de chat en bas a droite
- Apres 15 secondes, un message d'incitation apparait
- Envoie un message pour verifier que Claude repond

---

## Parametres personnalisables (editeur de theme)

| Parametre | Description |
|-----------|-------------|
| Chat Bubble Color | Couleur de la bulle de chat |
| Welcome Message | Message d'accueil quand le chat s'ouvre |
| Nudge Message | Message qui apparait apres le delai |
| Nudge Delay | Delai avant l'apparition du message (5-60 sec) |
| Server URL | URL de ton serveur (Cloudflare en dev, ton domaine en prod) |
| System Prompt | Personnalite du chatbot (Standard ou Enthousiaste) |

---

## Mode local (developpement)

A chaque fois que tu veux tester :

1. Lance `npx shopify app dev --store ta-dev-store.myshopify.com`
2. L'URL Cloudflare change a chaque lancement — mets-la a jour dans l'editeur de theme
3. Garde le terminal ouvert pendant les tests

---

## Deploiement en production (VPS)

Pour que le chat tourne 24/7 sans laisser ton PC allume :

1. Prends un VPS (Hostinger KVM 1 a ~5$/mois, Ubuntu 22.04)
2. Connecte-toi en SSH : `ssh root@IP_DU_VPS`
3. Installe Node.js :
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
   apt install -y nodejs git
   ```
4. Clone et installe :
   ```bash
   git clone https://github.com/TON-USERNAME/fell-in-drop-chat.git
   cd fell-in-drop-chat
   npm install
   npx prisma generate
   npx prisma migrate deploy
   ```
5. Configure le `.env` avec tes cles
6. Installe Nginx + SSL :
   ```bash
   apt install -y nginx certbot python3-certbot-nginx
   ```
7. Configure Nginx pour rediriger vers le port 3000
8. Installe PM2 pour garder l'app active :
   ```bash
   npm install -g pm2
   npm run build
   pm2 start npm --name "chat-bot" -- run start
   pm2 startup
   pm2 save
   ```
9. Deploie l'extension Shopify :
   ```bash
   npx shopify app deploy
   ```
10. Dans l'editeur de theme, mets l'URL de production dans "Server URL"

---

## Couts

| Service | Cout |
|---------|------|
| API Claude (Haiku) | ~0.001$ par conversation (~5$ = 5000 conversations) |
| VPS Hostinger | ~5$/mois |
| SSL (Let's Encrypt) | Gratuit |
| **Total** | ~5$/mois + usage API |

---

## Depannage

| Probleme | Solution |
|----------|----------|
| "Credit balance too low" | Ajoute des credits sur https://console.anthropic.com/settings/billing |
| "Shop is not configured for app development" | Utilise une dev store, pas ta boutique principale |
| Le chat ne repond pas | Verifie que l'URL dans "Server URL" est correcte et que le serveur tourne |
| "Failed to start dev preview" | Pas grave, le serveur tourne quand meme. Verifie avec l'URL Cloudflare |
| CORS error | Verifie que l'URL dans "Server URL" correspond bien au tunnel actif |
