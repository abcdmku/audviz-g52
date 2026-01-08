import type { AssetRequest, Palette, VisualPlan, VisualPatch } from "@audviz/protocol";

const palettes: Record<string, Palette> = {
  neon: {
    a: [0.02, 0.04, 0.08],
    b: [0.0, 0.85, 1.0],
    c: [0.55, 0.25, 1.0],
    d: [1.0, 0.85, 0.2]
  },
  fire: {
    a: [0.08, 0.02, 0.01],
    b: [1.0, 0.25, 0.05],
    c: [1.0, 0.78, 0.12],
    d: [0.95, 0.95, 0.95]
  },
  ice: {
    a: [0.02, 0.04, 0.07],
    b: [0.2, 0.7, 1.0],
    c: [0.65, 0.95, 1.0],
    d: [0.9, 0.98, 1.0]
  },
  acid: {
    a: [0.03, 0.03, 0.02],
    b: [0.5, 1.0, 0.1],
    c: [1.0, 0.1, 0.7],
    d: [0.2, 0.9, 1.0]
  }
};

function hasAny(text: string, keys: string[]) {
  return keys.some((k) => text.includes(k));
}

function pickPresetId(prompt: string) {
  const p = prompt.toLowerCase();
  const noStrobe = hasAny(p, ["no strobe", "less strobe", "avoid strobe", "no flashing"]);

  if (hasAny(p, ["cathedral", "raymarch", "warp field", "temple", "portal"])) return "warp";
  if (hasAny(p, ["kaleido", "kaleidoscope", "mandala", "symmetry"])) return "kaleido";
  if (hasAny(p, ["nebula", "space", "cosmic", "starfield", "dreamy"])) return "nebula";
  if (hasAny(p, ["tunnel", "warp", "speed", "cyber", "neon"])) return "tunnel";
  if (!noStrobe && hasAny(p, ["triangle", "triangles", "geometric", "shapes", "polygon"]))
    return "strobeGeo";
  if (!noStrobe && hasAny(p, ["grid", "strobe", "glitch", "scanlines", "tech"]))
    return "strobeGrid";
  return "plasma";
}

function pickPalette(prompt: string): Palette | undefined {
  const p = prompt.toLowerCase();
  if (hasAny(p, ["fire", "lava", "volcano", "ember", "inferno"])) return palettes.fire;
  if (hasAny(p, ["ice", "glacier", "frost", "arctic"])) return palettes.ice;
  if (hasAny(p, ["neon", "cyber", "vapor", "synthwave"])) return palettes.neon;
  if (hasAny(p, ["acid", "rave", "psychedelic", "trippy"])) return palettes.acid;
  return undefined;
}

export function mapPromptToVisualPlan(prompt: string): VisualPlan {
  const presetId = pickPresetId(prompt);
  const palette = pickPalette(prompt);

  const patch: VisualPatch = {
    presetId,
    palette,
    texturePrompt: prompt.trim().length > 2 ? prompt.trim() : undefined
  };

  const texturePrompt = patch.texturePrompt
    ? `${patch.texturePrompt}, seamless tileable texture, high detail, cohesive pattern`
    : null;

  const assetRequests: AssetRequest[] = texturePrompt
    ? [
        {
          type: "texture",
          prompt: texturePrompt,
          size: 768,
          format: "png",
          tiling: true,
          safety: { allowNSFW: false },
          modelHint: "auto"
        }
      ]
    : [];

  let confidence = 0.5;
  if (presetId !== "plasma") confidence += 0.15;
  if (palette) confidence += 0.1;
  if (assetRequests.length) confidence += 0.05;
  confidence = Math.max(0, Math.min(1, confidence));

  const assistantMessage = [
    `Plan: switch to "${presetId}".`,
    palette ? "Apply a themed palette." : null,
    assetRequests.length ? "Generate a fresh seamless texture." : null
  ]
    .filter(Boolean)
    .join(" ");

  return {
    assistantMessage,
    patch,
    assetRequests,
    apply: { timing: "nextBeat", transition: { type: "beatCrossfade", durationBeats: 2 } },
    confidence,
    warnings: []
  };
}
