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
export {
  QuotaRpc
};
