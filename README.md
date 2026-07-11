# Thetis Tool Extension

Extension **Pi Coding Agent** qui fournit 4 outils pour l'agent :

- **`web_scrape`** — extraction statique de pages (HTML, texte, markdown, liens, readability)
- **`web_search`** — recherche web via DuckDuckGo scraping (gratuit, sans clé API), avec Bing en fallback si DuckDuckGo bloque. SerpAPI pour Google, Yahoo et Yandex.
- **`web_render`** — rendu dynamique avec Playwright pour les SPA JS-heavy
- **`speech_to_text`** — transcription vocale (Whisper local gratuit ou Azure Speech cloud)

Avec système de **cache local**, **configuration persistante**, et **guidelines prompt** pour guider l'agent dans le choix des outils.

## Installation

### Via `pi install` (recommandé)

```bash
pi install git:github.com/SubZzzzzz/thetis-tool
```

Ou temporairement :

```bash
pi -e git:github.com/SubZzzzzz/thetis-tool
```

### Manuelle

```bash
git clone https://github.com/SubZzzzzz/thetis-tool.git ~/.pi/agent/extensions/thetis-tool
cd ~/.pi/agent/extensions/thetis-tool
npm install
```

## Outils

### `web_scrape`

Extraction de contenu depuis une URL. Mode statique par défaut (rapide). Mode dynamique optionnel via Playwright pour les SPA.

**Paramètres :**

| Paramètre | Type | Défaut | Description |
|-----------|------|--------|-------------|
| `url` | `string` | — | URL à scraper |
| `selector` | `string?` | — | Sélecteur CSS pour cibler un élément spécifique |
| `extract` | `"text" \| "markdown" \| "html" \| "links" \| "readability"` | `"html"` | Mode d'extraction |
| `renderJs` | `boolean?` | `false` | Rendu JS via Playwright (lent, pour React/Vue/Angular) |
| `maxLength` | `number?` | `15000` | Nombre max de caractères retournés |

**Modes d'extraction :**

- **`html`** — retourne le DOM complet (défaut pour les LLM)
- **`text`** — texte brut sans balises
- **`markdown`** — conversion HTML → Markdown via Turndown
- **`links`** — liste des liens trouvés (`- [texte](url)`)
- **`readability`** — extraction d'article propre via @mozilla/readability (idéal pour blogs et docs)

**Guidelines prompt :**
- Utiliser `web_scrape` quand l'utilisateur fournit ou mentionne une URL spécifique
- Utiliser `extract='html'` par défaut
- Utiliser `extract='readability'` pour articles, blogs, documentation
- Utiliser `extract='links'` pour découvrir les URLs sortantes
- Ne mettre `renderJs=true` que si la page est une SPA connue et que le fetch statique est vide
- Respecter `maxLength` pour éviter l'overflow de contexte

### `web_search`

Recherche web. Retourne titres, URLs et snippets. Par défaut, tente DuckDuckGo (gratuit). Si DuckDuckGo bloque la requête (CAPTCHA), bascule automatiquement sur Bing. Pour Google, Yahoo ou Yandex, une clé SerpAPI est requise.

**Paramètres :**

| Paramètre | Type | Défaut | Description |
|-----------|------|--------|-------------|
| `query` | `string` | — | Requête de recherche |
| `engine` | `"google" \| "duckduckgo" \| "bing" \| "yahoo" \| "yandex"` | `"duckduckgo"` | Moteur de recherche |
| `numResults` | `number?` | `5` | Nombre de résultats (max 10) |

**Guidelines prompt :**
- Utiliser `web_search` quand l'utilisateur demande des informations actuelles, news, faits ou sources sans fournir d'URL
- Suivre avec `web_scrape` pour lire le contenu complet des résultats les plus pertinents
- Par défaut, utilise DuckDuckGo (gratuit) avec Bing en fallback automatique si bloqué. Pour Google/Yahoo/Yandex, configurer une clé SerpAPI via `/thetis config` ou `SERPAPI_KEY`

### `web_render`

Rendu dynamique avec Playwright pour les pages JS-heavy. Fallback quand `web_scrape` avec `renderJs=true` est insuffisant, ou quand vous avez besoin d'attendre un sélecteur spécifique.

**Paramètres :**

| Paramètre | Type | Défaut | Description |
|-----------|------|--------|-------------|
| `url` | `string` | — | URL à rendre |
| `selector` | `string?` | — | Sélecteur CSS pour extraire un élément spécifique |
| `waitFor` | `string?` | — | Attendre un sélecteur CSS (ex: `#content`) ou un délai en ms (ex: `2000`) |
| `extract` | `"text" \| "markdown" \| "html"` | `"html"` | Mode d'extraction |
| `maxLength` | `number?` | `15000` | Nombre max de caractères |

