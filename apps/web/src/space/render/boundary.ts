/**
 * The board's drawing of a 3D on 4D problem: the three.js views of packages/view3d (Cells, Net
 * with its Fold slider, Slice with its axis and position), wrapped in the board's SpaceView.
 *
 * three.js is large, so it is loaded with a dynamic import when the first boundary problem is
 * drawn, not with the board's space mode: the other kinds never load it. Until it arrives, the
 * drawing says that it is loading; a configuration shown meanwhile is drawn when it is ready.
 *
 * One view serves every problem of the same polytope and piece (canShow), so that choosing
 * another P keeps the view, the camera, the fold and the slice the user chose. Another piece
 * needs another view (the piece's shape is fixed in a view); it opens in the view last used.
 */
import type { BoundaryView, ViewKey } from "@polypack/view3d";
import type { BoundaryConfig, PieceName, PolytopeName } from "@polypack/boundary";
import type { SpaceConfig } from "@polypack/spaces";
import { pieceNames } from "../../boundary-model";
import type { SpaceView } from "../view";

/** The fields of a boundary problem the drawing needs. */
export interface BoundaryDrawing {
  polytope: string;
  piece: string;
}

type View3d = typeof import("@polypack/view3d");

let module: Promise<View3d> | null = null;

/** Loads packages/view3d (and three.js) once; a failed load is tried again on the next call. */
export function loadView3d(): Promise<View3d> {
  return (module ??= import("@polypack/view3d").catch((error: unknown) => {
    module = null;
    throw error;
  }));
}

/** The view last shown (Cells, Net or Slice), for the next drawing of another piece. */
let lastView: ViewKey = "atlas";

export function mountBoundaryView(host: HTMLElement, p: BoundaryDrawing, label = "Drawing"): SpaceView {
  const root = document.createElement("div");
  root.className = "space-view space-view-3d";
  const wait = document.createElement("div");
  wait.className = "space-3d-wait";
  const text = document.createElement("p");
  text.setAttribute("role", "status");
  text.textContent = "Loading the 3D drawing…";
  wait.append(text);
  root.append(wait);
  host.replaceChildren(root);

  let view: BoundaryView | null = null;
  let gone = false;
  /** The configuration to draw once the view exists (undefined: none was asked for). */
  let pending: SpaceConfig | null | undefined;

  function open(): void {
    text.textContent = "Loading the 3D drawing…";
    wait.querySelector("button")?.remove();
    loadView3d().then(
      (m) => {
        if (gone) return;
        root.replaceChildren();
        view = m.createBoundaryView(root, {
          ...m.engineFor(p.polytope as PolytopeName, p.piece as PieceName),
          initialView: lastView,
          label,
          pieceNames: pieceNames(p.piece),
        });
        if (pending !== undefined) view.show(pending as BoundaryConfig | null);
      },
      () => {
        if (gone) return;
        text.textContent = "The 3D drawing could not be loaded. The connection may have dropped.";
        const retry = document.createElement("button");
        retry.type = "button";
        retry.textContent = "Try again";
        retry.addEventListener("click", open);
        wait.append(retry);
      },
    );
  }
  open();

  return {
    show(config) {
      // a configuration of this problem's format (read by the space's reader, model.ts)
      if (view) view.show(config as BoundaryConfig | null);
      else pending = config;
    },
    canShow(q) {
      return q.space === "boundary" && q.polytope === p.polytope && q.piece === p.piece;
    },
    destroy() {
      gone = true;
      if (view) {
        lastView = view.view;
        view.destroy();
        view = null;
      }
      root.remove();
    },
  };
}
