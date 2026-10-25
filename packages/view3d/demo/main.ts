/**
 * Demo of the boundary views: research layouts on the tesseract, drawn from the engine's parts.
 * URL parameters (for screenshots): fixture, view (atlas | net | slice).
 */
import { validateBoundary } from "@polypack/boundary";
import { type BoundaryView, type ViewKey, createBoundaryView, engineFor } from "../src/index";
import { FIXTURES } from "./fixtures";

const params = new URLSearchParams(location.search);
const select = document.getElementById("fixture") as HTMLSelectElement;
const verdict = document.getElementById("verdict")!;
const host = document.getElementById("view")!;

for (const f of FIXTURES) select.append(new Option(f.label, f.key));
select.value = params.get("fixture") ?? "balls-9";

let view: BoundaryView | null = null;
let piece: string | null = null;

function load() {
  const fx = FIXTURES.find((f) => f.key === select.value) ?? FIXTURES[0];
  // one view per kind of piece: the piece's shape is fixed for a view
  if (piece !== fx.piece) {
    const was = view?.view ?? ((params.get("view") as ViewKey) || "atlas");
    view?.destroy();
    view = createBoundaryView(host, {
      ...engineFor("tesseract", fx.piece),
      initialView: was,
      label: "Drawing of the packing",
      pieceNames: fx.piece === "ball" ? ["ball", "balls"] : ["cube", "cubes"],
    });
    piece = fx.piece;
  }
  view!.show(fx.config);
  try {
    const v = validateBoundary({ polytope: "tesseract", piece: fx.piece, P: fx.config.pieces.length }, fx.config);
    verdict.className = v.ok ? "ok" : "bad";
    verdict.textContent = v.ok ? `Valid (engine check), edge ${fx.config.s.toFixed(6)}` : `Engine check: ${v.reasons[0] ?? "invalid"}`;
  } catch (e) {
    verdict.className = "bad";
    verdict.textContent = `Engine check failed: ${e instanceof Error ? e.message : String(e)}`;
  }
  const url = new URL(location.href);
  url.searchParams.set("fixture", fx.key);
  history.replaceState(null, "", url);
}

select.addEventListener("change", load);
load();
(window as unknown as { boundaryView: () => BoundaryView | null }).boundaryView = () => view;
