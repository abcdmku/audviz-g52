export type PresetId =
  | "plasma"
  | "tunnel"
  | "kaleido"
  | "warp"
  | "strobeGrid"
  | "strobeGeo"
  | "nebula";

export type Palette = {
  a: [number, number, number];
  b: [number, number, number];
  c: [number, number, number];
  d: [number, number, number];
};

export type PresetSpec = {
  id: PresetId;
  name: string;
  mode: number;
  palette: Palette;
  texturePrompt?: string;
};

export const PRESETS: PresetSpec[] = [
  {
    id: "plasma",
    name: "Plasma Bloom",
    mode: 0,
    palette: {
      a: [0.05, 0.02, 0.1],
      b: [0.0, 0.83, 1.0],
      c: [0.49, 0.36, 1.0],
      d: [1.0, 0.31, 0.6]
    },
    texturePrompt: "iridescent noise texture, seamless"
  },
  {
    id: "tunnel",
    name: "Neon Tunnel",
    mode: 1,
    palette: {
      a: [0.03, 0.05, 0.1],
      b: [0.15, 1.0, 0.92],
      c: [0.63, 0.29, 1.0],
      d: [1.0, 0.74, 0.12]
    },
    texturePrompt: "cyberpunk neon pattern texture, seamless"
  },
  {
    id: "kaleido",
    name: "Kaleidoscope",
    mode: 2,
    palette: {
      a: [0.03, 0.03, 0.06],
      b: [0.4, 0.98, 0.5],
      c: [1.0, 0.35, 0.2],
      d: [0.85, 0.65, 1.0]
    },
    texturePrompt: "psychedelic fractal texture, seamless"
  }
  ,
  {
    id: "warp",
    name: "Warp Cathedral",
    mode: 3,
    palette: {
      a: [0.01, 0.02, 0.04],
      b: [0.5, 0.95, 1.0],
      c: [0.98, 0.45, 0.95],
      d: [1.0, 0.92, 0.3]
    },
    texturePrompt: "high detail abstract texture, seamless"
  },
  {
    id: "strobeGrid",
    name: "Strobe Grid",
    mode: 4,
    palette: {
      a: [0.02, 0.02, 0.02],
      b: [0.95, 0.95, 1.0],
      c: [0.1, 0.95, 0.85],
      d: [1.0, 0.2, 0.7]
    },
    texturePrompt: "glitch grid texture, seamless"
  },
  {
    id: "strobeGeo",
    name: "Strobe Geometry",
    mode: 4.25,
    palette: {
      a: [0.02, 0.02, 0.02],
      b: [0.95, 0.95, 1.0],
      c: [0.1, 0.95, 0.85],
      d: [1.0, 0.2, 0.7]
    },
    texturePrompt: "geometric triangle pattern texture, seamless"
  },
  {
    id: "nebula",
    name: "Fractal Nebula",
    mode: 5,
    palette: {
      a: [0.01, 0.02, 0.03],
      b: [0.25, 0.85, 1.0],
      c: [0.85, 0.35, 1.0],
      d: [1.0, 0.55, 0.2]
    },
    texturePrompt: "space nebula texture, seamless"
  }
];

export const DEFAULT_PRESET_ID: PresetId = "tunnel";
