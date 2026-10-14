// src/tui.ts
import { createElement, insert, setProp } from "@opentui/solid";
import { Plugin } from "@opencode/plugin/tui";
import { getOwner, onCleanup, runWithOwner } from "solid-js";

// src/quota.ts
var providers = ["openai", "github-copilot"];
var MAX_RESPONSE_BYTES = 64 * 1024;
var ENDPOINTS = {
  openai: new URL("https://chatgpt.com/backend-api/wham/usage"),
  "github-copilot": new URL("https://api.github.com/copilot_internal/user")
};
var OPENAI_RESET_CREDITS_ENDPOINT = new URL("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits");
function formatReset(resetAt) {
  if (!resetAt) return "reset unknown";
  const minutes = Math.round((new Date(resetAt).getTime() - Date.now()) / 6e4);
  if (minutes <= 0) return "reset due";
  if (minutes < 60) return `resets in ${minutes}m`;
  if (minutes < 24 * 60) return `resets in ${Math.round(minutes / 60)}h`;
  return `resets ${new Date(resetAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
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

// src/tui.ts
function el(tag, props = {}, children = []) {
  const node = createElement(tag);
  for (const [key, value] of Object.entries(props)) setProp(node, key, value);
  insert(node, children);
  return node;
}
function tone(context, snapshot2) {
  return snapshot2.status === "ok" ? context.theme.text.base : context.theme.text.muted;
}
function providerColor() {
  return "#ffffff";
}
function bar(context, snapshot2, remaining) {
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
function card(context, snapshot2) {
  const windows = snapshot2.windows.slice(0, 2);
  const singleWindow = windows.length === 1;
  const children = [el("text", { fg: tone(context, snapshot2) }, [el("b", {}, [snapshot2.label]), singleWindow ? [" ", ...bar(context, snapshot2, windows[0].remaining)] : snapshot2.status === "ok" ? "" : `  ${snapshot2.note ?? snapshot2.status}`])];
  if (singleWindow) {
    children.push(el("text", { fg: context.theme.text.muted }, [formatReset(windows[0].resetAt)]));
  } else for (const window2 of windows) {
    children.push(el("text", { fg: tone(context, snapshot2) }, [window2.label.padEnd(8), " ", ...bar(context, snapshot2, window2.remaining)]));
    children.push(el("text", { fg: context.theme.text.muted }, [formatReset(window2.resetAt)]));
  }
  if (snapshot2.status === "ok" && snapshot2.note) children.push(el("text", { fg: context.theme.text.muted }, [snapshot2.note]));
  return el("box", { flexDirection: "column", width: "100%", gap: 0, paddingBottom: 1 }, children);
}
function failed(provider) {
  return { provider, label: provider === "github-copilot" ? "Copilot" : "OpenAI", status: "error", freshness: "live", checkedAt: Date.now(), windows: [], note: "quota refresh failed" };
}
function sidebar(context) {
  const rpc = context.client.rpc(QuotaRpc);
  const owner = getOwner();
  const cards = el("box", { flexDirection: "column", width: "100%", gap: 0 }, [el("text", { fg: context.theme.text.muted }, ["Loading quota..."])]);
  const root = el("box", { flexDirection: "column", width: "100%", gap: 0, paddingTop: 1, paddingRight: 1 }, [el("text", { fg: context.theme.text.muted }, [el("b", {}, ["QUOTA"])]), cards]);
  const snapshots = /* @__PURE__ */ new Map();
  let disposed = false;
  let retryTimer;
  const render = () => {
    if (disposed) return;
    runWithOwner(owner, () => {
      const rendered = providers.flatMap((provider) => {
        const snapshot2 = snapshots.get(provider);
        return snapshot2 ? [card(context, snapshot2)] : [];
      });
      insert(cards, null);
      insert(cards, rendered.length > 0 ? rendered : el("text", { fg: context.theme.text.muted }, ["Loading quota..."]));
    });
  };
  const retrySoon = () => {
    if (retryTimer || disposed) return;
    retryTimer = setTimeout(() => {
      retryTimer = void 0;
      refresh();
    }, 5e3);
  };
  const refresh = () => {
    void rpc.snapshots({}).then((result) => {
      const list = result.snapshots;
      if (!Array.isArray(list)) throw new Error("unexpected quota response");
      for (const snapshot2 of list) snapshots.set(snapshot2.provider, snapshot2);
      render();
      if (list.some((snapshot2) => snapshot2.status === "error")) retrySoon();
    }).catch(() => {
      for (const provider of providers) snapshots.set(provider, failed(provider));
      render();
      retrySoon();
    });
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
var tui_default = Plugin.define({
  id: "lmasaya.opencode-provider-quota.tui",
  setup(context) {
    return context.ui.slot({ append: "sidebar.content", render: () => sidebar(context) });
  }
});
export {
  tui_default as default
};
