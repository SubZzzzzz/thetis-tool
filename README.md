# thetis-tool

Extension **Pi Coding Agent** qui fournit 3 outils web :

- **`web_scrape`** — extraction statique de pages (HTML, texte, markdown, liens, readability)
- **`web_search`** — recherche web via SerpAPI (Google, DuckDuckGo, Bing, Yahoo, Yandex)
- **`web_render`** — rendu dynamique avec Playwright pour les SPA JS-heavy

## Installation

### Via `pi install` (recommandé)

```bash
pi install git:github.com/SubZzzzzz/thetis-tool
```

Ou en local temporaire (sans persister dans les settings) :

```bash
pi -e git:github.com/SubZzzzzz/thetis-tool
```

### Manuel

Copier ce dossier dans `~/.pi/agent/extensions/thetis-tool`, puis :

```bash
cd ~/.pi/agent/extensions/thetis-tool
npm install
```

Pour activer `web_search`, configure une clé SerpAPI :

```bash
/thetis config
```

Ou définis la variable d'environnement `SERPAPI_KEY`.

## Commandes

- `/thetis status` — affiche l'état du cache et de la config
- `/thetis clear-cache` — vide le cache local
- `/thetis config` — configure la clé API et les paramètres

## Stack

- TypeScript / TypeBox
- Cheerio (scraping statique)
- Playwright (rendu dynamique)
- Turndown (HTML → Markdown)
- @mozilla/readability (extraction article)
- SerpAPI (recherche web)
