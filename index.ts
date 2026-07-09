import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { execSync, spawn } from "node:child_process";

/* ────────────────────────────────
   Paths & Config
   ──────────────────────────────── */

const EXT_DIR = path.join(homedir(), ".pi", "agent", "extensions", "thetis-tool");
const CACHE_DIR = path.join(EXT_DIR, "cache");
const CONFIG_PATH = path.join(EXT_DIR, "config.json");

interface ThetisConfig {
  serpApiKey?: string;
  cacheTtlMinutes?: number;
  maxScrapeLength?: number;
  azureSpeechKey?: string;
  azureSpeechRegion?: string;
  sttProvider?: "auto" | "whisper-local" | "azure";
  whisperModel?: "tiny" | "base" | "small" | "medium" | "large" | "turbo";
}

function loadConfig(): ThetisConfig {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as ThetisConfig;
  } catch {
    return {};
  }
}

function saveConfig(cfg: ThetisConfig): void {
  if (!fs.existsSync(EXT_DIR)) fs.mkdirSync(EXT_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

let config: ThetisConfig = loadConfig();

function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

/* ────────────────────────────────
   Cache helpers
   ──────────────────────────────── */

function cacheKey(
  url: string,
  extract: string,
  selector?: string,
  renderJs?: boolean
): string {
  const hash = createHash("sha256")
    .update(`${url}|${extract}|${selector ?? ""}|${!!renderJs}`)
    .digest("hex");
  return hash;
}

interface CacheEntry {
  url: string;
  extract: string;
  selector?: string;
  renderJs?: boolean;
  content: string;
  timestamp: number;
}

function getCacheEntry(key: string): CacheEntry | null {
  ensureCacheDir();
  const file = path.join(CACHE_DIR, `${key}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const entry = JSON.parse(fs.readFileSync(file, "utf8")) as CacheEntry;
    const ttl = (config.cacheTtlMinutes ?? 60) * 60 * 1000;
    if (Date.now() - entry.timestamp > ttl) {
      fs.unlinkSync(file);
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

function setCacheEntry(key: string, entry: CacheEntry): void {
  ensureCacheDir();
  fs.writeFileSync(
    path.join(CACHE_DIR, `${key}.json`),
    JSON.stringify(entry),
    "utf8"
  );
}

/* ────────────────────────────────
   Audio / STT helpers
   ──────────────────────────────── */

/* ────────────────────────────────
   Whisper local detection & helpers
   ──────────────────────────────── */

let whisperDetected: boolean | null = null;

function detectWhisper(): boolean {
  if (whisperDetected !== null) return whisperDetected;
  try {
    execSync("whisper --help", { stdio: "ignore" });
    whisperDetected = true;
    return true;
  } catch {
    try {
      execSync("python3 -m whisper --help", { stdio: "ignore" });
      whisperDetected = true;
      return true;
    } catch {
      whisperDetected = false;
      return false;
    }
  }
}

function detectAudioMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const map: Record<string, string> = {
    ".wav": "audio/wav",
    ".wave": "audio/wav",
    ".mp3": "audio/mp3",
    ".ogg": "audio/ogg",
    ".oga": "audio/ogg",
    ".webm": "audio/webm",
    ".weba": "audio/webm",
    ".m4a": "audio/mp4",
    ".mp4": "audio/mp4",
    ".aac": "audio/aac",
    ".flac": "audio/flac",
  };
  return map[ext] ?? "audio/wav";
}

async function transcribeWithWhisper(
  filePath: string,
  language?: string,
  model?: string,
  signal?: AbortSignal
): Promise<string> {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Audio file not found: ${filePath}`);
  }

  const whisperCmd = (() => {
    try {
      execSync("whisper --help", { stdio: "ignore" });
      return "whisper";
    } catch {
      return "python3 -m whisper";
    }
  })();

  const lang = language && language !== "auto" ? language : "French";
  const whisperModel = model ?? config.whisperModel ?? "base";
  const outDir = path.join(EXT_DIR, "whisper_out");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // Whisper writes .txt next to the audio by default; we force --output_dir
  const args = [
    filePath,
    "--model", whisperModel,
    "--language", lang,
    "--output_dir", outDir,
    "--output_format", "txt",
    "--fp16", "False",
  ];

  return new Promise((resolve, reject) => {
    const proc = spawn(whisperCmd.split(" ")[0], [...whisperCmd.split(" ").slice(1), ...args], {
      cwd: EXT_DIR,
      shell: whisperCmd.includes("python3") ? false : true,
    });

    let stderr = "";
    proc.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });

    proc.on("error", (err) => {
      reject(new Error(`Failed to run Whisper: ${err.message}. Install with: pip install openai-whisper`));
    });

    proc.on("close", (code) => {
      if (signal?.aborted) {
        reject(new Error("Transcription cancelled by user."));
        return;
      }
      if (code !== 0) {
        reject(new Error(`Whisper exited with code ${code}. stderr: ${stderr.slice(0, 500)}`));
        return;
      }
      // Whisper outputs basename.txt in outDir
      const base = path.basename(filePath, path.extname(filePath));
      const txtPath = path.join(outDir, `${base}.txt`);
      if (!fs.existsSync(txtPath)) {
        reject(new Error("Whisper did not produce output file."));
        return;
      }
      const text = fs.readFileSync(txtPath, "utf8").trim();
      // Cleanup
      try { fs.unlinkSync(txtPath); } catch {}
      resolve(text);
    });
  });
}

