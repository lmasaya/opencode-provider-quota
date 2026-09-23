// src/tui.ts
import { createElement, insert, setProp } from "@opentui/solid";
import { getOwner, onCleanup, runWithOwner } from "solid-js";

// src/quota.ts
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
var REQUEST_TIMEOUT_MS = 1e4;
var MAX_RESPONSE_BYTES = 64 * 1024;
var POLL_INTERVAL_MS = 6e4;
var ENDPOINTS = {
  openai: new URL("https://chatgpt.com/backend-api/wham/usage"),
  "github-copilot": new URL("https://api.github.com/copilot_internal/user"),
  anthropic: new URL("https://api.anthropic.com/api/oauth/usage")
};
var OPENAI_RESET_CREDITS_ENDPOINT = new URL("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits");
var cache = /* @__PURE__ */ new Map();
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function percentage(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return void 0;
  const normalized = value > 0 && value <= 1 ? value * 100 : value;
  return Math.max(0, Math.min(100, normalized));
}
function date(value) {
  if (typeof value !== "string" && typeof value !== "number") return void 0;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? void 0 : parsed.toISOString();
}
function authPath() {
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "auth.json");
}
async function loadAuth(provider) {
  try {
    const parsed = JSON.parse(await readFile(authPath(), "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed[provider])) return void 0;
    const auth = parsed[provider];
    return auth.type === "oauth" ? auth : void 0;
  } catch {
    return void 0;
  }
}
async function json(response) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw new Error("response too large");
  const text = await response.text();
  if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error("response too large");
  return JSON.parse(text);
}
async function request(provider, auth, endpoint = ENDPOINTS[provider]) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers = { Accept: "application/json" };
    if (provider === "github-copilot") {
      headers.Authorization = `token ${auth.access}`;
      headers["User-Agent"] = "GitHubCopilotChat/0.35.0";
      headers["Editor-Version"] = "vscode/1.107.0";
      headers["Editor-Plugin-Version"] = "copilot-chat/0.35.0";
      headers["Copilot-Integration-Id"] = "vscode-chat";
    } else {
      headers.Authorization = `Bearer ${auth.access}`;
    }
    if (provider === "openai" && auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId;
    if (provider === "anthropic") headers["anthropic-beta"] = "oauth-2025-04-20";
    const response = await fetch(endpoint, { headers, redirect: "error", signal: controller.signal });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "authentication failed" : `upstream http ${response.status}`);
    return await json(response);
  } finally {
    clearTimeout(timer);
  }
}
function openai(payload) {
  if (!isRecord(payload) || !isRecord(payload.rate_limit)) return [];
  const limits = payload.rate_limit;
  return [
    ["primary_window", "5h"],
    ["secondary_window", "Weekly"]
  ].flatMap(([key, label]) => {
    const window = limits[key];
    if (!isRecord(window)) return [];
    const used = percentage(window.used_percent);
    const remaining = percentage(window.remaining_percent) ?? (used === void 0 ? void 0 : 100 - used);
    if (remaining === void 0) return [];
    const resetAt = date(window.reset_at) || (typeof window.reset_after_seconds === "number" ? new Date(Date.now() + window.reset_after_seconds * 1e3).toISOString() : void 0);
    return [{ label, remaining, resetAt }];
  });
}
function copilot(payload) {
  if (!isRecord(payload) || !isRecord(payload.quota_snapshots) || !isRecord(payload.quota_snapshots.premium_interactions)) return [];
  const premium = payload.quota_snapshots.premium_interactions;
  const byPercent = percentage(premium.percent_remaining);
  const entitlement = typeof premium.entitlement === "number" ? premium.entitlement : void 0;
  const rawRemaining = typeof premium.remaining === "number" ? premium.remaining : void 0;
  const remaining = byPercent ?? (entitlement && rawRemaining !== void 0 ? percentage(rawRemaining / entitlement) : void 0);
  if (remaining === void 0) return [];
  return [{ label: "Premium", remaining, resetAt: date(payload.quota_reset_date) || date(premium.quota_reset_date_utc) }];
}
function anthropic(payload) {
  if (!isRecord(payload)) return [];
  return [
    ["five_hour", "5h"],
    ["seven_day", "Weekly"],
    ["seven_day_sonnet", "Sonnet 7d"],
    ["seven_day_opus", "Opus 7d"]
  ].flatMap(([key, label]) => {
    const window = payload[key];
    if (!isRecord(window)) return [];
    const used = percentage(window.utilization);
    return used === void 0 ? [] : [{ label, remaining: 100 - used, resetAt: date(window.resets_at) }];
  });
}
function parseQuota(provider, payload) {
  if (provider === "openai") return openai(payload);
  if (provider === "github-copilot") return copilot(payload);
  return anthropic(payload);
}
function noOpenAIQuota(payload) {
  return isRecord(payload) && payload.rate_limit === null && payload.additional_rate_limits === null;
}
function resetCreditFact(payload) {
  if (!isRecord(payload) || typeof payload.available_count !== "number" || !Number.isFinite(payload.available_count)) return void 0;
  return `Reset credits: ${Math.max(0, Math.floor(payload.available_count))} available`;
}
function errorNote(error) {
  if (error instanceof Error && (error.name === "AbortError" || /aborted|abort/i.test(error.message))) return "request interrupted; retrying";
  return error instanceof Error ? error.message : "quota request failed";
}
async function quota(provider, anthropicEnabled2) {
  const label = provider === "github-copilot" ? "Copilot" : provider === "anthropic" ? "Claude" : "OpenAI";
  if (provider === "anthropic" && !anthropicEnabled2) return { provider, label, status: "unsupported", freshness: "live", checkedAt: Date.now(), windows: [], note: "disabled: unofficial endpoint" };
  const previous = cache.get(provider);
  if (previous && Date.now() - previous.snapshot.checkedAt < POLL_INTERVAL_MS) return previous.promise || { ...previous.snapshot, freshness: "cached" };
  if (previous?.promise) return previous.promise;
  const promise = (async () => {
    const auth = await loadAuth(provider);
    if (!auth?.access) return { provider, label, status: "unavailable", freshness: "live", checkedAt: Date.now(), windows: [], note: "OAuth authentication unavailable" };
    if (auth.expires && auth.expires <= Date.now()) return { provider, label, status: "unavailable", freshness: "live", checkedAt: Date.now(), windows: [], note: "OAuth authentication expired" };
    try {
      const payload = await request(provider, auth);
      const windows = parseQuota(provider, payload);
      return windows.length > 0 ? { provider, label, status: "ok", freshness: "live", checkedAt: Date.now(), windows } : provider === "openai" && noOpenAIQuota(payload) ? {
        provider,
        label,
        status: "ok",
        freshness: "live",
        checkedAt: Date.now(),
        windows: [],
        facts: [resetCreditFact(await request(provider, auth, OPENAI_RESET_CREDITS_ENDPOINT).catch(() => void 0))].filter((fact) => Boolean(fact)),
        note: "no active metered quota reported"
      } : { provider, label, status: "error", freshness: "live", checkedAt: Date.now(), windows: [], note: "quota response changed" };
    } catch (error) {
      return { provider, label, status: "error", freshness: "live", checkedAt: Date.now(), windows: [], note: errorNote(error) };
    }
  })();
  cache.set(provider, { snapshot: previous?.snapshot || { provider, label, status: "unavailable", freshness: "live", checkedAt: 0, windows: [] }, promise });
  const snapshot = await promise;
  if (snapshot.status === "ok" || snapshot.status === "unsupported") cache.set(provider, { snapshot });
  else cache.delete(provider);
  return snapshot;
}
function formatReset(resetAt) {
  if (!resetAt) return "reset unknown";
  const minutes = Math.round((new Date(resetAt).getTime() - Date.now()) / 6e4);
  if (minutes <= 0) return "reset due";
  if (minutes < 60) return `resets in ${minutes}m`;
  if (minutes < 24 * 60) return `resets in ${Math.round(minutes / 60)}h`;
  return `resets ${new Date(resetAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
}

// src/tui.ts
var providers = ["openai", "github-copilot", "anthropic"];
var anthropicEnabled = process.env.OPENCODE_QUOTA_ENABLE_ANTHROPIC === "1";
function el(tag, props = {}, children = []) {
  const node = createElement(tag);
  for (const [key, value] of Object.entries(props)) setProp(node, key, value);
  insert(node, children);
  return node;
}
function tone(api, snapshot) {
  return snapshot.status === "ok" ? api.theme.current.text : api.theme.current.textMuted;
}
function providerColor() {
  return "#ffffff";
}
function bar(api, snapshot, remaining) {
  const width = 16;
  const percent = `${Math.round(remaining)}%`;
  const filled = Math.round(remaining / 100 * width);
  const before = Math.max(0, Math.floor((width - percent.length) / 2));
  const after = width - before - percent.length;
  const color = providerColor();
  const segment = (start, length) => {
    const colored = Math.max(0, Math.min(length, filled - start));
    return [
      colored > 0 ? el("span", { style: { bg: color } }, [" ".repeat(colored)]) : void 0,
      length - colored > 0 ? el("span", {}, [" ".repeat(length - colored)]) : void 0
    ].filter(Boolean);
  };
  return ["[", ...segment(0, before), el("span", { style: { fg: "#000000", bg: color } }, [el("b", {}, [percent])]), ...segment(before + percent.length, after), "]"];
}
function card(api, snapshot) {
  const windows = snapshot.windows.slice(0, 2);
  const singleWindow = windows.length === 1;
  const children = [el("text", { fg: tone(api, snapshot) }, [el("b", {}, [snapshot.label]), singleWindow ? [" ", ...bar(api, snapshot, windows[0].remaining)] : snapshot.status === "ok" ? "" : `  ${snapshot.note ?? snapshot.status}`])];
  if (singleWindow) {
    children.push(el("text", { fg: api.theme.current.textMuted }, [formatReset(windows[0].resetAt)]));
  } else for (const window of windows) {
    children.push(el("text", { fg: tone(api, snapshot) }, [window.label.padEnd(8), " ", ...bar(api, snapshot, window.remaining)]));
    children.push(el("text", { fg: api.theme.current.textMuted }, [formatReset(window.resetAt)]));
  }
  for (const fact of snapshot.facts ?? []) children.push(el("text", { fg: api.theme.current.textMuted }, [fact]));
  if (snapshot.status === "ok" && snapshot.note) children.push(el("text", { fg: api.theme.current.textMuted }, [snapshot.note]));
  return el("box", { flexDirection: "column", width: "100%", gap: 0, paddingBottom: 1 }, children);
}
var tui = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      sidebar_content() {
        const owner = getOwner();
        const cards = el("box", { flexDirection: "column", width: "100%", gap: 0 }, [el("text", { fg: api.theme.current.textMuted }, ["Loading quota..."])]);
        const root = el("box", { flexDirection: "column", width: "100%", gap: 0, paddingTop: 1, paddingRight: 1 }, [el("text", { fg: api.theme.current.textMuted }, [el("b", {}, ["QUOTA"])]), cards]);
        const snapshots = /* @__PURE__ */ new Map();
        let disposed = false;
        let retryTimer;
        const render = () => {
          if (disposed) return;
          runWithOwner(owner, () => {
            const rendered = providers.flatMap((provider) => {
              const snapshot = snapshots.get(provider);
              return snapshot ? [card(api, snapshot)] : [];
            });
            insert(cards, null);
            insert(cards, rendered.length > 0 ? rendered : el("text", { fg: api.theme.current.textMuted }, ["Loading quota..."]));
          });
        };
        const refresh = () => {
          for (const provider of providers) {
            void quota(provider, anthropicEnabled).then((snapshot) => {
              snapshots.set(provider, snapshot);
              render();
              if (snapshot.status === "error" && !retryTimer) {
                retryTimer = setTimeout(() => {
                  retryTimer = void 0;
                  refresh();
                }, 5e3);
              }
            }).catch(() => {
              snapshots.set(provider, { provider, label: provider === "github-copilot" ? "Copilot" : provider === "anthropic" ? "Claude" : "OpenAI", status: "error", freshness: "live", checkedAt: Date.now(), windows: [], note: "quota refresh failed" });
              render();
            });
          }
        };
        refresh();
        const interval = setInterval(refresh, 6e4);
        onCleanup(() => {
          disposed = true;
          clearInterval(interval);
          if (retryTimer) clearTimeout(retryTimer);
        });
        return root;
      }
    }
  });
};
var tui_default = { id: "lmasaya.opencode-quota", tui };
export {
  tui_default as default
};
