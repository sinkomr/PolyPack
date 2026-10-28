import { evaluate, findFreeSpot } from "@polypack/geometry";
import type { PackingConfig, Pose } from "@polypack/geometry";
import * as api from "../api";
import { Board } from "../board";
import { BoardView } from "../view";
import { mountSpaceBoard } from "./board-space";
import type { SpaceBoard } from "./board-space";
import type { SpaceKey } from "./frontier";
import { Lane } from "./lanes";
import { showNamePopup } from "./name-popup";
import type { OpenRunRequest, RunState } from "./open-run";
import { show6 } from "./points";
import { fetchSpaceProblem } from "./space-submission";

/**
 * The tutorial: a few short steps in a pop-up, shown on a first visit and again from Settings. It
 * shows that one packing is easy to see and the next ones are not (squares in a square: 9, then 10 and 11, then 17), then lets
 * the player shrink a loose packing of 12 hexagons in a pentagon with a few clicks, and ends with
 * the name pop-up. The boards here are never sent and pay no points: the tutorial has its own lane
 * and touches no game state.
 */

/** The shape of the first steps: the pieces and the container (4: squares), and how many pieces each step shows. */
export const SHOWN = { N: 4, M: 4, counts: [9, 10, 11, 17] } as const;

/** The hands-on step: 12 hexagons in a pentagon, improved by clicks that each run a fixed seeded mc_compress. */
export const HANDS_ON = {
  N: 6,
  M: 5,
  P: 12,
  seed: 3,
  /** Evaluations one click runs (the solver's counted unit). */
  evals: 60,
  /** Clicks the step asks for. */
  clicks: 10,
};

/**
 * The closing teaser: finished packings from the research records, drawn read-only by the site's
 * space view. 12 circles on a sphere sit at the corners of an icosahedron (a proven optimum), and 6
 * octahedra in a cube are a tilted, irregular record (side 1.767767).
 */
export const TEASER: { key: SpaceKey; caption: string }[] = [
  { key: { family: "sphere", id: "sphere/0/12", P: 12 }, caption: "12 circles on a sphere" },
  { key: { family: "polyhedra", id: "polyhedra/octincub/6", P: 6 }, caption: "6 octahedra in a cube" },
];

/** The side of nine squares in a 3 by 3 square, and the best known sides for 10, 11 and 17 (named when the site cannot be reached). */
const KNOWN_SIDE: Record<number, number> = { 9: 3, 10: 3 + 1 / Math.SQRT2, 11: 3.877084, 17: 4.67553 };

/** Nine squares in rows of three: the obvious packing. An unrotated square points a vertex up, so each is turned an eighth of a turn. */
export function nineSquares(): PackingConfig {
  const pieces: Pose[] = [];
  for (let r = -1; r <= 1; r++) for (let c = -1; c <= 1; c++) pieces.push({ x: c, y: r, theta: Math.PI / 4 });
  return { N: SHOWN.N, M: SHOWN.M, P: 9, pieces, container_phi: 0 };
}

/** The loose start of the hands-on step: every piece placed on rings around the centre (the board's Add all), the container at its best angle. */
export function looseStart(): PackingConfig {
  const { N, M, P } = HANDS_ON;
  const pieces: Pose[] = [];
  for (let k = 0; k < P; k++) pieces.push(findFreeSpot(N, pieces, 0, 0));
  const config: PackingConfig = { N, M, P, pieces, container_phi: 0 };
  const e = evaluate(config, { autoOrient: true });
  if (e.container) config.container_phi = e.container.phi;
  return config;
}

/** The request of the hands-on run: a budget far above what the clicks use, so that the run stays open between them. */
export function handsOnRequest(): OpenRunRequest {
  const { N, M, P } = HANDS_ON;
  return {
    problem: { N, M, P },
    method: "mc_compress",
    params: {},
    budget: { evals: 1_000_000 },
    seed: HANDS_ON.seed,
    start: looseStart(),
  };
}

/** The side of a packing as the server scores it (null when it is not a valid packing). */
export const sideOf = (config: PackingConfig): number | null => evaluate(config, { autoOrient: true }).score;

export interface Step {
  title: string;
  text: string;
  /** Packings of squares to draw: one, or two side by side. */
  show?: number[];
  hands?: true;
  /** The closing step: two read-only drawings in space. */
  teaser?: true;
}