async function transcribeWithAzure(
  filePath: string,
  language?: string,
  signal?: AbortSignal
): Promise<string> {
  const key = config.azureSpeechKey ?? process.env.AZURE_SPEECH_KEY;
  const region = config.azureSpeechRegion ?? process.env.AZURE_SPEECH_REGION;
  if (!key || !region) {
    throw new Error(
      "Azure Speech credentials not configured. Set them via /thetis config or the /thetis azure-key command."
    );
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`Audio file not found: ${filePath}`);
  }

  const mime = detectAudioMimeType(filePath);
  const lang = language && language !== "auto" ? language : "fr-FR";
  const url =
    `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?` +
    `language=${encodeURIComponent(lang)}&format=simple&profanity=mask`;

  const audioBuffer = fs.readFileSync(filePath);

  if (signal?.aborted) throw new Error("Transcription cancelled by user.");

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": mime,
    },
    body: audioBuffer,
    signal,
  });

  if (signal?.aborted) throw new Error("Transcription cancelled by user.");

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Azure Speech error ${res.status}: ${text.slice(0, 500)}`);
  }

  const data = (await res.json()) as {
    RecognitionStatus?: string;
    DisplayText?: string;
  };

  if (data.RecognitionStatus !== "Success") {
    throw new Error(
      `Azure Speech recognition failed: ${data.RecognitionStatus ?? "Unknown error"}`
    );
  }

  return data.DisplayText ?? "";
}

function resolveSttProvider(requested?: "auto" | "whisper-local" | "azure"): "whisper-local" | "azure" {
  const req = requested ?? config.sttProvider ?? "auto";
  if (req === "whisper-local") {
    if (!detectWhisper()) {
      throw new Error(
        "Whisper-local requested but not installed. Run: pip install openai-whisper"
      );
    }
    return "whisper-local";
  }
  if (req === "azure") {
    const key = config.azureSpeechKey ?? process.env.AZURE_SPEECH_KEY;
    const region = config.azureSpeechRegion ?? process.env.AZURE_SPEECH_REGION;
    if (!key || !region) {
      throw new Error(
        "Azure requested but credentials missing. Set via /thetis azure-key or /thetis config."
      );
    }
    return "azure";
  }
  // auto
  if (detectWhisper()) return "whisper-local";
  const key = config.azureSpeechKey ?? process.env.AZURE_SPEECH_KEY;
  const region = config.azureSpeechRegion ?? process.env.AZURE_SPEECH_REGION;
  if (key && region) return "azure";
  throw new Error(
    "No STT provider available. Install Whisper (pip install openai-whisper) or configure Azure Speech via /thetis azure-key."
  );
}

/* ────────────────────────────────
   Cache helpers (suite)
   ──────────────────────────────── */

function clearCache(): { deleted: number } {
  ensureCacheDir();
  let deleted = 0;
  for (const entry of fs.readdirSync(CACHE_DIR, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".json")) {
      try {
        fs.unlinkSync(path.join(CACHE_DIR, entry.name));
        deleted++;
      } catch {}
    }
  }
  return { deleted };
}

function purgeStaleCache(): void {
  ensureCacheDir();
  const ttl = (config.cacheTtlMinutes ?? 60) * 60 * 1000;
  const now = Date.now();
  for (const entry of fs.readdirSync(CACHE_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(CACHE_DIR, entry.name);
    try {
      const raw = fs.readFileSync(file, "utf8");
      const data = JSON.parse(raw) as CacheEntry;
      if (now - data.timestamp > ttl) fs.unlinkSync(file);
    } catch {}
  }
}

function getCacheStats(): { files: number; sizeBytes: number } {
  ensureCacheDir();
  let files = 0;
  let sizeBytes = 0;
  for (const entry of fs.readdirSync(CACHE_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    files++;
    try {
      sizeBytes += fs.statSync(path.join(CACHE_DIR, entry.name)).size;
    } catch {}
  }
  return { files, sizeBytes };
}

/* ────────────────────────────────
   Turndown (HTML → Markdown)
   ──────────────────────────────── */

let turndownInstance: any = null;
function getTurndown() {
  if (!turndownInstance) {
    const TurndownService = require("turndown");
    turndownInstance = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      bulletListMarker: "-",
    });
    // Preserve line breaks inside code blocks
    turndownInstance.addRule("pre", {
      filter: ["pre"],
      replacement: (content: string) => {
        const trimmed = content.replace(/^\n+|\n+$/g, "");
        return "\n\n```\n" + trimmed + "\n```\n\n";
      },
    });
  }
  return turndownInstance;
}

/* ────────────────────────────────
   Utils
   ──────────────────────────────── */

function truncate(str: string, max: number): string {
  if (!str || str.length <= max) return str;
  const cut = str.lastIndexOf("\n", max);
  const end = cut > max * 0.8 ? cut : max;
  return str.slice(0, end) + `\n\n...[truncated, total ${str.length} chars]...`;
}

function checkSignal(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new Error("Scraping cancelled by user.");
  }
}

/* ────────────────────────────────
   Static scraping
   ──────────────────────────────── */

async function fetchHtml(url: string, signal?: AbortSignal): Promise<string> {
  checkSignal(signal);
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
    },
    signal,
  });
  checkSignal(signal);
  if (!res.ok) {
    throw new Error(
      `HTTP ${res.status} ${res.statusText} when fetching ${url}`
    );
  }
  const html = await res.text();
  checkSignal(signal);
  return html;
}

function scrapeWithCheerio(
  html: string,
  selector: string | undefined,
  extract: "text" | "markdown" | "html" | "links" | "readability"
): string {
  const { load } = require("cheerio");
  const $ = load(html);

  if (extract === "links") {
    const links: string[] = [];
    $("a").each((_: any, el: any) => {
      const href = $(el).attr("href");
      const text = $(el).text().trim();
      if (href) {
        try {
          const absolute = new URL(href, "https://example.com").href; // base will be replaced by caller if needed
          // We don't have the real base here easily, so we'll keep raw href
          // Actually caller can resolve later.
        } catch {}
        links.push(`- [${text || href}](${href})`);
      }
    });
    return links.join("\n") || "No links found.";
  }

  const root = selector ? $(selector) : $("body");
  if (selector && root.length === 0) {
    throw new Error(`Selector "${selector}" did not match any element.`);
  }

  if (extract === "html") {
    return root.html() ?? "";
  }
  if (extract === "text") {
    return root.text() ?? "";
  }
  if (extract === "markdown") {
    const rawHtml = root.html() ?? "";
    return getTurndown().turndown(rawHtml);
  }
  if (extract === "readability") {
    // Handled separately in caller
    return "";
  }
  return "";
}

function scrapeWithReadability(html: string): string {
  const { parseHTML } = require("linkedom");
  const { Readability } = require("@mozilla/readability");
  const { document } = parseHTML(html);
  const reader = new Readability(document);
  const article = reader.parse();
  if (!article) {
    throw new Error(
      "Readability could not parse article content from this page. The page may not be an article. Try extract='text' or 'html'."
    );
  }
  const parts: string[] = [];
  if (article.title) parts.push(`# ${article.title}\n`);
  if (article.byline) parts.push(`By ${article.byline}\n`);
  if (article.excerpt) parts.push(`> ${article.excerpt}\n`);
  parts.push(article.textContent ?? "");
  return parts.join("\n");
}

