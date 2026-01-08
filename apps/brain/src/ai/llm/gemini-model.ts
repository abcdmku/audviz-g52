import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult
} from "@ai-sdk/provider";

type GeminiModelOptions = {
  apiKey: string;
  modelId: string;
  baseURL?: string;
};

type GeminiErrorBody = {
  error?: { code?: number; message?: string; status?: string };
};

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v && typeof v === "object" && !Array.isArray(v));
}

function clampNum(v: unknown, lo: number, hi: number) {
  const n = typeof v === "number" && Number.isFinite(v) ? v : undefined;
  if (n == null) return undefined;
  return Math.max(lo, Math.min(hi, n));
}

function promptToGemini(options: LanguageModelV3CallOptions) {
  const systemTexts: string[] = [];
  const contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];

  for (const msg of options.prompt) {
    if (msg.role === "system") {
      systemTexts.push(msg.content);
      continue;
    }

    if (msg.role !== "user" && msg.role !== "assistant") continue;

    const parts = msg.content
      .map((p) => {
        if (p.type !== "text") return null;
        const t = p.text?.toString() ?? "";
        return t.trim() ? { text: t } : null;
      })
      .filter(Boolean) as Array<{ text: string }>;

    if (!parts.length) continue;

    contents.push({
      role: msg.role === "assistant" ? "model" : "user",
      parts
    });
  }

  const systemText = systemTexts.map((s) => s.trim()).filter(Boolean).join("\n");
  const systemInstruction = systemText ? { parts: [{ text: systemText }] } : undefined;

  return { systemInstruction, contents };
}

function mapFinishReason(raw: string | undefined) {
  if (!raw) return { unified: "other" as const, raw: undefined };
  const upper = raw.toUpperCase();
  if (upper === "STOP") return { unified: "stop" as const, raw };
  if (upper === "MAX_TOKENS") return { unified: "length" as const, raw };
  if (upper === "SAFETY" || upper === "RECITATION") return { unified: "content-filter" as const, raw };
  if (upper === "TOOL_CALLS" || upper === "TOOL") return { unified: "tool-calls" as const, raw };
  return { unified: "other" as const, raw };
}

export function createGeminiLanguageModel(opts: GeminiModelOptions): LanguageModelV3 {
  const baseURL =
    (opts.baseURL ?? "").trim().replace(/\/+$/, "") ||
    "https://generativelanguage.googleapis.com/v1beta";

  const modelId = opts.modelId.trim();
  if (!modelId) throw new Error("Gemini modelId is required");
  const apiKey = opts.apiKey.trim();
  if (!apiKey) throw new Error("Gemini apiKey is required");

  const doGenerate = async (
    options: LanguageModelV3CallOptions
  ): Promise<LanguageModelV3GenerateResult> => {
    const { systemInstruction, contents } = promptToGemini(options);
    if (!contents.length) throw new Error("Gemini: empty prompt");

    const generationConfig: Record<string, unknown> = {
      responseMimeType: "application/json"
    };

    const maxOutputTokens = clampNum(options.maxOutputTokens, 1, 8192);
    if (maxOutputTokens != null) generationConfig.maxOutputTokens = Math.floor(maxOutputTokens);
    const temperature = clampNum(options.temperature, 0, 2);
    if (temperature != null) generationConfig.temperature = temperature;
    const topP = clampNum(options.topP, 0, 1);
    if (topP != null) generationConfig.topP = topP;
    const topK = clampNum(options.topK, 0, 100);
    if (topK != null) generationConfig.topK = Math.floor(topK);
    if (options.stopSequences?.length) generationConfig.stopSequences = options.stopSequences;

    const body: Record<string, unknown> = {
      contents,
      generationConfig
    };
    if (systemInstruction) body.systemInstruction = systemInstruction;

    const res = await fetch(`${baseURL}/models/${encodeURIComponent(modelId)}:generateContent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
        ...(options.headers ?? {})
      },
      body: JSON.stringify(body),
      signal: options.abortSignal
    });

    const text = await res.text();
    const json = (() => {
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return null;
      }
    })();

    if (!res.ok) {
      const msg = isRecord(json)
        ? ((json as GeminiErrorBody).error?.message ?? text)
        : text;
      throw new Error(`Gemini ${res.status}: ${msg}`.trim());
    }

    const parsed = (json ?? {}) as GeminiResponse;
    const candidate = parsed.candidates?.[0];
    const outText =
      candidate?.content?.parts?.map((p) => p.text ?? "").join("")?.trim() ?? "";

    if (!outText) {
      throw new Error(
        `Gemini: empty response (finishReason=${candidate?.finishReason ?? "unknown"})`
      );
    }

    const usageRaw = parsed.usageMetadata;
    const inputTotal = usageRaw?.promptTokenCount;
    const outputTotal = usageRaw?.candidatesTokenCount;

    return {
      content: [{ type: "text", text: outText }],
      finishReason: mapFinishReason(candidate?.finishReason),
      usage: {
        inputTokens: { total: inputTotal, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: outputTotal, text: outputTotal, reasoning: undefined },
        raw: usageRaw as any
      },
      warnings: [],
      request: { body },
      response: { body: json ?? text }
    };
  };

  return {
    specificationVersion: "v3",
    provider: "gemini",
    modelId,
    supportedUrls: {},
    doGenerate,
    async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
      const result = await doGenerate(options);
      const text =
        result.content.find((c) => c.type === "text")?.text ?? "";
      const id = "t0";
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: "text-start", id });
          controller.enqueue({ type: "text-delta", id, delta: text });
          controller.enqueue({ type: "text-end", id });
          controller.close();
        }
      });

      return {
        stream,
        request: result.request,
        response: result.response?.headers ? { headers: result.response.headers } : undefined
      };
    }
  };
}
