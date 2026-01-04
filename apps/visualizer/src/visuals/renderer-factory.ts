import { Canvas2dRenderer } from "./canvas2d.js";
import { WebGpuRenderer } from "./renderer.js";
import { WebGl2Renderer } from "./webgl2.js";

export type AnyRenderer = Canvas2dRenderer | WebGl2Renderer | WebGpuRenderer;

export async function createRenderer(canvas: HTMLCanvasElement): Promise<AnyRenderer> {
  try {
    return await WebGpuRenderer.create(canvas);
  } catch {
    try {
      return await WebGl2Renderer.create(canvas);
    } catch {
      return new Canvas2dRenderer(canvas);
    }
  }
}