async function scrapeStatic(
  url: string,
  selector: string | undefined,
  extract: "text" | "markdown" | "html" | "links" | "readability",
  signal?: AbortSignal
): Promise<string> {
  const html = await fetchHtml(url, signal);
  if (extract === "readability") {
    return scrapeWithReadability(html);
  }
  return scrapeWithCheerio(html, selector, extract);
}

/* ────────────────────────────────
   Dynamic rendering (Playwright)
   ──────────────────────────────── */

async function scrapeDynamic(
  url: string,
  selector: string | undefined,
  waitFor: string | undefined,
  extract: "text" | "markdown" | "html",
  signal?: AbortSignal
): Promise<string> {
  checkSignal(signal);
  let playwright;
  try {
    playwright = await import("playwright");
  } catch {
    throw new Error(
      "Playwright is not installed. To enable JS rendering, run:\n  cd ~/.pi/agent/extensions/thetis-tool && npm install playwright\nThen reload with /reload."
    );
  }
  checkSignal(signal);

  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });

    if (waitFor) {
      const delay = parseInt(waitFor, 10);
      if (!isNaN(delay) && String(delay) === waitFor.trim()) {
        await page.waitForTimeout(delay);
      } else {
        await page.waitForSelector(waitFor, { timeout: 15000 });
      }
    }

    checkSignal(signal);

    let rawHtml: string;
    if (selector) {
      const el = await page.$(selector);
      if (!el) {
        throw new Error(`Selector "${selector}" did not match any element after rendering.`);
      }
      rawHtml = await el.innerHTML();
    } else {
      rawHtml = await page.content();
    }

    checkSignal(signal);

    // Re-use cheerio/turndown on the rendered HTML
    if (extract === "html") return rawHtml;
    const { load } = require("cheerio");
    const $ = load(rawHtml);
    const root = selector ? $(selector) : $("body");
    if (extract === "text") return root.text() ?? "";
    return getTurndown().turndown(root.html() ?? "");
  } finally {
    await browser.close();
  }
}

