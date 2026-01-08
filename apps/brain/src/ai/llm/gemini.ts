import type { AiChatMessage, AiInterpretRequest, VisualPlan } from "@audviz/protocol";
import { VisualPlanSchema } from "@audviz/protocol";
import { generateText } from "ai";
import { createGeminiLanguageModel } from "./gemini-model.js";

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === "object" && !Array.isArray(v));
}

function clampNum(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function clampInt(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, Math.trunc(v)));
}

function normalizeColor3(v: unknown): [number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const nums = v.map((x) =>
    typeof x === "number" && Number.isFinite(x) ? clampNum(x, 0, 1) : null
  );
  if (nums.some((x) => x == null)) return null;
  return nums as [number, number, number];
}

function normalizePlanLike(input: unknown): unknown {
  if (!isRecord(input)) return input;
  const v = input as Record<string, unknown>;

  const assistantMessage =
    typeof v.assistantMessage === "string" ? v.assistantMessage.slice(0, 6000) : "";

  const confidenceRaw = v.confidence;
  const confidence =
    typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)
      ? clampNum(confidenceRaw, 0, 1)
      : 0.5;

  const warnings = Array.isArray(v.warnings)
    ? v.warnings
        .filter((w) => typeof w === "string")
        .map((w) => w.slice(0, 400))
        .slice(0, 32)
    : [];

  const patch = (() => {
    if (!isRecord(v.patch)) return {};
    const p = v.patch as Record<string, unknown>;
    const out: Record<string, unknown> = {};

    if (typeof p.presetId === "string" && p.presetId.trim()) {
      out.presetId = p.presetId.trim().slice(0, 64);
    }

    const palette = isRecord(p.palette) ? (p.palette as Record<string, unknown>) : null;
    if (palette) {
      const a = normalizeColor3(palette.a);
      const b = normalizeColor3(palette.b);
      const c = normalizeColor3(palette.c);
      const d = normalizeColor3(palette.d);
      if (a && b && c && d) out.palette = { a, b, c, d };
    }

    if (typeof p.texturePrompt === "string" && p.texturePrompt.trim()) {
      out.texturePrompt = p.texturePrompt.trim().slice(0, 600);
    }

    if (isRecord(p.params)) {
      const params: Record<string, number | boolean | string> = {};
      for (const [k, val] of Object.entries(p.params)) {
        if (!k.trim()) continue;
        if (typeof val === "number" && Number.isFinite(val)) params[k] = val;
        else if (typeof val === "boolean") params[k] = val;
        else if (typeof val === "string" && val.trim()) params[k] = val.slice(0, 400);
      }
      if (Object.keys(params).length) out.params = params;
    }

    if (Array.isArray(p.audioMappings)) {
      const allowedSources = new Set([
        "energy",
        "beat",
        "bpm",
        "spectrum.bass",
        "spectrum.mid",
        "spectrum.treble",
        "genre",
        "mood",
        "section"
      ]);
      const allowedCurves = new Set(["linear", "exp", "smoothstep"]);

      const audioMappings = p.audioMappings
        .filter(isRecord)
        .slice(0, 64)
        .map((m) => {
          const mm = m as Record<string, unknown>;
          const source = typeof mm.source === "string" ? mm.source : "";
          const targetParam =
            typeof mm.targetParam === "string" ? mm.targetParam.trim() : "";
          const curve = typeof mm.curve === "string" ? mm.curve : "";
          const scale = mm.scale;
          const bias = mm.bias;
          const clamp = Array.isArray(mm.clamp) ? mm.clamp : null;
          const c0 = clamp?.[0];
          const c1 = clamp?.[1];

          if (!allowedSources.has(source)) return null;
          if (!targetParam) return null;
          if (!allowedCurves.has(curve)) return null;
          if (typeof scale !== "number" || !Number.isFinite(scale)) return null;
          if (typeof bias !== "number" || !Number.isFinite(bias)) return null;
          if (
            typeof c0 !== "number" ||
            !Number.isFinite(c0) ||
            typeof c1 !== "number" ||
            !Number.isFinite(c1) ||
            c0 > c1
          ) {
            return null;
          }

          return {
            source,
            targetParam: targetParam.slice(0, 64),
            curve,
            scale,
            bias,
            clamp: [c0, c1]
          };
        })
        .filter(Boolean);

      if (audioMappings.length) out.audioMappings = audioMappings;
    }

    return out;
  })();

  const assetRequests = (() => {
    if (!Array.isArray(v.assetRequests)) return [];
    const allowedTypes = new Set(["texture", "lut", "envmap", "keyframe"]);
    const allowedFormats = new Set(["png", "jpg", "webp"]);
    const allowedModelHints = new Set(["local", "cloud", "auto"]);

    const normSize = (size: unknown) => {
      if (typeof size === "number" && Number.isFinite(size)) return clampInt(size, 64, 4096);
      if (isRecord(size)) {
        const wRaw = size.w;
        const hRaw = size.h;
        if (
          typeof wRaw === "number" &&
          Number.isFinite(wRaw) &&
          typeof hRaw === "number" &&
          Number.isFinite(hRaw)
        ) {
          return { w: clampInt(wRaw, 64, 4096), h: clampInt(hRaw, 64, 4096) };
        }
      }
      return 768;
    };

    return v.assetRequests
      .filter(isRecord)
      .slice(0, 16)
      .map((r) => {
        const rr = r as Record<string, unknown>;
        const type = typeof rr.type === "string" ? rr.type : "";
        if (!allowedTypes.has(type)) return null;

        const prompt = typeof rr.prompt === "string" ? rr.prompt.trim().slice(0, 800) : "";
        if (!prompt) return null;

        const formatRaw = typeof rr.format === "string" ? rr.format : "";
        const format = allowedFormats.has(formatRaw) ? formatRaw : "png";

        const out: Record<string, unknown> = {
          type,
          prompt,
          size: normSize(rr.size),
          format,
          safety: { allowNSFW: false }
        };

        if (typeof rr.negativePrompt === "string" && rr.negativePrompt.trim()) {
          out.negativePrompt = rr.negativePrompt.trim().slice(0, 800);
        }
        if (typeof rr.seed === "number" && Number.isFinite(rr.seed)) {
          out.seed = clampInt(rr.seed, 0, 2 ** 31 - 1);
        }
        if (typeof rr.tiling === "boolean") out.tiling = rr.tiling;
        if (typeof rr.modelHint === "string" && allowedModelHints.has(rr.modelHint)) {
          out.modelHint = rr.modelHint;
        }

        return out;
      })
      .filter(Boolean) as unknown[];
  })();

  const apply = (() => {
    const DEFAULT = {
      timing: "nextBeat",
      transition: { type: "beatCrossfade", durationBeats: 2 }
    } as const;

    if (!isRecord(v.apply)) return DEFAULT;

    const a = v.apply as Record<string, unknown>;
    const timing = typeof a.timing === "string" ? a.timing : "";
    const timingOk =
      timing === "now" || timing === "nextBeat" || timing === "beats" || timing === "nextDrop";

    const out: Record<string, unknown> = {
      timing: timingOk ? timing : DEFAULT.timing
    };

    if (out.timing === "beats") {
      const beatsRaw = a.beats;
      const beats =
        typeof beatsRaw === "number" && Number.isFinite(beatsRaw) ? clampInt(beatsRaw, 1, 128) : 4;
      out.beats = beats;
    }

    const t = isRecord(a.transition) ? (a.transition as Record<string, unknown>) : null;
    const type = typeof t?.type === "string" ? t.type : "";
    const typeOk = type === "cut" || type === "crossfade" || type === "beatCrossfade";
    const transition: Record<string, unknown> = {
      type: typeOk ? type : DEFAULT.transition.type
    };

    const durationMsRaw = t?.durationMs;
    const durationBeatsRaw = t?.durationBeats;
    const durationMs =
      typeof durationMsRaw === "number" && Number.isFinite(durationMsRaw)
        ? clampInt(durationMsRaw, 0, 30_000)
        : null;
    const durationBeats =
      typeof durationBeatsRaw === "number" && Number.isFinite(durationBeatsRaw)
        ? clampNum(durationBeatsRaw, 0, 128)
        : null;

    if (durationMs != null && durationBeats != null) {
      if (transition.type === "beatCrossfade") transition.durationBeats = durationBeats;
      else transition.durationMs = durationMs;
    } else if (durationMs != null) {
      transition.durationMs = durationMs;
    } else if (durationBeats != null) {
      transition.durationBeats = durationBeats;
    } else if (transition.type === "beatCrossfade") {
      transition.durationBeats = DEFAULT.transition.durationBeats;
    }

    out.transition = transition;
    return out;
  })();

  return {
    assistantMessage,
    patch,
    assetRequests,
    apply,
    confidence,
    warnings
  };
}

