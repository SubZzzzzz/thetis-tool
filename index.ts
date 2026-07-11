import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  Container,
  DynamicBorder,
  SelectList,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { execSync, spawn } from "node:child_process";

/* ────────────────────────────────
   pi-ai compatibility patch
   ──────────────────────────────── */

/**
 * Patch pi-ai's anthropic-messages API to tolerate tools without parameters.
 *
 * MiniMax M3 via OpenCode Go uses the anthropic-messages API. pi-ai's
 * convertTools() crashes with "Cannot read properties of undefined (reading
 * 'properties')" when a tool has no parameters schema. This function patches
 * the installed pi-ai file so the fix survives pi updates.
 */
function findPiAiAnthropicMessagesPath(): string | undefined {
  // pi-ai is a dependency of pi-coding-agent, which is the process main script.
  // Use process.argv[1] to locate pi-coding-agent's node_modules.
  const mainScript = process.argv[1];
  if (mainScript) {
    try {
      const resolvedMain = fs.realpathSync(mainScript);
      let dir = path.dirname(resolvedMain);
      // Walk up a few levels looking for pi-ai inside pi-coding-agent's tree.
      for (let i = 0; i < 4; i++) {
        const candidate = path.join(
          dir,
          "node_modules",
          "@earendil-works",
          "pi-ai",
          "dist",
          "api",
          "anthropic-messages.js"
        );
        if (fs.existsSync(candidate)) {
          return candidate;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    } catch {
      // Ignore resolution errors and fall through.
    }
  }
  return undefined;
}

function patchPiAiAnthropicMessages(): void {
  try {
    const filePath = findPiAiAnthropicMessagesPath();
    if (!filePath) {
      console.error(
        "[thetis-tool] Could not locate pi-ai anthropic-messages.js"
      );
      return;
    }
    const content = fs.readFileSync(filePath, "utf8");
    const buggyLine = "const schema = tool.parameters;";
    if (!content.includes(buggyLine)) {
      return;
    }
    const patched = content.replace(
      buggyLine,
      "const schema = tool.parameters ?? { type: \"object\", properties: {} };"
    );
    fs.writeFileSync(filePath, patched, "utf8");
    console.log("[thetis-tool] Patched pi-ai anthropic-messages.js");
  } catch (err) {
    console.error(
      "[thetis-tool] Failed to patch pi-ai anthropic-messages.js:",
      err
    );
  }
}

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

/* ────────────────────────────────
   Sensitive Action Confirmation
   ──────────────────────────────── */

const CONFIRM_PATH = path.join(EXT_DIR, "confirm.json");

interface ConfirmConfig {
  enabled: boolean;
}

function loadConfirmConfig(): ConfirmConfig {
  if (!fs.existsSync(CONFIRM_PATH)) return { enabled: true };
  try {
    return JSON.parse(fs.readFileSync(CONFIRM_PATH, "utf8")) as ConfirmConfig;
  } catch {
    return { enabled: true };
  }
}

function saveConfirmConfig(cfg: ConfirmConfig): void {
  if (!fs.existsSync(EXT_DIR)) fs.mkdirSync(EXT_DIR, { recursive: true });
  fs.writeFileSync(CONFIRM_PATH, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

let confirmConfig: ConfirmConfig = loadConfirmConfig();

/** Patterns for destructive bash commands */
const DANGEROUS_BASH_PATTERNS = [
  { regex: /\brm\s+(-[rf]*|--+recursive)/i, reason: "Recursive file deletion (rm)" },
  { regex: /\bdd\s+/i, reason: "Low-level disk write (dd)" },
  { regex: /\bmkfs\./i, reason: "Filesystem formatting (mkfs)" },
  { regex: /\bsudo\b/i, reason: "Elevated privileges (sudo)" },
  { regex: /\bchmod\b.*777/i, reason: "Dangerous permission change (chmod 777)" },
  { regex: /\bchown\b.*root/i, reason: "Privilege escalation (chown root)" },
  { regex: />\s*\/dev\/(sd|hd|nvme|mmcblk)/i, reason: "Direct disk overwrite" },
  { regex: /\bcurl\b.*\|\s*(sh|bash|zsh)/i, reason: "Pipe from curl to shell (remote code execution)" },
  { regex: /\bwget\b.*\|\s*(sh|bash|zsh)/i, reason: "Pipe from wget to shell (remote code execution)" },
  { regex: /\bmv\s+.*\s+\/dev\/null/i, reason: "File sent to /dev/null" },
  { regex: /\b>:?\s*\/dev\/(sd|hd|nvme|mmcblk)/i, reason: "Disk overwrite via redirection" },
];

/**
 * Sensitive file paths for write/edit. Each entry is a contiguous sequence of
 * path segments that must match exactly somewhere in the target path. This
 * avoids false positives like "my_passwd_helper.ts" matching a /passwd regex.
 */
const SENSITIVE_PATH_PATTERNS: Array<{ segments: string[]; reason: string }> = [
  { segments: [".env"], reason: "Environment file (.env)" },
  { segments: [".env.local"], reason: "Local environment file" },
  { segments: [".env.production"], reason: "Production environment file" },
  { segments: [".env.development"], reason: "Development environment file" },
  { segments: [".env.test"], reason: "Test environment file" },
  { segments: [".ssh", "id_rsa"], reason: "SSH private key (RSA)" },
  { segments: [".ssh", "id_dsa"], reason: "SSH private key (DSA)" },
  { segments: [".ssh", "id_ecdsa"], reason: "SSH private key (ECDSA)" },
  { segments: [".ssh", "id_ed25519"], reason: "SSH private key (Ed25519)" },
  { segments: [".ssh", "authorized_keys"], reason: "SSH authorized_keys" },
  { segments: [".ssh", "known_hosts"], reason: "SSH known_hosts" },
  { segments: [".ssh", "config"], reason: "SSH config" },
  { segments: [".gnupg"], reason: "GnuPG directory" },
  { segments: [".aws", "credentials"], reason: "AWS credentials" },
  { segments: [".config", "gh", "hosts.yml"], reason: "GitHub CLI hosts" },
  { segments: [".netrc"], reason: "netrc credentials" },
  { segments: [".npmrc"], reason: "npm config" },
  { segments: [".pypirc"], reason: "PyPI config" },
  { segments: ["etc", "passwd"], reason: "/etc/passwd" },
  { segments: ["etc", "shadow"], reason: "/etc/shadow" },
  { segments: ["etc", "sudoers"], reason: "/etc/sudoers" },
  { segments: [".git", "config"], reason: "Git repository config" },
];

/** File or directory names that are sensitive wherever they appear in the path */
const SENSITIVE_SEGMENT_NAMES = new Set<string>([
  "node_modules",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
]);

function pathSegmentsMatch(segments: string[], pattern: string[]): boolean {
  if (pattern.length > segments.length) return false;
  for (let start = 0; start <= segments.length - pattern.length; start++) {
    let ok = true;
    for (let i = 0; i < pattern.length; i++) {
      if (segments[start + i] !== pattern[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

function isSensitivePath(filePath: string): { sensitive: boolean; reason?: string } {
  let normalized: string;
  try {
    normalized = path.resolve(filePath);
  } catch {
    return { sensitive: true, reason: "Invalid path" };
  }
  const segments = normalized.split(path.sep).filter((s) => s.length > 0);

  for (const p of SENSITIVE_PATH_PATTERNS) {
    if (pathSegmentsMatch(segments, p.segments)) {
      return { sensitive: true, reason: p.reason };
    }
  }
  for (const seg of segments) {
    if (SENSITIVE_SEGMENT_NAMES.has(seg)) {
      return { sensitive: true, reason: `Protected name: ${seg}` };
    }
  }
  return { sensitive: false };
}

function isSensitiveAction(
  toolName: string,
  input: any
): { sensitive: boolean; reason: string; details: string[] } {
  const details: string[] = [];
  let sensitive = false;
  let reason = "";

  switch (toolName) {
    case "bash": {
      const command: string = input.command ?? "";
      for (const p of DANGEROUS_BASH_PATTERNS) {
        if (p.regex.test(command)) {
          sensitive = true;
          reason = p.reason;
          break;
        }
      }
      details.push(`Command: ${command}`);
      break;
    }
    case "write": {
      const filePath: string = input.path ?? "";
      const check = isSensitivePath(filePath);
      if (check.sensitive) {
        sensitive = true;
        reason = check.reason!;
      }
      details.push(`File: ${filePath}`);
      break;
    }
    case "edit": {
      const filePath: string = input.path ?? "";
      const check = isSensitivePath(filePath);
      if (check.sensitive) {
        sensitive = true;
        reason = check.reason!;
      }
      details.push(`File: ${filePath}`);
      break;
    }
    // Les outils Thetis réseau/API (web_search, web_render, web_scrape,
    // speech_to_text) ne déclenchent PAS de wizard — seules les actions
    // réellement destructives (bash, write, edit sur fichiers sensibles)
    // sont protégées.
  }

  return { sensitive, reason, details };
}

async function confirmActionWizard(
  ctx: ExtensionContext,
  toolName: string,
  reason: string,
  details: string[]
): Promise<boolean> {
  if (!ctx.hasUI) return false;

  // Mode TUI : wizard overlay riche avec détails
  if (ctx.mode === "tui") {
    const result = await ctx.ui.custom<"accept" | "reject" | null>(
      (tui, theme, _kb, done) => {
        const container = new Container();

        container.addChild(new DynamicBorder((s: string) => theme.fg("warning", s)));
        container.addChild(
          new Text(theme.fg("warning", theme.bold(`⚠️  Action sensible détectée`)), 1, 0)
        );
        container.addChild(new Text(theme.fg("accent", `Outil : ${toolName}`), 1, 0));
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("error", reason), 1, 0));
        container.addChild(new Spacer(1));

        for (const detail of details) {
          container.addChild(new Text(theme.fg("muted", detail), 1, 0));
        }
        container.addChild(new Spacer(1));

        const items = [
          { value: "accept", label: "✅ Accepter", description: "Exécuter cette action" },
          { value: "reject", label: "❌ Refuser", description: "Annuler cette action" },
        ];

        const selectList = new SelectList(items, 2, {
          selectedPrefix: (t: string) => theme.fg("accent", t),
          selectedText: (t: string) => theme.fg("accent", t),
          description: (t: string) => theme.fg("muted", t),
          scrollInfo: (t: string) => theme.fg("dim", t),
          noMatch: (t: string) => theme.fg("warning", t),
        });
        selectList.onSelect = (item: any) => done(item.value as "accept" | "reject");
        selectList.onCancel = () => done(null);
        container.addChild(selectList);

        container.addChild(
          new Text(theme.fg("dim", "↑↓ naviguer • Entrée pour confirmer • Échap pour annuler"), 1, 0)
        );
        container.addChild(new DynamicBorder((s: string) => theme.fg("warning", s)));

        return {
          render: (w: number) => container.render(w),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            selectList.handleInput(data);
            tui.requestRender();
          },
        };
      },
      { overlay: true }
    );
    return result === "accept";
  }

  // Mode RPC / Gateway : select/confirm relayé au client distant
  const title = `⚠️ ${toolName} — ${reason}`;
  const body = details.length > 0 ? details.join("\n") : undefined;

  // confirm() est supporté en RPC ; select() aussi
  const ok = await ctx.ui.confirm(
    title,
    body ?? "Action sensible détectée. Autoriser l'exécution ?"
  );
  return ok;
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

interface WhisperCommand {
  cmd: string;
  prefixArgs: string[];
}

let whisperCommandInfo: WhisperCommand | null | undefined = undefined;

/**
 * Locate the Whisper CLI on this system. Caches the result.
 * Returns the executable name and any prefix args (e.g. ["-m", "whisper"]
 * for `python3 -m whisper`). Returns null if Whisper is not installed.
 */
function getWhisperCommand(): WhisperCommand | null {
  if (whisperCommandInfo !== undefined) return whisperCommandInfo;
  try {
    execSync("whisper --help", { stdio: "ignore" });
    whisperCommandInfo = { cmd: "whisper", prefixArgs: [] };
    return whisperCommandInfo;
  } catch {
    try {
      execSync("python3 -m whisper --help", { stdio: "ignore" });
      whisperCommandInfo = { cmd: "python3", prefixArgs: ["-m", "whisper"] };
      return whisperCommandInfo;
    } catch {
      whisperCommandInfo = null;
      return null;
    }
  }
}

function detectWhisper(): boolean {
  return getWhisperCommand() !== null;
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

/**
 * Validate an audio file path: must exist, be a regular file, and contain
 * no shell metacharacters. Resolves to absolute form. Throws on failure.
 *
 * Defence in depth: even though spawn() is called with shell:false below,
 * we still sanitise the path so that a future refactor cannot regress
 * into a command-injection vulnerability.
 */
function validateAudioFilePath(p: string): string {
  if (typeof p !== "string" || p.length === 0) {
    throw new Error("filePath must be a non-empty string");
  }
  if (p.length > 4096) {
    throw new Error(`filePath is too long (${p.length} chars, max 4096)`);
  }
  // Reject the most dangerous shell metacharacters. shell:false makes this
  // strictly belt-and-suspenders, but the cost is low and the safety win
  // is permanent.
  if (/[\x00;|`$\n\r&]/.test(p)) {
    throw new Error(
      `filePath contains forbidden characters: ${JSON.stringify(p)}`
    );
  }
  const resolved = path.resolve(p);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Audio file not found: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) {
    throw new Error(`Not a regular file: ${resolved}`);
  }
  return resolved;
}

async function transcribeWithWhisper(
  filePath: string,
  language?: string,
  model?: string,
  signal?: AbortSignal
): Promise<string> {
  const whisperInfo = getWhisperCommand();
  if (!whisperInfo) {
    throw new Error(
      "Whisper-local is not installed. Install with: pip install openai-whisper"
    );
  }
  const safePath = validateAudioFilePath(filePath);

  const lang = language && language !== "auto" ? language : "French";
  const whisperModel = model ?? config.whisperModel ?? "base";
  const outDir = path.join(EXT_DIR, "whisper_out");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // Whisper writes .txt next to the audio by default; we force --output_dir
  const args = [
    ...whisperInfo.prefixArgs,
    safePath,
    "--model", whisperModel,
    "--language", lang,
    "--output_dir", outDir,
    "--output_format", "txt",
    "--fp16", "False",
  ];

  return new Promise((resolve, reject) => {
    // shell:false is critical: it prevents command injection via filePath
    // or any other argument. All inputs are passed as discrete argv entries,
    // never concatenated into a shell string.
    const proc = spawn(whisperInfo.cmd, args, {
      cwd: EXT_DIR,
      shell: false,
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
  // Azure Speech conversation API caps payload around 25 MB. Reject larger
  // files up-front to avoid OOM on fs.readFileSync and a 413 from the API.
  const MAX_AZURE_AUDIO_BYTES = 25 * 1024 * 1024;
  const stat = fs.statSync(filePath);
  if (stat.size > MAX_AZURE_AUDIO_BYTES) {
    throw new Error(
      `Audio file too large for Azure Speech: ${(stat.size / 1024 / 1024).toFixed(1)} MB ` +
        `(max ${(MAX_AZURE_AUDIO_BYTES / 1024 / 1024).toFixed(0)} MB). ` +
        `Use a smaller file or transcribe with whisper-local.`
    );
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
   Web Search (DuckDuckGo scraping + SerpAPI fallback)
   ──────────────────────────────── */

async function webSearchSerpAPI(
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

async function webSearchBing(
  query: string,
  numResults: number,
  signal?: AbortSignal
): Promise<string> {
  const capped = Math.min(Math.max(1, numResults), 20);
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${capped}`;

  checkSignal(signal);
  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
    },
    signal,
  });
  checkSignal(signal);
  if (!res.ok) {
    throw new Error(`Bing search error ${res.status}: ${res.statusText}`);
  }
  const html = await res.text();
  const { load } = require("cheerio");
  const $ = load(html);

  const results: Array<{ title: string; link: string; snippet: string }> = [];
  $(".b_algo").each((_: any, el: any) => {
    const $el = $(el);
    const title = $el.find("h2 a").text().trim();
    let link = $el.find("h2 a").attr("href") ?? "";
    // Decode Bing redirect URLs
    if (link.includes("/ck/a?") && link.includes("u=")) {
      try {
        const u = new URL(link).searchParams.get("u");
        if (u && u.startsWith("a1")) {
          link = Buffer.from(u.slice(2), "base64").toString("utf8");
        }
      } catch {
        /* keep original link */
      }
    }
    const snippet = $el.find(".b_caption p").text().trim();
    if (title && link) {
      results.push({ title, link, snippet });
    }
  });

  if (results.length === 0) {
    return `No results found for "${query}".`;
  }

  const lines = [`Search: "${query}" (bing — free, no API key)`, ""];
  for (let i = 0; i < Math.min(results.length, capped); i++) {
    const r = results[i];
    lines.push(
      `${i + 1}. **${r.title}**\n   URL: ${r.link}\n   ${r.snippet || ""}`
    );
  }
  return lines.join("\n");
}

async function webSearchDuckDuckGo(
  query: string,
  numResults: number,
  signal?: AbortSignal
): Promise<string> {
  const capped = Math.min(Math.max(1, numResults), 20);
  const url = "https://lite.duckduckgo.com/lite/";

  checkSignal(signal);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: `q=${encodeURIComponent(query)}`,
    signal,
  });
  checkSignal(signal);
  if (!res.ok) {
    throw new Error(`DuckDuckGo search error ${res.status}: ${res.statusText}`);
  }
  const html = await res.text();

  // Detect CAPTCHA / anomaly block
  if (html.includes("anomaly-modal") || html.includes("bots use DuckDuckGo")) {
    throw new Error("DuckDuckGo blocked the request (CAPTCHA).");
  }

  const { load } = require("cheerio");
  const $ = load(html);

  const results: Array<{ title: string; link: string; snippet: string }> = [];
  $("table tr").each((_: any, row: any) => {
    const linkEl = $(row).find("a.result-link");
    if (linkEl.length) {
      const title = linkEl.text().trim();
      const link = linkEl.attr("href") ?? "";
      const snippetRow = $(row).next("tr");
      const snippet = snippetRow.find("td.result-snippet").text().trim();
      if (title && link) {
        results.push({ title, link, snippet });
      }
    }
  });

  if (results.length === 0) {
    throw new Error(`DuckDuckGo returned no results for "${query}".`);
  }

  const lines = [`Search: "${query}" (duckduckgo — free, no API key)`, ""];
  for (let i = 0; i < Math.min(results.length, capped); i++) {
    const r = results[i];
    lines.push(
      `${i + 1}. **${r.title}**\n   URL: ${r.link}\n   ${r.snippet || ""}`
    );
  }
  return lines.join("\n");
}

/* ────────────────────────────────
   Extension factory
   ──────────────────────────────── */

export default function thetisToolExtension(pi: ExtensionAPI) {
  // Apply pi-ai compatibility patch on extension load.
  patchPiAiAnthropicMessages();

  // Purge stale cache on every session start
  pi.on("session_start", async () => {
    config = loadConfig();
    confirmConfig = loadConfirmConfig();
    purgeStaleCache();
  });

  /* ─── Permission gate for sensitive actions ─── */
  pi.on("tool_call", async (event, ctx) => {
    if (!confirmConfig.enabled) return;

    const { sensitive, reason, details } = isSensitiveAction(
      event.toolName,
      event.input
    );
    if (!sensitive) return;

    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `Action sensible bloquée (pas d'UI pour confirmation) : ${reason}`,
      };
    }

    const ok = await confirmActionWizard(ctx, event.toolName, reason, details);
    if (!ok) {
      return { block: true, reason: "Action refusée par l'utilisateur" };
    }
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
      "Search the web and return a list of result titles, URLs, and snippets. DuckDuckGo scraping is used by default (free, no API key). For Google, Yahoo, or Yandex, a SerpAPI key is required.",
    promptSnippet:
      "Search the web for URLs and snippets on a topic",
    promptGuidelines: [
      "Use web_search when the user asks for current information, news, facts, or sources without providing a specific URL.",
      "Follow up with web_scrape to read the full content of the most relevant result(s).",
      "Default engine is DuckDuckGo (free). For Google/Yahoo/Yandex, configure a SerpAPI key via /thetis config or the SERPAPI_KEY env variable.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      engine: Type.Optional(
        StringEnum(
          ["google", "duckduckgo", "bing", "yahoo", "yandex"] as const,
          { description: "Search engine (default: duckduckgo)" }
        )
      ),
      numResults: Type.Optional(
        Type.Number({
          description: "Number of results to return (default 5, max 10)",
        })
      ),
    }),

    async execute(_toolCallId, params, signal) {
      const engine = params.engine ?? "duckduckgo";
      const numResults = params.numResults ?? 5;

      let result: string;
      if (engine === "duckduckgo") {
        try {
          result = await webSearchDuckDuckGo(params.query, numResults, signal);
        } catch (ddgErr: any) {
          // Fallback to Bing if DuckDuckGo blocks us
          result = await webSearchBing(params.query, numResults, signal);
          result = result.replace("(bing — free, no API key)", "(bing fallback — DuckDuckGo blocked)");
        }
      } else if (engine === "bing") {
        result = await webSearchBing(params.query, numResults, signal);
      } else {
        result = await webSearchSerpAPI(params.query, engine, numResults, signal);
      }

      return {
        content: [{ type: "text", text: result }],
        details: { engine, query: params.query },
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

      if (sub === "confirm" || sub === "confirmation") {
        const next = !confirmConfig.enabled;
        confirmConfig = { enabled: next };
        saveConfirmConfig(confirmConfig);
        ctx.ui.notify(
          `Confirmations d'actions sensibles : ${next ? "activées" : "désactivées"}.`,
          "info"
        );
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
          "SerpAPI key (optional, for google/yahoo/yandex):",
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
        `SerpAPI key : ${config.serpApiKey ? "✅ configured" : "❌ not set (duckduckgo + bing available)"}`,
        `Azure Speech : ${config.azureSpeechKey && config.azureSpeechRegion ? "✅ configured" : "❌ not set (speech_to_text disabled)"}`,
        `Whisper local : ${detectWhisper() ? "✅ installed" : "❌ not installed"}`,
        `STT provider : ${config.sttProvider ?? "auto"}`,
        `Whisper model : ${config.whisperModel ?? "base"}`,
        `Cache TTL : ${config.cacheTtlMinutes ?? 60} min`,
        `Max length : ${config.maxScrapeLength ?? 15000} chars`,
        ``,
        `Tools registered : web_scrape, web_search, web_render, speech_to_text`,
        `Confirmations sensibles (bash/write/edit) : ${confirmConfig.enabled ? "✅ activées" : "❌ désactivées"} (/thetis confirm)`,
        `Commands : /thetis status, /thetis clear-cache, /thetis config, /thetis azure-key, /thetis confirm`,
      ].join("\n");

      ctx.ui.notify(statusText, "info");
    },
  });
}
