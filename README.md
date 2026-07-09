# Thetis Tool Extension

Extension **Pi Coding Agent** qui fournit 3 outils web pour l'agent :

- **`web_scrape`** — extraction statique de pages (HTML, texte, markdown, liens, readability)
- **`web_search`** — recherche web via SerpAPI (Google, DuckDuckGo, Bing, Yahoo, Yandex)
- **`web_render`** — rendu dynamique avec Playwright pour les SPA JS-heavy

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

Pour activer `web_search`, configure une clé SerpAPI :

```bash
/thetis config
```

Ou définis la variable d'environnement `SERPAPI_KEY`.

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

Recherche web via SerpAPI. Retourne titres, URLs et snippets.

**Paramètres :**

| Paramètre | Type | Défaut | Description |
|-----------|------|--------|-------------|
| `query` | `string` | — | Requête de recherche |
| `engine` | `"google" \| "duckduckgo" \| "bing" \| "yahoo" \| "yandex"` | `"google"` | Moteur de recherche |
| `numResults` | `number?` | `5` | Nombre de résultats (max 10) |

**Guidelines prompt :**
- Utiliser `web_search` quand l'utilisateur demande des informations actuelles, news, faits ou sources sans fournir d'URL
- Suivre avec `web_scrape` pour lire le contenu complet des résultats les plus pertinents
- Nécessite une clé SerpAPI configurée via `/thetis config` ou `SERPAPI_KEY`

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

## Cache

Un cache local est activé par défaut (TTL : 60 minutes) :

- Clés basées sur `url + extract + selector + renderJs`
- Réduction des appels réseau répétés
- Purge automatique des entrées expirées au démarrage de session
- Cache stocké dans `~/.pi/agent/extensions/thetis-tool/cache/`

## Commandes

### `/thetis status`

Affiche l'état du cache et de la configuration :
- Nombre de fichiers en cache et taille totale
- État de la clé SerpAPI
- TTL et max length configurés

### `/thetis clear-cache`

Vide immédiatement le cache local.

### `/thetis config`

Wizard interactif de configuration :
- Clé SerpAPI
- TTL du cache (minutes)
- Longueur max de scrape (caractères)

La config est sauvegardée dans `~/.pi/agent/extensions/thetis-tool/config.json`.

## Configuration

Fichier `~/.pi/agent/extensions/thetis-tool/config.json` :

```json
{
  "serpApiKey": "...",
  "cacheTtlMinutes": 60,
  "maxScrapeLength": 15000
}
```

Variables d'environnement :
- `SERPAPI_KEY` — clé API SerpAPI (prioritaire sur le fichier de config)

## Stack

- TypeScript / TypeBox
- Cheerio (scraping statique)
- Playwright (rendu dynamique)
- Turndown (HTML → Markdown)
- @mozilla/readability (extraction article)
- SerpAPI (recherche web)

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