function systemPrompt(ctx: {
  state?: AiInterpretRequest["state"];
  capabilities?: AiInterpretRequest["capabilities"];
  musicContext?: AiInterpretRequest["musicContext"];
}) {
  return [
    "You are the AI Director for a live DJ visualizer.",
    "Return ONLY a single JSON object that matches the VisualPlan schema.",
    "",
    "Hard rules:",
    "- Output raw JSON only (no markdown, no code fences).",
    "- Do not invent preset IDs: use only capabilities.presets[].id.",
    "- Only use params keys listed in capabilities.paramSchema[].key and keep values within each key's min/max.",
    "- assetRequests: keep <= 2 items, prefer type 'texture' unless asked otherwise.",
    "- safety.allowNSFW must be false.",
    "- confidence must be 0..1, warnings is an array of strings.",
    "- If timing is 'beats', include a positive integer 'beats'.",
    "- apply must NOT contain a 'safety' key.",
    "- apply.transition is REQUIRED and must be an object like { type: 'beatCrossfade', durationBeats: 2 }.",
    "- apply.timing must be a STRING: 'now' | 'nextBeat' | 'beats' | 'nextDrop' (not an object).",
    "- Do NOT include a top-level 'safety' key. Only assetRequests[*].safety is allowed.",
    "",
    "Required top-level keys (include even if empty):",
    "- assistantMessage (string)",
    "- patch (object, can be {})",
    "- assetRequests (array, can be [])",
    "- apply (object)",
    "- confidence (number 0..1)",
    "- warnings (array, can be [])",
    "",
    "Minimal valid apply example:",
    "{ \"timing\": \"nextBeat\", \"transition\": { \"type\": \"beatCrossfade\", \"durationBeats\": 2 } }",
    "",
    "Minimal valid VisualPlan example:",
    JSON.stringify(
      {
        assistantMessage: "Switch to tunnel vibes on the next beat.",
        patch: { presetId: "tunnel" },
        assetRequests: [],
        apply: {
          timing: "nextBeat",
          transition: { type: "beatCrossfade", durationBeats: 2 }
        },
        confidence: 0.7,
        warnings: []
      },
      null,
      2
    ),
    "",
    "Context JSON:",
    JSON.stringify(ctx)
  ].join("\n");
}

