import { z } from "zod";

// -----------------------------
// AI Director + Asset Generation
// -----------------------------

const Color3Schema = z.tuple([
  z.number().finite().min(0).max(1),
  z.number().finite().min(0).max(1),
  z.number().finite().min(0).max(1)
]);

export const PaletteSchema = z
  .object({
    a: Color3Schema,
    b: Color3Schema,
    c: Color3Schema,
    d: Color3Schema
  })
  .strict();

export type Palette = z.infer<typeof PaletteSchema>;

export const AudioMappingSchema = z
  .object({
    source: z.enum([
      "energy",
      "beat",
      "bpm",
      "spectrum.bass",
      "spectrum.mid",
      "spectrum.treble",
      "genre",
      "mood",
      "section"
    ]),
    targetParam: z.string().min(1).max(64),
    curve: z.enum(["linear", "exp", "smoothstep"]),
    scale: z.number().finite(),
    bias: z.number().finite(),
    clamp: z.tuple([z.number().finite(), z.number().finite()])
  })
  .strict()
  .refine((v) => v.clamp[0] <= v.clamp[1], {
    message: "clamp[0] must be <= clamp[1]",
    path: ["clamp"]
  });

export type AudioMapping = z.infer<typeof AudioMappingSchema>;

export const VisualPatchSchema = z
  .object({
    presetId: z.string().min(1).max(64).optional(),
    palette: PaletteSchema.optional(),
    texturePrompt: z.string().min(1).max(600).optional(),
    params: z
      .record(
        z.union([
          z.number().finite(),
          z.boolean(),
          z.string().min(1).max(400)
        ])
      )
      .optional(),
    audioMappings: z.array(AudioMappingSchema).max(64).optional()
  })
  .strict();

export type VisualPatch = z.infer<typeof VisualPatchSchema>;

export const TransitionSpecSchema = z
  .object({
    type: z.enum(["cut", "crossfade", "beatCrossfade"]),
    durationMs: z.number().int().min(0).max(30_000).optional(),
    durationBeats: z.number().finite().min(0).max(128).optional()
  })
  .strict()
  .refine((v) => !(v.durationMs != null && v.durationBeats != null), {
    message: "Use either durationMs or durationBeats (not both)",
    path: ["durationMs"]
  });

export type TransitionSpec = z.infer<typeof TransitionSpecSchema>;

export const ApplySpecSchema = z
  .object({
    timing: z.enum(["now", "nextBeat", "beats", "nextDrop"]),
    beats: z.number().int().min(1).max(128).optional(),
    transition: TransitionSpecSchema
  })
  .strict()
  .refine((v) => (v.timing === "beats" ? typeof v.beats === "number" : true), {
    message: "beats is required when timing === 'beats'",
    path: ["beats"]
  });

export type ApplySpec = z.infer<typeof ApplySpecSchema>;

export const AssetSizeSchema = z.union([
  z.number().int().min(64).max(4096),
  z
    .object({
      w: z.number().int().min(64).max(4096),
      h: z.number().int().min(64).max(4096)
    })
    .strict()
]);

export type AssetSize = z.infer<typeof AssetSizeSchema>;

const AssetSafetySchema = z
  .object({
    allowNSFW: z.literal(false).default(false)
  })
  .strict()
  .default({ allowNSFW: false });

export const AssetRequestSchema = z
  .object({
    type: z.enum(["texture", "lut", "envmap", "keyframe"]),
    prompt: z.string().min(1).max(800),
    negativePrompt: z.string().min(1).max(800).optional(),
    size: AssetSizeSchema,
    seed: z.number().int().min(0).max(2 ** 31 - 1).optional(),
    format: z.enum(["png", "jpg", "webp"]),
    tiling: z.boolean().optional(),
    safety: AssetSafetySchema,
    modelHint: z.enum(["local", "cloud", "auto"]).optional()
  })
  .strict();

export type AssetRequest = z.infer<typeof AssetRequestSchema>;

export const VisualPlanSchema = z
  .object({
    assistantMessage: z.string().max(6000),
    patch: VisualPatchSchema,
    assetRequests: z.array(AssetRequestSchema).max(16),
    apply: ApplySpecSchema,
    confidence: z.number().finite().min(0).max(1),
    warnings: z.array(z.string().max(400)).max(32)
  })
  .strict();

export type VisualPlan = z.infer<typeof VisualPlanSchema>;

export const AiChatMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant"]),
    content: z.string().min(1).max(6000)
  })
  .strict();

export type AiChatMessage = z.infer<typeof AiChatMessageSchema>;

export const AiInterpretRequestSchema = z
  .object({
    messages: z.array(AiChatMessageSchema).min(1).max(64),
    state: z
      .object({
        currentPresetId: z.string().min(1).max(64).optional(),
        currentPalette: PaletteSchema.optional(),
        renderer: z.string().min(1).max(64).optional()
      })
      .strict()
      .optional(),
    capabilities: z.record(z.unknown()).optional(),
    musicContext: z.record(z.unknown()).optional()
  })
  .strict();

export type AiInterpretRequest = z.infer<typeof AiInterpretRequestSchema>;

export const AssetGenerateResponseSchema = z
  .object({
    ok: z.literal(true),
    jobId: z.string().min(1).max(128)
  })
  .strict();

export type AssetGenerateResponse = z.infer<typeof AssetGenerateResponseSchema>;

