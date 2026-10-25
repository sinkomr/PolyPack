/**
 * What every scene of the view gets, and what it must do.
 */
import { CanvasTexture, type PerspectiveCamera, SRGBColorSpace, Sprite, SpriteMaterial, type Raycaster, type Texture, type WebGLRenderer } from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { LineMaterial } from "three/examples/jsm/lines/LineMaterial.js";
import type { LineRegistry } from "./kit";
import type { Engine, Model } from "./model";
import type { Theme } from "./palette";

export interface Ctx {
  engine: Engine;
  lines: LineRegistry;
  env: Texture;
  /** Short cell names ("-w"). */
  names: string[];
  /** The current theme and cell colours (they change with the colour scheme). */
  theme(): Theme;
  cellColors(): string[];
  /** The cells' edge lines. */
  cellEdge: LineMaterial;
}

/** HTML layers of a scene: under the canvas (tile cards) and over it (titles). */
export interface Layers {
  under: HTMLElement;
  over: HTMLElement;
}

export interface SceneView {
  readonly camera: PerspectiveCamera;
  /** Draws a configuration (null: nothing). */
  build(model: Model | null): void;
  /** The drawing area changed: W x H CSS pixels. */
  resize(W: number, H: number): void;
  /** Draws a frame. Must not allocate. */
  render(r: WebGLRenderer): void;
  /** The piece under CSS pixel (x, y) of the drawing area, or null. */
  pick(x: number, y: number, ray: Raycaster): number | null;
  /** Puts the camera at its starting pose. */
  home(controls: OrbitControls): void;
  /** The colour scheme changed. */
  recolor(): void;
  /** What is drawn, in a sentence. */
  describe(): string;
  dispose(): void;
}

/** Normalized device coordinates of (x, y) in a w x h viewport at (vx, vy), into out. */
export function toNdc(x: number, y: number, vx: number, vy: number, w: number, h: number, out: { x: number; y: number }) {
  out.x = ((x - vx) / w) * 2 - 1;
  out.y = -((y - vy) / h) * 2 + 1;
}

/** A text label that always faces the camera and stays on top. */
export class Label {
  readonly sprite: Sprite;
  private readonly canvas = document.createElement("canvas");
  private readonly texture: Texture;
  private readonly material: SpriteMaterial;
  private aspect = 2;

  constructor(
    private text: string,
    color: string,
    halo: string,
    /** Height in world units. */
    private height: number,
  ) {
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.material = new SpriteMaterial({ map: this.texture, depthTest: false, depthWrite: false, transparent: true });
    this.sprite = new Sprite(this.material);
    this.sprite.renderOrder = 10;
    this.paint(color, halo);
  }

  paint(color: string, halo: string) {
    const px = 64;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    ctx.font = `600 ${px * 0.62}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    const w = Math.ceil(ctx.measureText(this.text).width + px * 0.5);
    this.canvas.width = w;
    this.canvas.height = px;
    ctx.font = `600 ${px * 0.62}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    ctx.lineWidth = px * 0.16;
    ctx.strokeStyle = halo;
    ctx.strokeText(this.text, w / 2, px / 2);
    ctx.fillStyle = color;
    ctx.fillText(this.text, w / 2, px / 2);
    this.texture.needsUpdate = true;
    this.aspect = w / px;
    this.sprite.scale.set(this.height * this.aspect, this.height, 1);
  }

  /** Sets the label's height in world units. */
  setHeight(h: number) {
    this.height = h;
    this.sprite.scale.set(h * this.aspect, h, 1);
  }

  set opacity(v: number) {
    this.material.opacity = v;
    this.sprite.visible = v > 0.01;
  }

  dispose() {
    this.texture.dispose();
    this.material.dispose();
  }
}
