import { expect, Page, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { evaluate, findOverlaps } from "@polypack/geometry";
import { strictTolerance } from "@polypack/solver";
import type { Result } from "@polypack/solver";
import { openProblem, pieces } from "./helpers";

const lastResult = (page: Page): Promise<Result | null> =>
  page.evaluate(() => (window as any).polypack.solve.lastResult);
async function choose(page: Page, method: string, evals = 200) {
  await expect(page.locator("#solve-run")).toBeEnabled();
  await page.selectOption("#solve-method", method);
  await page.selectOption("#solve-budget", "evals");
  await page.fill("#solve-evals", String(evals));
}
async function completed(page: Page): Promise<Result> {
  await expect(page.locator("#solve-run")).toBeEnabled({ timeout: 30_000 });
  const r = await lastResult(page);
  expect(r).not.toBeNull();
  return r!;
}

for (const method of ["penalty", "basin_hopping", "mc_compress", "morph", "asc", "ls_growth", "harden", "seed"]) {
  test(`solve: ${method} runs from scratch in a worker and preserves the board`, async ({ page }) => {
    await openProblem(page, 0, 0, 3);
    await choose(page, method);
    const before = await page.evaluate(() => ({
      config: (window as any).polypack.board.toConfig(),
      undo: (window as any).polypack.board.canUndo,
    }));
    await page.click("#solve-run");
    const r = await completed(page);
    expect(r.method).toBe(method);
    expect(r.valid && r.strict).toBe(true);
    expect(r.evaluations).toBeLessThanOrEqual(200);
    expect(r.best!.pieces).toHaveLength(3);
    expect(findOverlaps(0, r.best!.pieces, strictTolerance(r.best!))).toEqual([]);
    expect(evaluate(r.best!, { autoOrient: true }).score).toBe(r.score);
    expect(
      await page.evaluate(() => ({
        config: (window as any).polypack.board.toConfig(),
        undo: (window as any).polypack.board.canUndo,
      })),
    ).toEqual(before);
    await expect(page.locator("#solve-accept")).toBeEnabled();
    await expect(page.locator("#count")).toContainText("0 / 3");
  });
}

test("solve: accept, undo/redo, download full run and submit to authoritative server", async ({ page }) => {
  await openProblem(page, 4, 7, 3);
  await page.click("#add-all");
  const before = await pieces(page);
  await choose(page, "asc", 100);
  await page.click("#solve-run");
  const r = await completed(page);
  await page.click("#solve-accept");
  expect(await pieces(page)).toEqual(r.best!.pieces);
  await page.click("#undo");
  expect(await pieces(page)).toEqual(before);
  await page.click("#redo");
  expect(await pieces(page)).toEqual(r.best!.pieces);
  // After changing the accepted board, the saved result remains available for download.
  // Download before changing it in the separate repeat run below.
  await choose(page, "mc_compress", 100);
  await page.locator("#solve-settings details").evaluate((d: HTMLDetailsElement) => {
    d.open = true;
  });
  await page.fill("#solve-param-containerRotation", "10");
  await page.click("#solve-run");
  const next = await completed(page);
  expect(next.params.containerRotation).toBeCloseTo(Math.PI / 18, 12);
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#solve-download")]);
  const artifact = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(artifact.solver.request.start.pieces).toEqual(r.best!.pieces);
  expect(artifact.solver.result.params.containerRotation).toBe(next.params.containerRotation);
  expect(artifact.solver.request.budget).toEqual({ evals: 100 });
  expect(artifact.pieces).toEqual(next.best!.pieces);
  await page.click("#solve-accept");
  await page.fill("#name", "Solver browser test");
  await page.click("#submit");
  await expect(page.locator("#submit-result")).toContainText("Accepted. Server score");
  expect(Number((await page.locator("#submit-result").textContent())!.match(/Server score (\d+\.\d+)/)![1])).toBeCloseTo(
    next.score!,
    6,
  );
});

test("solve: pause, resume, stop while paused, and cancel stale preview on board change", async ({ page }) => {
  await openProblem(page, 4, 4, 11);
  await choose(page, "basin_hopping", 1000000);
  await page.click("#solve-run");
  await expect(page.locator("#solve-score")).not.toHaveText("—");
  await page.click("#solve-pause");
  await expect(page.locator("#solve-status")).toContainText("Paused.");
  await page.waitForTimeout(100);
  const paused = await page.locator("#solve-progress").textContent();
  await page.waitForTimeout(150);
  expect(await page.locator("#solve-progress").textContent()).toBe(paused);
  // View remains responsive while the worker is paused.
  await page.click("#fit");
  await page.click("#solve-pause");
  await expect(page.locator("#solve-progress")).not.toHaveText(paused!);
  await page.click("#solve-pause");
  await expect(page.locator("#solve-status")).toContainText("Paused.");
  await page.click("#solve-stop");
  await expect(page.locator("#solve-accept")).toBeEnabled({ timeout: 2000 });
  expect((await lastResult(page))!.termination).toBe("aborted");
  await page.click("#solve-run");
  await expect(page.locator("#solve-score")).not.toHaveText("—");
  await page.click("#solve-pause");
  await expect(page.locator("#solve-status")).toContainText("Paused.");
  await page.fill("#p-input", "12");
  await page.locator("#p-input").blur();
  await expect(page.locator("#solve-status")).toContainText("Board changed");
  await expect(page.locator("#solve-accept")).toBeDisabled();
  await expect(page.locator("#count")).toContainText("0 / 12");
  expect(await lastResult(page)).toBeNull();
});

test("solve: polish requires a complete board and adjacent-record seed accepts JSON", async ({ page }) => {
  await openProblem(page, 0, 0, 3);
  await choose(page, "polish");
  await page.click("#solve-run");
  await expect(page.locator("#solve-status")).toContainText("Place exactly P pieces");
  expect(await lastResult(page)).toBeNull();
  await page.click("#add-all");
  await page.click("#solve-run");
  expect((await completed(page)).strict).toBe(true);
  await choose(page, "seed");
  await page.locator("#solve-settings details").evaluate((d: HTMLDetailsElement) => {
    d.open = true;
  });
  await page.selectOption("#solve-param-kind", JSON.stringify("record_plus_one"));
  await page.fill(
    "#solve-param-record",
    JSON.stringify({
      N: 0,
      M: 0,
      P: 2,
      pieces: [
        { x: -1, y: 0, theta: 0 },
        { x: 1, y: 0, theta: 0 },
      ],
      container_phi: 0,
    }),
  );
  await page.selectOption("#solve-start", "scratch");
  await page.click("#solve-run");
  expect((await completed(page)).strict).toBe(true);
});

test("solve: delayed pause acknowledgement cannot undo a stop request", async ({ page }) => {
  await page.addInitScript(() => {
    const Original = window.Worker;
    (window as any).Worker = class {
      inner: Worker;
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      constructor(url: string | URL, options: WorkerOptions) {
        this.inner = new Original(url, options);
        this.inner.onmessage = (e) => {
          const delay =
            e.data.type === "control" && e.data.state === "paused" ? 80 : e.data.type === "result" ? 250 : 0;
          setTimeout(() => this.onmessage?.(e), delay);
        };
        this.inner.onerror = (e) => this.onerror?.(e);
      }
      postMessage(data: unknown) {
        this.inner.postMessage(data);
      }
      terminate() {
        this.inner.terminate();
        this.onmessage = null;
      }
    };
  });
  await openProblem(page, 4, 4, 11);
  await choose(page, "basin_hopping", 1000000);
  await page.click("#solve-run");
  await expect(page.locator("#solve-score")).not.toHaveText("—");
  await page.evaluate(() => {
    document.getElementById("solve-pause")!.click();
    document.getElementById("solve-stop")!.click();
  });
  await page.waitForTimeout(120);
  await expect(page.locator("#solve-pause")).toBeDisabled();
  await expect(page.locator("#solve-accept")).toBeEnabled({ timeout: 2000 });
  expect((await lastResult(page))!.termination).toBe("aborted");
});

test("solve: accepted results are attributed to an AI agent only while they are on the board", async ({ page }) => {
  await openProblem(page, 4, 7, 3);
  await page.click("#add-all");
  const agent = page.locator("#agent"),
    note = page.locator("#agent-note");
  await expect(agent).toHaveValue("human");
  await choose(page, "asc", 100);
  await page.click("#solve-run");
  const r = await completed(page);
  // A preview alone does not change who made the board.
  await expect(agent).toHaveValue("human");
  await expect(note).toHaveValue("");
  await page.click("#solve-accept");
  const filled = 'asc; seed 1; budget {"evals":100}';
  await expect(agent).toHaveValue("ai");
  await expect(note).toHaveValue(filled);
  await page.click("#undo");
  await expect(agent).toHaveValue("human");
  await expect(note).toHaveValue("");
  await page.click("#redo");
  expect(await pieces(page)).toEqual(r.best!.pieces);
  await expect(agent).toHaveValue("ai");
  await expect(note).toHaveValue(filled);
  // Editing the accepted packing by hand also ends the solver attribution.
  await page.evaluate(() => {
    const { board } = (window as any).polypack;
    board.select([0]);
    board.step(() => board.translateSelection(0, 0.25));
  });
  expect(await pieces(page)).not.toEqual(r.best!.pieces);
  await expect(agent).toHaveValue("human");
  await expect(note).toHaveValue("");
  await page.click("#undo");
  await expect(agent).toHaveValue("ai");
  await expect(note).toHaveValue(filled);
  // What the user typed after the automatic fill is never replaced.
  await note.fill("my own note");
  await page.click("#undo");
  await expect(agent).toHaveValue("human");
  await expect(note).toHaveValue("my own note");
  await page.click("#redo");
  await expect(agent).toHaveValue("ai");
  await expect(note).toHaveValue("my own note");
  await agent.selectOption("human");
  await page.click("#undo");
  await page.click("#redo");
  await expect(agent).toHaveValue("human");
  await expect(note).toHaveValue("my own note");
});

test("solve: an invalid setting inside collapsed method settings is revealed and nothing runs", async ({ page }) => {
  await openProblem(page, 0, 0, 3);
  await choose(page, "mc_compress", 100);
  const details = page.locator("#solve-settings details"),
    field = page.locator("#solve-param-adaptationSweeps"),
    status = page.locator("#solve-status");
  await details.locator("summary").click();
  for (const [value, message] of [
    ["", "Adaptation interval: enter a value; this setting cannot be left empty."],
    ["0", "Adaptation interval: must be at least 1."],
  ]) {
    await field.fill(value);
    await expect(field).not.toHaveAttribute("aria-invalid", "true");
    await details.locator("summary").click();
    await expect(field).toBeHidden();
    await status.evaluate((e) => (e.textContent = ""));
    await page.click("#solve-run");
    await expect(details).toHaveAttribute("open", "");
    await expect(field).toBeVisible();
    await expect(field).toBeFocused();
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(status).toContainText(message);
    await expect(status).toContainText("Nothing was run.");
    await expect(page.locator("#solve-run")).toBeEnabled();
    await expect(page.locator("#solve-stop")).toBeDisabled();
    await expect(page.locator("#solve-progress")).toHaveText("—");
    expect(await lastResult(page)).toBeNull();
  }
  // An angle beyond its converted bound is caught the same way; defaults at a bound are not.
  await field.fill("20");
  await page.fill("#solve-param-containerRotation", "181");
  await details.locator("summary").click();
  await page.click("#solve-run");
  await expect(page.locator("#solve-param-containerRotation")).toBeFocused();
  await expect(status).toContainText("(degrees): must be at most 180.");
  await expect(page.locator("#solve-param-containerRotation")).toHaveAttribute("aria-invalid", "true");
  await expect(field).not.toHaveAttribute("aria-invalid", "true");
  expect(await lastResult(page)).toBeNull();
  await page.fill("#solve-param-containerRotation", "180");
  await details.locator("summary").click();
  await page.click("#solve-run");
  const r = await completed(page);
  await expect(page.locator("#solve-param-containerRotation")).not.toHaveAttribute("aria-invalid", "true");
  expect(r.params.containerRotation).toBeCloseTo(Math.PI, 12);
  expect(r.params.adaptationSweeps).toBe(20);
  await choose(page, "basin_hopping", 60);
  expect(await page.locator("#solve-form").evaluate((f: HTMLFormElement) => f.checkValidity())).toBe(true);
  expect(await page.locator("#solve-param-alignmentTolerance").evaluate((i: HTMLInputElement) => i.value === i.max)).toBe(false);
  await page.locator("#solve-param-alignmentTolerance").evaluate((i: HTMLInputElement) => {
    i.value = i.max;
  });
  expect(await page.locator("#solve-form").evaluate((f: HTMLFormElement) => f.checkValidity())).toBe(true);
  await page.click("#solve-run");
  expect((await completed(page)).params.alignmentTolerance).toBe(0.1);
});

test("solve: a worker failure during a run leaves the panel usable with a fresh worker", async ({ page }) => {
  await page.addInitScript(() => {
    const Original = window.Worker;
    const made: any[] = [];
    (window as any).solveWorkers = made;
    (window as any).Worker = class {
      inner: Worker;
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      onmessageerror: ((e: MessageEvent) => void) | null = null;
      terminated = false;
      constructor(url: string | URL, options: WorkerOptions) {
        this.inner = new Original(url, options);
        this.inner.onmessage = (e) => this.onmessage?.(e);
        this.inner.onerror = (e) => this.onerror?.(e);
        made.push(this);
      }
      postMessage(data: unknown) {
        this.inner.postMessage(data);
      }
      terminate() {
        this.terminated = true;
        this.inner.terminate();
      }
    };
  });
  await openProblem(page, 4, 4, 11);
  const status = page.locator("#solve-status");
  for (const fail of [
    (w: any) => w.onerror(new ErrorEvent("error", { message: "synthetic crash", cancelable: true })),
    (w: any) => w.onmessageerror(new MessageEvent("messageerror")),
  ]) {
    await choose(page, "basin_hopping", 1000000);
    await page.click("#solve-run");
    await expect(page.locator("#solve-score")).not.toHaveText("—");
    const before = await page.evaluate(() => (window as any).solveWorkers.length);
    await page.evaluate(`(${fail.toString()})(window.solveWorkers.at(-1))`);
    await expect(status).toContainText("Optimizer failed during the run");
    await expect(page.locator("#solve-score")).toHaveText("—");
    await expect(status).toContainText("Run again");
    await expect(page.locator("#solve-run")).toBeEnabled();
    await expect(page.locator("#solve-method")).toBeEnabled();
    await expect(page.locator("#solve-stop")).toBeDisabled();
    await expect(page.locator("#solve-accept")).toBeDisabled();
    expect(await page.evaluate(() => (window as any).solveWorkers.at(-1).terminated)).toBe(true);
    // The replacement is created lazily by the next Run and completes a real job.
    expect(await page.evaluate(() => (window as any).solveWorkers.length)).toBe(before);
    await choose(page, "seed", 50);
    await page.click("#solve-run");
    const r = await completed(page);
    expect(r.valid && r.strict).toBe(true);
    expect(await page.evaluate(() => (window as any).solveWorkers.length)).toBe(before + 1);
    await expect(page.locator("#solve-accept")).toBeEnabled();
  }
});

test("solve: every accepted result stays attributed through undo history and a reload", async ({ page }) => {
  await openProblem(page, 4, 7, 3);
  await page.click("#add-all");
  const agent = page.locator("#agent"),
    note = page.locator("#agent-note");
  await choose(page, "asc", 100);
  await page.click("#solve-run");
  const first = await completed(page);
  await page.click("#solve-accept");
  const firstNote = 'asc; seed 1; budget {"evals":100}';
  await expect(note).toHaveValue(firstNote);
  await choose(page, "mc_compress", 100);
  await page.fill("#solve-seed", "7");
  await page.click("#solve-run");
  const second = await completed(page);
  expect(second.best!.pieces).not.toEqual(first.best!.pieces);
  await page.click("#solve-accept");
  const secondNote = 'mc_compress; seed 7; budget {"evals":100}';
  await expect(agent).toHaveValue("ai");
  await expect(note).toHaveValue(secondNote);
  // Undo lands exactly on the first solver result, which is still solver-made.
  await page.click("#undo");
  expect(await pieces(page)).toEqual(first.best!.pieces);
  await expect(agent).toHaveValue("ai");
  await expect(note).toHaveValue(firstNote);
  await page.click("#undo");
  await expect(agent).toHaveValue("human");
  await expect(note).toHaveValue("");
  await page.click("#redo");
  await page.click("#redo");
  expect(await pieces(page)).toEqual(second.best!.pieces);
  await expect(note).toHaveValue(secondNote);
  // The board is restored from storage on reload, and so is who made it.
  // The page saves the board 400 ms after its last change.
  await page.waitForTimeout(700);
  await page.reload();
  await expect(page.locator("#count")).toContainText("3 / 3");
  expect(await pieces(page)).toEqual(second.best!.pieces);
  await expect(agent).toHaveValue("ai");
  await expect(note).toHaveValue(secondNote);
  // Malformed stored attribution is ignored without breaking the panel.
  await page.evaluate(() => localStorage.setItem("polypack.solve.accepted", '{"not":["a list"]'));
  await page.reload();
  await expect(page.locator("#solve-run")).toBeEnabled();
  expect(await pieces(page)).toEqual(second.best!.pieces);
  await expect(agent).toHaveValue("human");
  await expect(note).toHaveValue("");
});

test("solve: accepting a result identical to a hand-made board does not attribute it to the solver", async ({
  page,
}) => {
  await openProblem(page, 0, 0, 3);
  await page.click("#add-all");
  const before = await page.evaluate(() => ({
    config: JSON.stringify((window as any).polypack.board.toConfig()),
    stored: localStorage.getItem("polypack.solve.accepted"),
  }));
  await choose(page, "basin_hopping", 1);
  await page.selectOption("#solve-start", "board");
  await page.click("#solve-run");
  const r = await completed(page);
  // Precondition of this case: one evaluation only scores the supplied board.
  expect(r.best!.pieces).toEqual(JSON.parse(before.config).pieces);
  await expect(page.locator("#solve-accept")).toBeEnabled();
  await page.click("#solve-accept");
  await expect(page.locator("#solve-status")).toContainText("identical to your board");
  await expect(page.locator("#agent")).toHaveValue("human");
  await expect(page.locator("#agent-note")).toHaveValue("");
  await expect(page.locator("#solve-accept")).toBeDisabled();
  expect(
    await page.evaluate(() => ({
      config: JSON.stringify((window as any).polypack.board.toConfig()),
      stored: localStorage.getItem("polypack.solve.accepted"),
    })),
  ).toEqual(before);
});

test("solve: a worker that dies before it is ready is replaced and the status says when", async ({ page }) => {
  await page.addInitScript(() => {
    const Original = window.Worker;
    const made: any[] = [];
    (window as any).solveWorkers = made;
    (window as any).Worker = class {
      inner: Worker;
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: ((e: ErrorEvent) => void) | null = null;
      constructor(url: string | URL, options: WorkerOptions) {
        this.inner = new Original(url, options);
        const first = made.length === 0;
        // The first worker never reports ready; later ones behave normally.
        this.inner.onmessage = (e) => !first && this.onmessage?.(e);
        made.push(this);
      }
      postMessage(data: unknown) {
        this.inner.postMessage(data);
      }
      terminate() {
        this.inner.terminate();
      }
    };
  });
  await openProblem(page, 0, 0, 3);
  const status = page.locator("#solve-status");
  await expect(page.locator("#solve-run")).toBeDisabled();
  await page.evaluate(() =>
    (window as any).solveWorkers[0].onerror(new ErrorEvent("error", { message: "failed to load", cancelable: true })),
  );
  await expect(status).toContainText("Optimizer failed: failed to load");
  await expect(page.locator("#solve-run")).toBeEnabled();
  await page.click("#solve-run");
  await expect(status).toHaveText("Optimizer ready. Choose a method, then run.");
  await expect(page.locator("#solve-method option")).toHaveCount(9);
  expect(await lastResult(page)).toBeNull();
  await choose(page, "seed", 50);
  await page.click("#solve-run");
  expect((await completed(page)).strict).toBe(true);
});
