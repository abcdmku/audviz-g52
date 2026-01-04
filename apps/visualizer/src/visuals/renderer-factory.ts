import { Canvas2dRenderer } from "./canvas2d.js";
import { WebGpuRenderer } from "./renderer.js";

export type AnyRenderer = Canvas2dRenderer | WebGpuRenderer;

export async function createRenderer(canvas: HTMLCanvasElement): Promise<AnyRenderer> {
  try {
    return await WebGpuRenderer.create(canvas);
  } catch {
    return new Canvas2dRenderer(canvas);
  }
}

