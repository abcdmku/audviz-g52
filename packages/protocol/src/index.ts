import { z } from "zod";

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

