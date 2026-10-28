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
 * shows that one packing is easy to see and the next ones are not (squares in a square), then lets
 * the player shrink a loose packing of 12 hexagons in a pentagon with a few clicks, and ends with
 * the name pop-up. The boards here are never sent and pay no points: the tutorial has its own lane
 * and touches no game state.
 */

/** The shape of the first steps: the pieces and the container (4: squares), and how many pieces each step shows. */
export const SHOWN = { N: 4, M: 4, counts: [9, 10, 11] } as const;

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
 * space view. 12 disks on a sphere sit at the corners of an icosahedron (a proven optimum), and 8 cubes
 * fill a cube in two layers of four.
 */
export const TEASER: { key: SpaceKey; caption: string }[] = [
  { key: { family: "sphere", id: "sphere/0/12", P: 12 }, caption: "12 disks on a sphere" },
  { key: { family: "polyhedra", id: "polyhedra/cubincub/8", P: 8 }, caption: "8 cubes in a cube" },
];

/** The side of nine squares in a 3 by 3 square, and the best known sides for 10 and 11 (shown when the site cannot be reached). */
const KNOWN_SIDE: Record<number, number> = { 9: 3, 10: 3 + 1 / Math.SQRT2, 11: 3.877084 };

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

interface Step {
  title: string;
  text: string;
  /** A packing of squares to draw. */
  show?: { count: number };
  hands?: true;
  /** The closing step: two finished packings in space. */
  teaser?: true;
}

const STEPS: Step[] = [
  {
    title: "Nine squares",
    text: "Nine squares of side 1 fit in a square of side 3. You can see the fit at once. The score of a packing is the side of its container, and smaller is better.",
    show: { count: 9 },
  },
  {
    title: "Ten squares",
    text: "Ten squares need a little more room. The best known side is about 3.707, and the packing is no longer simple to see.",
    show: { count: 10 },
  },
  {
    title: "Eleven squares",
    text: "Eleven squares are harder still. The best known packing has a side of about 3.877. Every new count is a new puzzle.",
    show: { count: 11 },
  },
  {
    title: "Try it yourself",
    text: "These 12 hexagons sit loose in a pentagon. Each press of Improve runs the solver for a short time on the board. Press it about 10 times and watch the side shrink.",
    hands: true,
  },
  {
    title: "Now the game",
    text: "In the game you do this on many problems. When your board beats the best one known, you can send it to PolyPack and earn points.",
  },
  {
    title: "What comes later",
    text: "After your first reset, you will pack on the surfaces of solids. After the second, inside them. Next, you can choose a name for your records.",
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
  const skip = $<HTMLButtonElement>("t-tut-skip");
  const canvas = $<HTMLCanvasElement>("t-tut-board");
  const spaces = $("t-tut-spaces");
  const mounted: SpaceBoard[] = [];
  const board = new Board();
  dialog.showModal();
  const view = new BoardView(canvas, board, () => {});
  view.readOnly = true;
  view.previewLabel = null;
  const packings = shownPackings();
  let lane = null as Lane | null;

  const draw = (config: PackingConfig, refit: boolean) => {
    if (board.load(config, false)) return;
    if (refit) view.fit();
  };

  // the hands-on step's state
  let clicks = 0;
  let side: number | null = null;
  let busy = false;
  let opened: Promise<boolean> | null = null;
  let stepNow = 0;

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
        : `Side ${show6(side)}. Improvements so far: ${clicks} of ${HANDS_ON.clicks}.`;
  };

  const show = async (i: number) => {
    const s = STEPS[i];
    title.textContent = s.title;
    count.textContent = `Step ${i + 1} of ${STEPS.length}`;
    body.textContent = s.text;
    status.textContent = "";
    canvas.hidden = !!s.teaser;
    spaces.hidden = !s.teaser;
    act.hidden = !s.hands;
    next.textContent = i === STEPS.length - 1 ? "Choose a name" : "Next";
    next.disabled = !!s.hands && clicks < HANDS_ON.clicks;
    if (s.show) {
      const config = (await packings).get(s.show.count);
      if (stepNow !== i) return;
      if (config) {
        draw(config, true);
        const side = sideOf(config);
        status.textContent = side === null ? "" : `${s.show.count} squares, side ${show6(side)}.`;
      } else {
        board.clear();
        status.textContent = `The site could not be reached, so there is no picture. The best known side for ${s.show.count} squares is about ${show6(KNOWN_SIDE[s.show.count])}.`;
      }
    } else if (s.teaser) {
      // each drawing is its own mount; one that cannot be read or loaded leaves its place empty
      TEASER.forEach((t, k) => {
        const host = $(`t-tut-space-${k}`);
        $(`t-tut-space-cap-${k}`).textContent = t.caption;
        void fetchSpaceProblem(t.key.family, t.key.id).then(({ read }) => {
          if (!read?.config || stepNow !== i) return;
          mounted.push(mountSpaceBoard(host, { ...t.key, board: read.config }));
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

  const finished = new Promise<void>((resolve) => {
    const done = () => resolve();
    next.onclick = () => {
      if (stepNow === STEPS.length - 1) return done();
      stepNow++;
      void show(stepNow);
    };
    skip.onclick = done;
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
  next.onclick = skip.onclick = act.onclick = dialog.oncancel = null;
  dialog.close();
  lane?.terminate();
  for (const m of mounted) m.destroy();
  spaces.hidden = true;
  await showNamePopup();
}
