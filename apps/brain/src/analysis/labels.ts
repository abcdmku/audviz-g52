export const GENRE_LABELS = [
  "Techno",
  "House",
  "Drum & Bass",
  "Trance",
  "Dubstep",
  "Hip-Hop",
  "Ambient"
] as const;

export type GenreLabel = (typeof GENRE_LABELS)[number];