function toModelMessages(messages: AiChatMessage[]) {
  return messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role,
      content: m.content
    })) as Array<{ role: "user" | "assistant"; content: string }>;
}

function stripCodeFences(text: string) {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.replace(/^```[a-z0-9]*\s*/i, "");
  }
  if (t.endsWith("```")) {
    t = t.replace(/```$/i, "");
  }
  return t.trim();
}

function extractFirstJsonObject(text: string) {
  const s = stripCodeFences(text);
  const start = s.indexOf("{");
  if (start < 0) throw new Error("No JSON object found");

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < s.length; i++) {
    const ch = s[i];

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
      inString = true;
      continue;
    }

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }

  throw new Error("Unterminated JSON object");
}

function shortPreview(text: string, maxLen = 900) {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= maxLen) return t;
  return `${t.slice(0, maxLen)}…`;
}

export async function interpretWithGemini(req: AiInterpretRequest): Promise<VisualPlan> {
  const apiKey =
    (process.env.GEMINI_API_KEY ?? "").trim() ||
    (process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "").trim();
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");

  const system = systemPrompt({
    state: req.state,
    capabilities: req.capabilities,
    musicContext: req.musicContext
  });

  // Keep a conservative default that is supported on the public v1beta API.
  const modelId = (process.env.GEMINI_MODEL ?? "gemini-3-flash-preview").trim();
  const baseURL = (process.env.GEMINI_BASE_URL ?? "").trim() || undefined;
  const timeoutMs = Number(process.env.GEMINI_TIMEOUT_MS ?? 45_000);

  const model = createGeminiLanguageModel({ apiKey, baseURL, modelId });

  const runOnce = async (repair?: { badOutput: unknown; error: string }) => {
    const abortSignal = AbortSignal.timeout(
      Number.isFinite(timeoutMs) ? timeoutMs : 10_000
    );
    const repairSystem = repair
      ? `${system}\n\nThe previous output was invalid. Return ONLY valid JSON for VisualPlan.\nError: ${repair.error}\nInvalid output:\n${JSON.stringify(repair.badOutput)}`
      : system;

    try {
      const result = await generateText({
        model,
        system: repairSystem,
        messages: toModelMessages(req.messages),
        temperature: 0.3,
        maxOutputTokens: 2048,
        maxRetries: 1,
        abortSignal
      });

      return result.text;
    } catch (err) {
      const e = err as any;
      const name = typeof e?.name === "string" ? e.name : "";
      const msg = typeof e?.message === "string" ? e.message : String(err);

      if (name === "TimeoutError" || name === "AbortError") {
        throw new Error(
          `Gemini request timed out after ${Number.isFinite(timeoutMs) ? timeoutMs : 10_000}ms (set GEMINI_TIMEOUT_MS)`,
          { cause: { modelId, baseURL, error: msg } }
        );
      }

      if (/models\/.+ is not found|not supported for generateContent|Call ListModels/i.test(msg)) {
        throw new Error(
          `Gemini model "${modelId}" is not available on v1beta generateContent (try GEMINI_MODEL="gemini-3-flash-preview")`,
          { cause: { modelId, baseURL, error: msg } }
        );
      }

      throw err;
    }
  };

  const firstText = await runOnce();

  const parseText = (text: string) => {
    const extracted = extractFirstJsonObject(text);
    const parsed = JSON.parse(extracted) as unknown;
    return VisualPlanSchema.parse(normalizePlanLike(parsed));
  };

  try {
    return parseText(firstText);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const secondText = await runOnce({
      badOutput: { preview: shortPreview(firstText), raw: firstText.slice(0, 20_000) },
      error: errorMsg
    });
    try {
      return parseText(secondText);
    } catch (err2) {
      const errorMsg2 = err2 instanceof Error ? err2.message : String(err2);
      throw new Error(
        `Gemini interpret failed after 2 attempts: ${errorMsg2}`,
        {
          cause: {
            modelId,
            baseURL: baseURL ?? "https://generativelanguage.googleapis.com/v1beta",
            firstAttemptPreview: shortPreview(firstText),
            secondAttemptPreview: shortPreview(secondText),
            firstAttemptError: errorMsg,
            secondAttemptError: errorMsg2
          }
        }
      );
    }
  }
}
