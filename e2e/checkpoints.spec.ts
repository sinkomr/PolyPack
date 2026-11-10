import { expect, test } from "@playwright/test";
import { PackingConfig } from "@polypack/geometry";
import { openProblem } from "./helpers";

declare const polypack: { board: { load(c: PackingConfig): string | null } };

const square = (x: number) => ({ x, y: 0, theta: 0 });
const board = (...xs: number[]): PackingConfig => ({ N: 4, M: 4, P: 2, container_phi: 0, pieces: xs.map(square) });

test("checkpoints are kept per problem across reloads, load onto the board, and can be deleted", async ({ page }) => {
  await openProblem(page, 4, 4, 2);
  const list = page.locator("#checkpoint-list li");
  await expect(page.locator("#checkpoint-save")).toBeDisabled(); // nothing on the board yet
  await expect(page.locator("#checkpoint-note")).toContainText("No checkpoints for 4/4/2 yet");

  const save = async (c: PackingConfig, name: string) => {
    await page.evaluate((c) => polypack.board.load(c), c);
    await page.fill("#checkpoint-name", name);
    await page.click("#checkpoint-save");
  };
  await save(board(0, 2), "wide");
  const wide = await page.locator("#score").textContent();
  await save(board(0, 1.5), ""); // unnamed: numbered
  await save(board(0), "one placed");
  await expect(list).toHaveCount(3);

  // kept in the browser: a reload lists them again, best first and the incomplete one last
  await page.reload();
  await expect(list).toHaveCount(3);
  await expect(list.nth(0)).toContainText("Checkpoint 2");
  await expect(list.nth(1)).toContainText("wide");
  await expect(list.nth(2)).toContainText("1 / 2 pieces — one placed");

  await page.getByRole("button", { name: "Load the checkpoint one placed" }).click();
  await expect(page.locator("#count")).toHaveText("1 / 2");
  await page.getByRole("button", { name: "Load the checkpoint wide" }).click();
  await expect(page.locator("#count")).toContainText("2 / 2");
  await expect(page.locator("#score")).toHaveText(wide!.trim());

  await page.getByRole("button", { name: "Delete the checkpoint one placed" }).click();
  await expect(list).toHaveCount(2);

  // the overview of every problem, and deleting them all: refused once, then confirmed
  await page.locator("#checkpoint-all summary").click();
  await expect(page.locator("#checkpoint-all summary")).toContainText("2 on 1 problem");
  await expect(page.locator("#checkpoint-table-body tr")).toHaveCount(1);
  page.once("dialog", (d) => d.dismiss());
  await page.click("#checkpoint-delete-all");
  await expect(list).toHaveCount(2);
  page.once("dialog", (d) => d.accept());
  await page.click("#checkpoint-delete-all");
  await expect(list).toHaveCount(0);
  await expect(page.locator("#checkpoint-all")).toBeHidden();
  await page.reload();
  await expect(page.locator("#checkpoint-note")).toContainText("No checkpoints for 4/4/2 yet");
});

test("a name typed while the last checkpoint is still being written is kept", async ({ page }) => {
  // IndexedDB made slow: every transaction reports its completion 600 ms late, as on a busy machine
  await page.addInitScript(() => {
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: Parameters<IDBDatabase["transaction"]>) {
      const tx = transaction.apply(this, args);
      Object.defineProperty(tx, "oncomplete", {
        set(fn: () => void) {
          tx.addEventListener("complete", () => setTimeout(fn, 600));
        },
      });
      return tx;
    };
  });
  await openProblem(page, 4, 4, 2);
  const list = page.locator("#checkpoint-list li");
  await page.evaluate((c) => polypack.board.load(c), board(0, 2));
  await page.fill("#checkpoint-name", "first");
  await page.click("#checkpoint-save");
  // the next name is typed at once; the first save finishes meanwhile
  await page.fill("#checkpoint-name", "second");
  await expect(list).toHaveCount(1);
  await expect(page.locator("#checkpoint-name")).toHaveValue("second");
  await page.click("#checkpoint-save");
  await expect(list).toHaveCount(2);
  await expect(list.filter({ hasText: "second" })).toHaveCount(1);
  await expect(list.filter({ hasText: "Checkpoint" })).toHaveCount(0);
});

test("the overview loads the best checkpoint of another problem", async ({ page }) => {
  await openProblem(page, 4, 4, 2);
  await page.evaluate((c) => polypack.board.load(c), board(0, 2));
  await page.click("#checkpoint-save");
  await expect(page.locator("#checkpoint-list li")).toHaveCount(1);
  await page.goto("/#p=6,0,3");
  await expect(page.locator("#checkpoint-note")).toContainText("No checkpoints for 6/0/3 yet");
  await page.locator("#checkpoint-all summary").click();
  await page.getByRole("button", { name: "Load the best checkpoint of 4/4/2" }).click();
  await expect(page.locator("#count")).toContainText("2 / 2");
  await expect(page.locator("#checkpoint-list li")).toHaveCount(1);
});