export const STEPS: Step[] = [
  {
    title: "Nine squares",
    text: "Nine squares with sides that are 1 unit long can pack perfectly into a larger square with sides that are 3 units long. Packings are scored by the side length of the shape they are packed into, and a smaller score is better.",
    show: [9],
  },
  {
    title: "Ten and eleven squares",
    text: "Add one or two more squares and the neat grid no longer works. Ten squares need a square about 3.707 units on a side, and eleven need about 3.877, with some of the squares tilted at odd angles. Both packings have been proven to be the best possible.",
    show: [10, 11],
  },
  {
    title: "Seventeen squares",
    text: "Seventeen squares are a different story. The best packing anyone has found fits in a square about 4.676 units on a side, and it looks almost random. Nobody has proven that it can't be beaten, and puzzles like this are what Tighter is about.",
    show: [17],
  },
  {
    title: "Try it yourself",
    text: "Here are 12 hexagons packed loosely inside a pentagon. Each time you press Improve, the solver spends a moment nudging the pieces closer together, and the pentagon shrinks around them. Press it about 10 times and watch the packing tighten.",
    hands: true,
  },
  {
    title: "Now the game",
    text: "In the game you'll do this on many different problems. Whenever your packing beats the best one known, PolyPack's public record tables are updated, and you earn points both right away and over time, for as long as your record holds the top spot. Points buy upgrades that make your solver faster and smarter.",
  },
  {
    title: "What comes later",
    text: "Later in the game you can reset for a fresh start that opens new kinds of puzzles.",
    teaser: true,
  },
];

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

/** Packings of squares for the steps: the site's best (from the atlas) per count, or none when it cannot be reached. */
async function shownPackings(): Promise<Map<number, PackingConfig>> {
  const got = new Map<number, PackingConfig>();
  const counts = SHOWN.counts;
  const atlas = await api.getAtlas(SHOWN.N, SHOWN.M, Math.min(...counts), Math.max(...counts));
  for (const t of atlas?.tiles ?? [])
    if ((counts as readonly number[]).includes(t.P) && t.pieces.length === t.P)
      got.set(t.P, { N: SHOWN.N, M: SHOWN.M, P: t.P, pieces: t.pieces, container_phi: t.container_phi });
  got.set(9, nineSquares());
  return got;
}

let running: Promise<void> | null = null;

/**
 * Runs the tutorial and settles when it is over (finished or skipped) and the name pop-up has been
 * dealt with. A second call while it runs gets the same run.
 */
export function runTutorial(): Promise<void> {
  running ??= play().finally(() => {
    running = null;
  });
  return running;
}