**Guidelines prompt :**
- Utiliser `web_render` quand `web_scrape` avec `renderJs=true` échoue ou quand un contrôle précis sur l'attente est nécessaire
- Nécessite Playwright installé (`npm install playwright` dans le dossier de l'extension)
- Retourne `html` par défaut pour la consommation LLM ; utiliser `markdown` pour du texte simplifié

### `speech_to_text`

Transcription vocale multi-provider. Auto-détecte le meilleur provider disponible.

**Providers :**

- **`whisper-local`** (défaut si installé) — 100% gratuit, offline, via [OpenAI Whisper](https://github.com/openai/whisper) open source
  - Installation : `pip install openai-whisper` + `ffmpeg` doit être dans le PATH
  - Modèles disponibles : `tiny`, `base`, `small`, `medium`, `large`, `turbo`
  - Rapide sur CPU moderne, qualité excellente
- **`azure`** (fallback cloud) — [Azure Speech Services](https://azure.microsoft.com/services/cognitive-services/speech-services/), tier **F0 gratuit** (5 heures/mois)
  - Nécessite une clé + région Azure
  - Très rapide, excellent pour le français

**Paramètres :**

| Paramètre | Type | Défaut | Description |
|-----------|------|--------|-------------|
| `filePath` | `string` | — | Chemin absolu vers le fichier audio |
| `language` | `string?` | `"fr-FR"` | Code langue (`fr-FR`, `en-US`, `es-ES`...) |
| `provider` | `"auto" \| "whisper-local" \| "azure"` | `"auto"` | Provider STT |
| `model` | `"tiny" \| "base" \| "small" \| "medium" \| "large" \| "turbo"` | `"base"` | Modèle Whisper (uniquement pour whisper-local) |

**Formats supportés :**
`.mp3`, `.wav`, `.ogg` (WhatsApp), `.webm` (Discord), `.m4a`, `.aac`, `.flac`

**Logique `auto` :**
1. Teste si Whisper local est installé → l'utilise
2. Sinon teste si Azure est configuré → fallback Azure
3. Sinon erreur explicative avec instructions d'installation

**Guidelines prompt :**
- Utiliser `speech_to_text` quand l'utilisateur fournit ou mentionne un fichier audio à transcrire
- WhatsApp envoie des `.ogg`, Discord des `.mp3`/`.wav`/`.webm`
- Ne pas demander de provider : l'agent laisse `auto` par défaut
- La langue par défaut est `fr-FR`

## Cache

Un cache local est activé par défaut (TTL : 60 minutes) pour les outils web uniquement :

- Clés basées sur `url + extract + selector + renderJs`
- Réduction des appels réseau répétés
- Purge automatique des entrées expirées au démarrage de session
- Cache stocké dans `~/.pi/agent/extensions/thetis-tool/cache/`

## Commandes

### `/thetis status`

Affiche l'état complet :
- Cache : fichiers et taille
- SerpAPI : configuré ou non (optionnel, pour Google/Yahoo/Yandex)
- Azure Speech : configuré ou non
- Whisper local : installé ou non
- STT provider et modèle actifs
- TTL et max length

### `/thetis clear-cache`

Vide immédiatement le cache local.

### `/thetis azure-key <key>`

Commande rapide pour enregistrer la clé Azure Speech sans passer par le wizard complet.

```bash
/thetis azure-key your-azure-speech-key-here
```

### `/thetis config`

Wizard interactif de configuration complète :
- Clé SerpAPI
- TTL du cache (minutes)
- Longueur max de scrape (caractères)
- **Clé Azure Speech**
- **Région Azure Speech** (défaut : `westeurope`)
- **Provider STT** (`auto` / `whisper-local` / `azure`)
- **Modèle Whisper** (`tiny` / `base` / `small` / `medium` / `large` / `turbo`)

## Configuration

Fichier `~/.pi/agent/extensions/thetis-tool/config.json` :

```json
{
  "serpApiKey": "...",
  "cacheTtlMinutes": 60,
  "maxScrapeLength": 15000,
  "azureSpeechKey": "...",
  "azureSpeechRegion": "westeurope",
  "sttProvider": "auto",
  "whisperModel": "base"
}
```

Variables d'environnement :
- `SERPAPI_KEY` — clé API SerpAPI (prioritaire sur le fichier de config)
- `AZURE_SPEECH_KEY` — clé Azure Speech (prioritaire sur le fichier)
- `AZURE_SPEECH_REGION` — région Azure (prioritaire sur le fichier)

## Stack

- TypeScript / TypeBox
- Cheerio (scraping statique)
- Playwright (rendu dynamique)
- Turndown (HTML → Markdown)
- @mozilla/readability (extraction article)
- DuckDuckGo scraping (recherche web gratuite, préférée)
- Bing scraping (fallback gratuit si DuckDuckGo bloque)
- SerpAPI (recherche web premium pour Google/Yahoo/Yandex)
- OpenAI Whisper (STT local, optionnel)
- Azure Speech Services (STT cloud, optionnel)

## Dépendances

```json
{
  "@mozilla/readability": "^0.5.0",
  "cheerio": "^1.0.0",
  "linkedom": "^0.18.4",
  "playwright": "^1.61.1",
  "turndown": "^7.2.0"
}
```

Peer dependencies :
- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-ai`
- `typebox`

**Dépendances optionnelles (externes) :**
- `openai-whisper` — `pip install openai-whisper` pour le STT local
- `ffmpeg` — doit être dans le PATH (requis par Whisper)

## Fichiers

```
thetis-tool/
├── index.ts         # Extension principale
├── package.json     # Dépendances + manifest pi-package
├── package-lock.json
├── README.md        # Documentation
└── .gitignore
```

## Licence

MIT — © Achille Robbe
