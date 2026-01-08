import type { AiInterpretRequest, VisualPlan } from "@audviz/protocol";

function clamp(x: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, x));
}

function asArray(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null;
}

function extractPresetIds(capabilities: AiInterpretRequest["capabilities"]) {
  const presets = asArray((capabilities as any)?.presets);
  if (!presets) return null;
  const ids = new Set<string>();
  for (const p of presets) {
    const id = (p as any)?.id;
    if (typeof id === "string" && id.trim()) ids.add(id.trim());
  }
  return ids.size ? ids : null;
}

type ParamRange = { min: number; max: number };

function extractParamRanges(capabilities: AiInterpretRequest["capabilities"]): Record<string, ParamRange> {
  const schema = asArray((capabilities as any)?.paramSchema) ?? [];
  const out: Record<string, ParamRange> = {};
  for (const item of schema) {
    const key = (item as any)?.key;
    const min = (item as any)?.min;
    const max = (item as any)?.max;
    if (typeof key !== "string" || !key.trim()) continue;
    if (typeof min !== "number" || !Number.isFinite(min)) continue;
    if (typeof max !== "number" || !Number.isFinite(max)) continue;
    out[key.trim()] = { min, max };
  }
  return out;
}

function extractAssetTypes(capabilities: AiInterpretRequest["capabilities"]) {
  const types = asArray((capabilities as any)?.assetTypes);
  if (!types) return null;
  const set = new Set<string>();
  for (const t of types) {
    if (typeof t === "string" && t.trim()) set.add(t.trim());
  }
  return set.size ? set : null;
}

export function sanitizeVisualPlan(plan: VisualPlan, req: AiInterpretRequest): VisualPlan {
  const warnings = [...(plan.warnings ?? [])];

  const allowedPresets = extractPresetIds(req.capabilities);
  const paramRanges = extractParamRanges(req.capabilities);
  const allowedAssetTypes = extractAssetTypes(req.capabilities);

  const patch = { ...plan.patch };
  if (patch.presetId && allowedPresets && !allowedPresets.has(patch.presetId)) {
    warnings.push(`Unknown presetId "${patch.presetId}" removed.`);
    delete patch.presetId;
  }

  if (patch.params) {
    const next: Record<string, number | boolean | string> = {};
    for (const [k, v] of Object.entries(patch.params)) {
      const range = paramRanges[k];
      if (!range) continue;
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      next[k] = clamp(v, range.min, range.max);
    }
    patch.params = Object.keys(next).length ? next : undefined;
  }

  let assetRequests = plan.assetRequests ?? [];
  if (allowedAssetTypes) {
    assetRequests = assetRequests.filter((r) => allowedAssetTypes.has(r.type));
  }
  assetRequests = assetRequests.slice(0, 2).map((r) => ({
    ...r,
    safety: { allowNSFW: false }
  }));

  return {
    ...plan,
    patch,
    assetRequests,
    warnings
  };
}