async function play(): Promise<void> {
  const dialog = $<HTMLDialogElement>("t-tutorial");
  const title = $("t-tut-title");
  const count = $("t-tut-count");
  const body = $("t-tut-text");
  const status = $("t-tut-status");
  const act = $<HTMLButtonElement>("t-tut-act");
  const next = $<HTMLButtonElement>("t-tut-next");
  const setName = $<HTMLButtonElement>("t-tut-name");
  const skip = $<HTMLButtonElement>("t-tut-skip");
  const boards = $("t-tut-boards");
  const canvas = $<HTMLCanvasElement>("t-tut-board");
  const canvas2 = $<HTMLCanvasElement>("t-tut-board-2");
  const spaces = $("t-tut-spaces");
  const mounted: SpaceBoard[] = [];
  const board = new Board();
  dialog.showModal();
  const view = new BoardView(canvas, board, () => {});
  view.readOnly = true;
  view.previewLabel = null;
  // the second drawing of the slide with two packings
  const board2 = new Board();
  const view2 = new BoardView(canvas2, board2, () => {});
  view2.readOnly = true;
  view2.previewLabel = null;
  // a canvas gets its laid-out size only after the slide changes (one drawing narrows to half the width
  // for a pair), so each drawing is fitted again whenever its canvas is resized; the view's own observer
  // was registered first and has already taken the new size
  const refit = new ResizeObserver((entries) => {
    for (const e of entries) {
      if (e.contentRect.width === 0 || e.contentRect.height === 0) continue;
      if (stepNow === STEPS.findIndex((s) => s.hands) && clicks > 0) continue;
      (e.target === canvas ? view : view2).fit();
    }
  });
  refit.observe(canvas);
  refit.observe(canvas2);
  const packings = shownPackings();
  let lane = null as Lane | null;

  const draw = (config: PackingConfig, refit: boolean, which = 0) => {
    const [b, v] = which === 0 ? [board, view] : [board2, view2];
    if (b.load(config, false)) return;
    if (refit) v.fit();
  };

  // the hands-on step's state
  let clicks = 0;
  let side: number | null = null;
  let busy = false;
  let opened: Promise<boolean> | null = null;
  let stepNow = 0;
  let over = false;

  const openHandsOn = (): Promise<boolean> => {
    opened ??= (async () => {
      lane = new Lane(-2);
      const a = await lane.openRun(handsOnRequest());
      return a.ok;
    })();
    return opened;
  };

  const handsStatus = () => {
    status.textContent =
      side === null
        ? "The solver is starting."
        : clicks >= HANDS_ON.clicks
          ? `Pentagon side: ${show6(side)}. Improved ${clicks} times. Press Next when you're ready.`
          : `Pentagon side: ${show6(side)}. Improved ${clicks} of ${HANDS_ON.clicks} times.`;
  };

  const show = async (i: number) => {
    const s = STEPS[i];
    title.textContent = s.title;
    count.textContent = `Step ${i + 1} of ${STEPS.length}`;
    body.textContent = s.text;
    status.textContent = "";
    boards.hidden = !!s.teaser;
    boards.classList.toggle("pair", (s.show?.length ?? 0) > 1);
    canvas2.hidden = (s.show?.length ?? 0) < 2;
    spaces.hidden = !s.teaser;
    act.hidden = !s.hands;
    const last = i === STEPS.length - 1;
    next.textContent = last ? "PLAY" : "Next";
    setName.hidden = !last;
    next.disabled = !!s.hands && clicks < HANDS_ON.clicks;
    if (s.show) {
      const got = await packings;
      if (stepNow !== i) return;
      const lines: string[] = [];
      s.show.forEach((n, k) => {
        const config = got.get(n);
        if (config) {
          draw(config, true, k);
          const side = sideOf(config);
          if (side !== null) lines.push(`${n} squares, side ${show6(side)}.`);
        } else {
          (k === 0 ? board : board2).clear();
          lines.push(`The best known side for ${n} squares is about ${show6(KNOWN_SIDE[n])}.`);
        }
      });
      const missing = s.show.some((n) => !got.has(n));
      status.textContent = missing
        ? `The site could not be reached, so there is no picture. ${lines.join(" ")}`
        : lines.join(" ");
    } else if (s.teaser) {
      // each drawing is its own mount; one that cannot be read or loaded leaves its place empty
      TEASER.forEach((t, k) => {
        const host = $(`t-tut-space-${k}`);
        $(`t-tut-space-cap-${k}`).textContent = t.caption;
        void fetchSpaceProblem(t.key.family, t.key.id).then(({ read }) => {
          if (!read?.config || stepNow !== i || over) return;
          const m = mountSpaceBoard(host, { ...t.key, board: read.config });
          // the tutorial may have ended while the drawing loaded: it is not kept
          if (over) m.destroy();
          else mounted.push(m);
        });
      });
    } else if (s.hands) {
      if (clicks === 0) {
        const start = looseStart();
        draw(start, true);
        side = sideOf(start);
      }
      handsStatus();
      act.disabled = busy;
      if (!(await openHandsOn()) && stepNow === i)
        status.textContent = "The solver could not start in this browser. You can skip this step.";
    }
  };

  let askName = false;
  let skipped = false;
  const finished = new Promise<void>((resolve) => {
    const done = () => resolve();
    setName.onclick = () => {
      askName = true;
      done();
    };
    next.onclick = () => {
      if (stepNow === STEPS.length - 1) return done();
      stepNow++;
      void show(stepNow);
    };
    skip.onclick = () => {
      skipped = true;
      done();
    };
    dialog.oncancel = (e) => {
      // Escape skips, as the Skip button does
      e.preventDefault();
      done();
    };
    act.onclick = async () => {
      if (busy || !lane || !(await openHandsOn())) return;
      busy = true;
      act.disabled = true;
      const a = await lane.step(HANDS_ON.evals);
      busy = false;
      if (!a.ok || stepNow !== STEPS.findIndex((s) => s.hands)) {
        act.disabled = false;
        return;
      }
      const state = a.state as RunState;
      if (state.best && state.score !== null && (side === null || state.score < side - 1e-9)) {
        clicks++;
        side = state.score;
        draw(state.best, false);
      }
      handsStatus();
      act.disabled = state.ended;
      next.disabled = clicks < HANDS_ON.clicks && !state.ended;
    };
  });

  void show(0);
  await finished;
  next.onclick = skip.onclick = setName.onclick = act.onclick = dialog.oncancel = null;
  over = true;
  refit.disconnect();
  dialog.close();
  lane?.terminate();
  for (const m of mounted) m.destroy();
  spaces.hidden = true;
  // PLAY keeps the generated name; the name pop-up opens for "Set my leaderboard name" and for Skip
  if (askName || skipped) await showNamePopup();
}