/* ────────────────────────────────
   Web Search (SerpAPI)
   ──────────────────────────────── */

async function webSearch(
  query: string,
  engine: string,
  numResults: number,
  signal?: AbortSignal
): Promise<string> {
  const apiKey = config.serpApiKey ?? process.env.SERPAPI_KEY;
  if (!apiKey) {
    throw new Error(
      "No SerpAPI key configured. Set it via /thetis config or the SERPAPI_KEY environment variable."
    );
  }
  const capped = Math.min(Math.max(1, numResults), 10);
  const url =
    `https://serpapi.com/search?engine=${encodeURIComponent(engine)}` +
    `&q=${encodeURIComponent(query)}` +
    `&num=${capped}` +
    `&api_key=${encodeURIComponent(apiKey)}`;

  checkSignal(signal);
  const res = await fetch(url, { signal });
  checkSignal(signal);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SerpAPI error ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();

  const results: Array<{
    title?: string;
    link?: string;
    snippet?: string;
    displayed_link?: string;
  }> = data.organic_results ?? [];

  if (results.length === 0) {
    return `No results found for "${query}".`;
  }

  const lines = [`Search: "${query}" (${engine})`, ""];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(
      `${i + 1}. **${r.title ?? "No title"}**` +
        `\n   URL: ${r.link ?? "N/A"}` +
        (r.displayed_link ? ` (${r.displayed_link})` : "") +
        (r.snippet ? `\n   ${r.snippet}` : "")
    );
  }
  return lines.join("\n");
}

/* ────────────────────────────────
   Extension factory
   ──────────────────────────────── */

