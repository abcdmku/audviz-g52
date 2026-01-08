export type ParamKey =
  | "textureStrength"
  | "warpStrength"
  | "strobeStrength"
  | "brightness"
  | "grainStrength";

export type ParamDef = {
  key: ParamKey;
  label: string;
  min: number;
  max: number;
  def: number;
  description: string;
};

export const PARAM_DEFS: Record<ParamKey, ParamDef> = {
  textureStrength: {
    key: "textureStrength",
    label: "Texture",
    min: 0,
    max: 1,
    def: 0.8,
    description: "How strongly the generated texture influences the scene."
  },
  warpStrength: {
    key: "warpStrength",
    label: "Warp",
    min: 0,
    max: 1,
    def: 0.85,
    description: "Scales warp/tunnel motion and distortion."
  },
  strobeStrength: {
    key: "strobeStrength",
    label: "Strobe",
    min: 0,
    max: 1,
    def: 0.7,
    description: "Reduces flashing in strobe-heavy scenes when lowered."
  },
  brightness: {
    key: "brightness",
    label: "Brightness",
    min: 0.25,
    max: 2,
    def: 1,
    description: "Global brightness multiplier."
  },
  grainStrength: {
    key: "grainStrength",
    label: "Grain",
    min: 0,
    max: 1,
    def: 0.7,
    description: "Film grain amount (Canvas2D + shader noise)."
  }
};

export const DEFAULT_PARAMS: Record<ParamKey, number> = {
  textureStrength: PARAM_DEFS.textureStrength.def,
  warpStrength: PARAM_DEFS.warpStrength.def,
  strobeStrength: PARAM_DEFS.strobeStrength.def,
  brightness: PARAM_DEFS.brightness.def,
  grainStrength: PARAM_DEFS.grainStrength.def
};

export function clampParam(key: ParamKey, value: number) {
  const def = PARAM_DEFS[key];
  return Math.max(def.min, Math.min(def.max, value));
}

export function coerceParamKey(key: string): ParamKey | null {
  return (Object.prototype.hasOwnProperty.call(PARAM_DEFS, key) ? (key as ParamKey) : null);
}

export function aiParamSchema() {
  return Object.values(PARAM_DEFS).map((d) => ({
    key: d.key,
    min: d.min,
    max: d.max,
    default: d.def,
    description: d.description
  }));
}