export const AssetJobStatusSchema = z
  .object({
    ok: z.literal(true),
    jobId: z.string().min(1).max(128),
    status: z.enum(["queued", "running", "done", "error"]),
    progress: z.number().finite().min(0).max(1).optional(),
    assetId: z.string().min(1).max(128).optional(),
    error: z.string().max(800).optional()
  })
  .strict();

export type AssetJobStatus = z.infer<typeof AssetJobStatusSchema>;

// -----------------------------
// Video Generation (Job-based)
// -----------------------------

export const VideoGenerateRequestSchema = z
  .object({
    prompt: z.string().min(1).max(800),
    negativePrompt: z.string().min(1).max(800).optional(),
    styleTags: z.array(z.string().min(1).max(64)).max(32).optional(),
    bpm: z.number().finite().positive().optional(),
    energy: z.number().finite().min(0).max(1).optional(),

    durationSec: z.number().finite().min(0.1).max(60),
    baseFps: z.number().int().min(1).max(30).default(4),
    fps: z.number().int().min(1).max(120).default(60),
    size: AssetSizeSchema,

    seed: z.number().int().min(0).max(2 ** 31 - 1).optional(),
    format: z.enum(["png", "jpg", "webp"]).default("jpg"),

    backendHint: z.enum(["auto", "procedural", "sdwebui"]).optional(),
    interpolation: z.enum(["blend", "rife", "film"]).default("blend"),
    upscaler: z.enum(["sharp", "esrgan", "swinir", "none"]).default("sharp")
  })
  .strict()
  .refine((v) => v.baseFps <= v.fps, {
    message: "baseFps must be <= fps",
    path: ["baseFps"]
  });

export type VideoGenerateRequest = z.infer<typeof VideoGenerateRequestSchema>;

export const VideoGenerateResponseSchema = z
  .object({
    ok: z.literal(true),
    jobId: z.string().min(1).max(128)
  })
  .strict();

export type VideoGenerateResponse = z.infer<typeof VideoGenerateResponseSchema>;

export const VideoFrameMetaSchema = z
  .object({
    frameId: z.string().min(1).max(128),
    index: z.number().int().min(0),
    timeMs: z.number().int().min(0),
    contentType: z.string().min(1).max(200),
    url: z.string().min(1).max(2000)
  })
  .strict();

export type VideoFrameMeta = z.infer<typeof VideoFrameMetaSchema>;

export const VideoJobStatusSchema = z
  .object({
    ok: z.literal(true),
    jobId: z.string().min(1).max(128),
    status: z.enum(["queued", "running", "done", "error"]),
    progress: z.number().finite().min(0).max(1).optional(),
    videoId: z.string().min(1).max(128).optional(),
    frames: z.array(VideoFrameMetaSchema).max(10_000).optional(),
    error: z.string().max(800).optional()
  })
  .strict();

export type VideoJobStatus = z.infer<typeof VideoJobStatusSchema>;

export function safeParseVisualPlan(input: unknown): VisualPlan | null {
  const parsed = VisualPlanSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function safeParseAiInterpretRequest(
  input: unknown
): AiInterpretRequest | null {
  const parsed = AiInterpretRequestSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export const BrainToVisualizerMessageSchema = z.union([
  z.object({
    event: z.literal("beat"),
    time: z.number(),
    phase: z.number().optional()
  }),
  z.object({
    bpm: z.number().finite().positive(),
    confidence: z.number().min(0).max(1)
  }),
  z.object({
    energy: z.number().min(0).max(1)
  }),
  z.object({
    genre: z.string(),
    prob: z.number().min(0).max(1)
  }),
  z.object({
    genre: z
      .object({
        top: z.string().min(1).max(64),
        prob: z.number().min(0).max(1),
        dist: z.record(z.number().min(0).max(1)).optional()
      })
      .strict()
  }),
  z.object({
    mood: z
      .object({
        valence: z.number().min(0).max(1),
        arousal: z.number().min(0).max(1),
        confidence: z.number().min(0).max(1)
      })
      .strict()
  }),
  z.object({
    vocal: z
      .object({
        present: z.boolean(),
        prob: z.number().min(0).max(1)
      })
      .strict()
  }),
  z.object({
    bands: z
      .object({
        bass: z.number().min(0).max(1),
        mid: z.number().min(0).max(1),
        treble: z.number().min(0).max(1)
      })
      .strict()
  }),
  z.object({
    section: z.string()
  }),
  z.object({
    spectrum: z.array(z.number().min(0)).min(8).max(256)
  }),
  z.object({
    silence: z.boolean()
  })
]);

export type BrainToVisualizerMessage = z.infer<
  typeof BrainToVisualizerMessageSchema
>;

export const VisualizerToBrainMessageSchema = z.union([
  z.object({
    type: z.literal("hello"),
    client: z.enum(["visualizer", "capture"])
  }),
  z.object({
    type: z.literal("config"),
    spectrumBins: z.number().int().min(8).max(256).optional()
  }),
  z.object({
    type: z.literal("pcm"),
    format: z.literal("f32le"),
    sampleRate: z.number().int().positive(),
    channels: z.number().int().min(1).max(2),
    frames: z.number().int().min(64).max(8192)
  })
]);

export type VisualizerToBrainMessage = z.infer<
  typeof VisualizerToBrainMessageSchema
>;

export function safeParseBrainToVisualizerMessage(
  input: unknown
): BrainToVisualizerMessage | null {
  const parsed = BrainToVisualizerMessageSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function safeParseVisualizerToBrainMessage(
  input: unknown
): VisualizerToBrainMessage | null {
  const parsed = VisualizerToBrainMessageSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