export default function thetisToolExtension(pi: ExtensionAPI) {
  // Purge stale cache on every session start
  pi.on("session_start", async () => {
    config = loadConfig();
    purgeStaleCache();
  });

  /* ─── Tool: web_scrape ─── */
  pi.registerTool({
    name: "web_scrape",
    label: "Web Scrape",
    description:
      "Fetch a web page and extract content. Supports static pages (fast, default) and JavaScript-rendered pages (slower, via Playwright). Extraction modes: html (default for LLMs), text, markdown, links, or readability (article cleanup).",
    promptSnippet:
      "Fetch and extract content from a specific web URL",
    promptGuidelines: [
      "Use web_scrape when the user provides or mentions a specific URL to analyze.",
      "Use extract='html' by default so the LLM receives the full DOM structure.",
      "Use extract='readability' for articles, blogs, and documentation to get clean text without ads and navigation.",
      "Use extract='links' to discover outgoing URLs from a page.",
      "Set renderJs=true only if the page is known to be a dynamic SPA (React/Vue/Angular) and static fetch returns empty or useless content.",
      "If you need to discover relevant URLs first, use web_search before web_scrape.",
      "Respect maxLength to avoid context overflow; the default is 15000 characters.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "URL to scrape" }),
      selector: Type.Optional(
        Type.String({ description: "CSS selector to target a specific element (optional)" })
      ),
      extract: Type.Optional(
        StringEnum(
          ["text", "markdown", "html", "links", "readability"] as const,
          { description: "Extraction mode (default: html)" }
        )
      ),
      renderJs: Type.Optional(
        Type.Boolean({
          description:
            "If true, render the page in a headless browser (requires Playwright). Only for JS-heavy sites.",
        })
      ),
      maxLength: Type.Optional(
        Type.Number({ description: "Maximum characters to return (default 15000)" })
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const extract = params.extract ?? "html";
      const maxLen = params.maxLength ?? config.maxScrapeLength ?? 15000;
      const key = cacheKey(params.url, extract, params.selector, params.renderJs);
      const cached = getCacheEntry(key);
      if (cached) {
        return {
          content: [
            { type: "text", text: truncate(cached.content, maxLen) },
          ],
          details: { cached: true, url: params.url, extract },
        };
      }

      let content: string;
      if (params.renderJs) {
        content = await scrapeDynamic(
          params.url,
          params.selector,
          undefined,
          extract === "links" || extract === "readability"
            ? "text"
            : (extract as "text" | "markdown" | "html"),
          signal
        );
        if (extract === "readability") {
          // After dynamic render, try readability on the fully rendered HTML
          const { load } = require("cheerio");
          const $ = load(content); // scrapeDynamic returns text or markdown; not raw HTML here.
          // Actually, dynamic returns text/markdown/html. For readability we need raw HTML.
          // Let's do a dedicated dynamic render that returns raw HTML, then readability.
          content = await scrapeDynamic(params.url, params.selector, undefined, "html", signal);
          content = scrapeWithReadability(content);
        } else if (extract === "links") {
          content = await scrapeDynamic(params.url, params.selector, undefined, "html", signal);
          content = scrapeWithCheerio(content, params.selector, "links");
        }
      } else {
        content = await scrapeStatic(
          params.url,
          params.selector,
          extract,
          signal
        );
      }

      setCacheEntry(key, {
        url: params.url,
        extract,
        selector: params.selector,
        renderJs: params.renderJs,
        content,
        timestamp: Date.now(),
      });

      return {
        content: [{ type: "text", text: truncate(content, maxLen) }],
        details: {
          url: params.url,
          extract,
          selector: params.selector,
          renderJs: params.renderJs,
          length: content.length,
        },
      };
    },
  });

  /* ─── Tool: web_search ─── */
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web via SerpAPI and return a list of result titles, URLs, and snippets. Supports Google (default), DuckDuckGo, Bing, Yahoo, and Yandex.",
    promptSnippet:
      "Search the web for URLs and snippets on a topic",
    promptGuidelines: [
      "Use web_search when the user asks for current information, news, facts, or sources without providing a specific URL.",
      "Follow up with web_scrape to read the full content of the most relevant result(s).",
      "Requires a SerpAPI key configured via /thetis config or the SERPAPI_KEY env variable.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      engine: Type.Optional(
        StringEnum(
          ["google", "duckduckgo", "bing", "yahoo", "yandex"] as const,
          { description: "Search engine (default: google)" }
        )
      ),
      numResults: Type.Optional(
        Type.Number({
          description: "Number of results to return (default 5, max 10)",
        })
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const result = await webSearch(
        params.query,
        params.engine ?? "google",
        params.numResults ?? 5,
        signal
      );
      return {
        content: [{ type: "text", text: result }],
        details: { engine: params.engine ?? "google", query: params.query },
      };
    },
  });

  /* ─── Tool: web_render ─── */
  pi.registerTool({
    name: "web_render",
    label: "Web Render",
    description:
      "Render a JavaScript-heavy page in a headless browser (Playwright) and extract content. Use as a fallback when web_scrape with renderJs returns insufficient content, or when you need to wait for a specific element to appear. Returns html by default for LLM consumption.",
    promptSnippet:
      "Render a dynamic page with a headless browser and extract content",
    promptGuidelines: [
      "Use web_render when web_scrape with renderJs=true still fails or when you need precise control over waiting (selector or timeout).",
      "Only use if Playwright is installed (npm install playwright in the extension directory).",
      "Returns html by default so the LLM receives the full DOM structure; set extract='markdown' if you need simplified text.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "URL to render" }),
      selector: Type.Optional(
        Type.String({
          description: "CSS selector to extract from (default: whole page body)",
        })
      ),
      waitFor: Type.Optional(
        Type.String({
          description:
            "Wait for a CSS selector (e.g., '#content') or a delay in milliseconds (e.g., '2000') before extracting",
        })
      ),
      extract: Type.Optional(
        StringEnum(["text", "markdown", "html"] as const, {
          description: "Extraction mode (default: html)",
        })
      ),
      maxLength: Type.Optional(
        Type.Number({ description: "Maximum characters to return (default 15000)" })
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const maxLen = params.maxLength ?? config.maxScrapeLength ?? 15000;
      const extract = params.extract ?? "html";
      const content = await scrapeDynamic(
        params.url,
        params.selector,
        params.waitFor,
        extract,
        signal
      );
      return {
        content: [{ type: "text", text: truncate(content, maxLen) }],
        details: { url: params.url, selector: params.selector, waitFor: params.waitFor, extract },
      };
    },
  });

  /* ─── Tool: speech_to_text ─── */
  pi.registerTool({
    name: "speech_to_text",
    label: "Speech to Text",
    description:
      "Transcribe an audio file to text. Supports Whisper local (free, offline) and Azure Speech Services (cloud, free tier 5h/month). Auto-detects the best available provider.",
    promptSnippet: "Transcribe an audio file to text",
    promptGuidelines: [
      "Use speech_to_text when the user provides or mentions an audio file that needs to be transcribed.",
      "Supports audio from WhatsApp (.ogg), Discord (.mp3, .wav, .webm), and other common formats.",
      "Default provider is 'auto': prefers Whisper local if installed, otherwise falls back to Azure Speech.",
      "For Whisper local: install with 'pip install openai-whisper' and ensure ffmpeg is available.",
      "For Azure: configure key via /thetis azure-key. The F0 tier is free for up to 5 hours of audio per month.",
      "Default language is fr-FR; override with the language parameter if the audio is in another language (e.g. 'en-US').",
    ],
    parameters: Type.Object({
      filePath: Type.String({ description: "Absolute path to the audio file" }),
      language: Type.Optional(
        Type.String({
          description:
            "Language code (default: fr-FR). Examples: en-US, es-ES, de-DE. Use 'auto' for fr-FR fallback.",
        })
      ),
      provider: Type.Optional(
        StringEnum(["auto", "whisper-local", "azure"] as const, {
          description: "STT provider (default: auto — tries whisper-local first, then azure)",
        })
      ),
      model: Type.Optional(
        StringEnum(["tiny", "base", "small", "medium", "large", "turbo"] as const, {
          description: "Whisper model size (default: base). Only used with whisper-local.",
        })
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const provider = resolveSttProvider(params.provider);
      let text: string;
      if (provider === "whisper-local") {
        text = await transcribeWithWhisper(
          params.filePath,
          params.language,
          params.model,
          signal
        );
      } else {
        text = await transcribeWithAzure(
          params.filePath,
          params.language,
          signal
        );
      }
      return {
        content: [{ type: "text", text: text || "(no speech detected)" }],
        details: {
          filePath: params.filePath,
          language: params.language ?? "fr-FR",
          provider,
          model: provider === "whisper-local" ? (params.model ?? config.whisperModel ?? "base") : undefined,
        },
      };
    },
  });

  /* ─── Command: /thetis ─── */
  pi.registerCommand("thetis", {
    description: "Manage Thetis tools (status, cache, config)",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0]?.toLowerCase();

      if (sub === "clear-cache" || sub === "clear") {
        const { deleted } = clearCache();
        ctx.ui.notify(`Cleared ${deleted} cached item(s).`, "info");
        return;
      }

      if (sub === "azure-key") {
        const key = parts[1];
        if (!key) {
          ctx.ui.notify("Usage: /thetis azure-key <your-azure-speech-key>", "warning");
          return;
        }
        const newCfg: ThetisConfig = {
          ...config,
          azureSpeechKey: key.trim(),
        };
        saveConfig(newCfg);
        config = newCfg;
        ctx.ui.notify("Azure Speech key saved.", "success");
        return;
      }

      if (sub === "config") {
        if (!ctx.hasUI) {
          ctx.ui.notify(
            "Interactive config requires TUI or RPC mode. Edit the file directly:\n" +
              CONFIG_PATH,
            "warning"
          );
          return;
        }
        const key = await ctx.ui.input(
          "SerpAPI key (leave empty to keep current / disable search):",
          config.serpApiKey ?? ""
        );
        const ttlRaw = await ctx.ui.input(
          `Cache TTL in minutes [${config.cacheTtlMinutes ?? 60}]:`,
          String(config.cacheTtlMinutes ?? 60)
        );
        const maxLenRaw = await ctx.ui.input(
          `Default max scrape length [${config.maxScrapeLength ?? 15000}]:`,
          String(config.maxScrapeLength ?? 15000)
        );
        const azureKey = await ctx.ui.input(
          "Azure Speech key (leave empty to keep current / disable Azure STT):",
          config.azureSpeechKey ?? ""
        );
        const azureRegion = await ctx.ui.input(
          `Azure Speech region [${config.azureSpeechRegion ?? "westeurope"}]:`,
          config.azureSpeechRegion ?? "westeurope"
        );
        const sttProvider = await ctx.ui.input(
          `STT provider [${config.sttProvider ?? "auto"}] (auto / whisper-local / azure):`,
          config.sttProvider ?? "auto"
        );
        const whisperModel = await ctx.ui.input(
          `Whisper model [${config.whisperModel ?? "base"}] (tiny / base / small / medium / large / turbo):`,
          config.whisperModel ?? "base"
        );

        const newCfg: ThetisConfig = {
          ...config,
          serpApiKey: key.trim() || undefined,
          cacheTtlMinutes: parseInt(ttlRaw.trim(), 10) || 60,
          maxScrapeLength: parseInt(maxLenRaw.trim(), 10) || 15000,
          azureSpeechKey: azureKey.trim() || undefined,
          azureSpeechRegion: azureRegion.trim() || undefined,
          sttProvider: (sttProvider.trim() as ThetisConfig["sttProvider"]) || "auto",
          whisperModel: (whisperModel.trim() as ThetisConfig["whisperModel"]) || "base",
        };
        saveConfig(newCfg);
        config = newCfg;
        ctx.ui.notify("Thetis config saved.", "success");
        return;
      }

      // Default: status
      const stats = getCacheStats();
      const cacheText =
        stats.files === 0
          ? "Cache is empty."
          : `${stats.files} file(s), ${(stats.sizeBytes / 1024).toFixed(1)} KB`;

      const statusText = [
        `🔧 Thetis Tool Status`,
        ``,
        `Cache : ${cacheText}`,
        `SerpAPI key : ${config.serpApiKey ? "✅ configured" : "❌ not set (web_search disabled)"}`,
        `Azure Speech : ${config.azureSpeechKey && config.azureSpeechRegion ? "✅ configured" : "❌ not set (speech_to_text disabled)"}`,
        `Whisper local : ${detectWhisper() ? "✅ installed" : "❌ not installed"}`,
        `STT provider : ${config.sttProvider ?? "auto"}`,
        `Whisper model : ${config.whisperModel ?? "base"}`,
        `Cache TTL : ${config.cacheTtlMinutes ?? 60} min`,
        `Max length : ${config.maxScrapeLength ?? 15000} chars`,
        ``,
        `Tools registered : web_scrape, web_search, web_render, speech_to_text`,
        `Commands : /thetis status, /thetis clear-cache, /thetis config, /thetis azure-key`,
      ].join("\n");

      ctx.ui.notify(statusText, "info");
    },
  });
}
