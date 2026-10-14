// src/index.ts
import { Plugin } from "@opencode/plugin";

// src/quota.ts
var providers = ["openai", "github-copilot"];
var REQUEST_TIMEOUT_MS = 1e4;
var MAX_RESPONSE_BYTES = 64 * 1024;
var POLL_INTERVAL_MS = 6e4;
var ENDPOINTS = {
  openai: new URL("https://chatgpt.com/backend-api/wham/usage"),
  "github-copilot": new URL("https://api.github.com/copilot_internal/user")
};
var OPENAI_RESET_CREDITS_ENDPOINT = new URL("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits");
var cache = /* @__PURE__ */ new Map();
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function percentage(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return void 0;
  return Math.max(0, Math.min(100, value));
}
function ratioPercentage(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value * 100)) : void 0;
}
function numeric(value) {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : void 0;
}
function date(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return void 0;
    const parsed2 = new Date(value < 1e11 ? value * 1e3 : value);
    return Number.isNaN(parsed2.getTime()) ? void 0 : parsed2.toISOString();
  }
  if (typeof value !== "string") return void 0;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? void 0 : parsed.toISOString();
}
function relativeReset(seconds) {
  const value = numeric(seconds);
  return value === void 0 || value < 0 ? void 0 : new Date(Date.now() + value * 1e3).toISOString();
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
    const response = await fetch(endpoint, { headers, redirect: "error", signal: controller.signal });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "authentication failed" : `upstream http ${response.status}`);
    return await json(response);
  } finally {
    clearTimeout(timer);
  }
}
function openaiSpendControl(payload) {
  const control = payload.spend_control;
  if (!isRecord(control) || !isRecord(control.individual_limit)) return void 0;
  return control.individual_limit;
}
function openai(payload) {
  if (!isRecord(payload)) return [];
  const limits = isRecord(payload.rate_limit) ? payload.rate_limit : {};
  const windows = [
    ["primary_window", "5h"],
    ["secondary_window", "Weekly"]
  ].flatMap(([key, label]) => {
    const window2 = limits[key];
    if (!isRecord(window2)) return [];
    const used = percentage(window2.used_percent);
    const remaining = percentage(window2.remaining_percent) ?? (used === void 0 ? void 0 : 100 - used);
    if (remaining === void 0) return [];
    return [{ label, remaining, resetAt: date(window2.reset_at) ?? relativeReset(window2.reset_after_seconds) }];
  });
  const limit = openaiSpendControl(payload);
  if (limit) {
    const used = percentage(limit.used_percent);
    const remaining = percentage(limit.remaining_percent) ?? (used === void 0 ? void 0 : 100 - used);
    if (remaining !== void 0) {
      windows.push({ label: "Credits", remaining, resetAt: date(limit.reset_at) ?? relativeReset(limit.reset_after_seconds) });
    }
  }
  return windows;
}
function openaiFacts(payload) {
  if (!isRecord(payload)) return [];
  const limit = openaiSpendControl(payload);
  const remaining = numeric(limit?.remaining);
  const total = numeric(limit?.limit);
  if (remaining === void 0 || total === void 0) return [];
  const unit = typeof limit?.unit === "string" && limit.unit ? `${limit.unit}s` : "credits";
  return [`${Math.round(remaining).toLocaleString("en-US")} of ${Math.round(total).toLocaleString("en-US")} ${unit} left`];
}
function copilot(payload) {
  if (!isRecord(payload) || !isRecord(payload.quota_snapshots) || !isRecord(payload.quota_snapshots.premium_interactions)) return [];
  const premium = payload.quota_snapshots.premium_interactions;
  const byPercent = percentage(premium.percent_remaining);
  const entitlement = numeric(premium.entitlement);
  const rawRemaining = numeric(premium.remaining);
  const remaining = byPercent ?? (entitlement && rawRemaining !== void 0 ? ratioPercentage(rawRemaining / entitlement) : void 0);
  if (remaining === void 0) return [];
  return [{ label: "Premium", remaining, resetAt: date(payload.quota_reset_date) || date(premium.quota_reset_date_utc) }];
}
function parseQuota(provider, payload) {
  if (provider === "openai") return openai(payload);
  return copilot(payload);
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
async function quota(provider, loadAuth) {
  const label = provider === "github-copilot" ? "Copilot" : "OpenAI";
  const previous = cache.get(provider);
  if (previous && Date.now() - previous.snapshot.checkedAt < POLL_INTERVAL_MS) return previous.promise || { ...previous.snapshot, freshness: "cached" };
  if (previous?.promise) return previous.promise;
  const promise = (async () => {
    const auth = await loadAuth(provider).catch(() => void 0);
    if (!auth?.access) return { provider, label, status: "unavailable", freshness: "live", checkedAt: Date.now(), windows: [], note: "OAuth authentication unavailable" };
    if (auth.expires && auth.expires <= Date.now()) return { provider, label, status: "unavailable", freshness: "live", checkedAt: Date.now(), windows: [], note: "OAuth authentication expired" };
    try {
      const payload = await request(provider, auth);
      const windows = parseQuota(provider, payload);
      const facts = provider === "openai" ? openaiFacts(payload) : [];
      return windows.length > 0 ? { provider, label, status: "ok", freshness: "live", checkedAt: Date.now(), windows, facts: facts.length > 0 ? facts : void 0 } : provider === "openai" && noOpenAIQuota(payload) ? {
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
  const snapshot2 = await promise;
  if (snapshot2.status === "ok" || snapshot2.status === "unsupported") cache.set(provider, { snapshot: snapshot2 });
  else cache.delete(provider);
  return snapshot2;
}

// src/rpc.ts
import { Rpc } from "@opencode/plugin/rpc";
var window = {
  type: "object",
  properties: {
    label: { type: "string" },
    remaining: { type: "number" },
    resetAt: { type: "string" }
  },
  required: ["label", "remaining"],
  additionalProperties: false
};
var snapshot = {
  type: "object",
  properties: {
    provider: { type: "string", enum: ["openai", "github-copilot"] },
    label: { type: "string" },
    status: { type: "string", enum: ["ok", "unavailable", "unsupported", "error"] },
    freshness: { type: "string", enum: ["live", "cached"] },
    checkedAt: { type: "number" },
    windows: { type: "array", items: window },
    note: { type: "string" }
  },
  required: ["provider", "label", "status", "freshness", "checkedAt", "windows"],
  additionalProperties: false
};
var QuotaRpc = Rpc.define({
  id: "lmasaya.opencode-provider-quota",
  methods: {
    snapshots: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: { snapshots: { type: "array", items: snapshot } },
        required: ["snapshots"],
        additionalProperties: false
      }
    }
  },
  events: {}
});

// src/index.ts
function display({ facts: _facts, ...snapshot2 }) {
  return snapshot2;
}
var index_default = Plugin.define({
  id: "lmasaya.opencode-provider-quota",
  async setup(ctx) {
    const loadAuth = async (provider) => {
      const connection = await ctx.integration.connection.active(provider);
      if (!connection) return void 0;
      const credential = await ctx.integration.connection.resolve(connection);
      if (credential?.type !== "oauth") return void 0;
      const accountID = credential.metadata?.accountID;
      return {
        access: credential.access,
        expires: credential.expires,
        accountId: typeof accountID === "string" ? accountID : void 0
      };
    };
    await ctx.rpc.register(QuotaRpc, {
      snapshots: async () => ({
        snapshots: (await Promise.all(providers.map((provider) => quota(provider, loadAuth)))).map(display)
      })
    });
  }
});
export {
  index_default as default
};
