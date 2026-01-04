import type { Palette, PresetId } from "./presets.js";

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

export function mapPromptToPreset(prompt: string): {
  presetId: PresetId;
  palette?: Palette;
  texturePrompt?: string;
} {
  const p = prompt.toLowerCase();

  let presetId: PresetId = "plasma";
  if (hasAny(p, ["cathedral", "raymarch", "warp field", "temple", "portal"])) presetId = "warp";
  else if (hasAny(p, ["triangle", "triangles", "geometric", "shapes", "polygon"])) presetId = "strobeGeo";
  else if (hasAny(p, ["grid", "strobe", "glitch", "scanlines", "tech"])) presetId = "strobeGrid";
  else if (hasAny(p, ["nebula", "space", "cosmic", "starfield"])) presetId = "nebula";
  else if (hasAny(p, ["tunnel", "warp", "speed", "cyber", "neon"])) presetId = "tunnel";
  else if (hasAny(p, ["kaleido", "kaleidoscope", "mandala", "symmetry"])) presetId = "kaleido";

  let palette: Palette | undefined;
  if (hasAny(p, ["fire", "lava", "volcano", "ember", "inferno"])) palette = palettes.fire;
  else if (hasAny(p, ["ice", "glacier", "frost", "arctic"])) palette = palettes.ice;
  else if (hasAny(p, ["neon", "cyber", "vapor", "synthwave"])) palette = palettes.neon;
  else if (hasAny(p, ["acid", "rave", "psychedelic", "trippy"])) palette = palettes.acid;

  const texturePrompt = prompt.length > 2 ? prompt : undefined;
  return { presetId, palette, texturePrompt };
}
