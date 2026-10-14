import { FoundWith, Pose, StrictResult } from "@polypack/geometry";
import { foundWithLabel } from "./found-with";
import { el, shapeLabel } from "./shapes-ui";

interface Pending {
  id: number;
  N: number;
  M: number;
  P: number;
  name: string;
  found_with: FoundWith | null;
  agent_note: string;
  score: number;
  created_at: string;
  literature_value: number | null;
  strict_check: StrictResult | null;
  pieces: Pose[];
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const token = $<HTMLInputElement>("token");
const note = $("note");
// the token is kept for this browser tab only
token.value = sessionStorage.getItem("polypack.admin") ?? "";
const headers = () => ({ authorization: `Bearer ${token.value}`, "content-type": "application/json" });

async function review(id: number, decision: "confirmed" | "rejected"): Promise<void> {
  const r = await fetch("/api/admin/review", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ id, decision }),
  });
  note.textContent = r.ok ? `Submission ${id} ${decision}.` : `Could not update submission ${id} (${r.status}).`;
  if (r.ok) load();
}

async function load(): Promise<void> {
  sessionStorage.setItem("polypack.admin", token.value);
  const tbody = $("rows");
  tbody.replaceChildren();
  let r: Response;
  try {
    r = await fetch("/api/admin/pending", { headers: headers() });
  } catch {
    note.textContent = "The server is not reachable.";
    return;
  }
  if (!r.ok) {
    note.textContent =
      r.status === 401
        ? "Wrong token."
        : r.status === 503
          ? "ADMIN_TOKEN is not set on the server."
          : `Error ${r.status}.`;
    return;
  }
  const { pending } = (await r.json()) as { pending: Pending[] };
  note.textContent = pending.length ? `${pending.length} pending.` : "Nothing is pending.";
  for (const p of pending) {
    const tr = el("tr");
    const found = foundWithLabel(p.found_with);
    tr.append(el("td", String(p.id)));
    tr.append(el("td", `${p.P} ${shapeLabel(p.N)}s in a ${shapeLabel(p.M)} (N=${p.N}, M=${p.M})`));
    tr.append(
      el(
        "td",
        `${p.name}${found ? ` (${found})` : ""}${p.agent_note ? " — " + p.agent_note : ""}, ${p.created_at.slice(0, 16).replace("T", " ")}`,
      ),
    );
    tr.append(el("td", String(p.score)));
    tr.append(el("td", p.literature_value === null ? "—" : String(p.literature_value)));
    const s = p.strict_check;
    tr.append(el("td", s ? (s.ok ? `✓ passed, certified ${s.certifiedSize}` : `✗ failed: ${s.reason}`) : "—"));
    const actions = el("td");
    const open = el("a", "open");
    open.href = `/#s=${p.id}`;
    open.target = "_blank";
    const yes = el("button", "Confirm");
    yes.addEventListener("click", () => review(p.id, "confirmed"));
    const no = el("button", "Reject");
    no.addEventListener("click", () => review(p.id, "rejected"));
    actions.append(open, " ", yes, " ", no);
    tr.append(actions);
    tbody.append(tr);
  }
}

async function remove(): Promise<void> {
  const id = Number($<HTMLInputElement>("remove-id").value);
  if (!Number.isInteger(id) || id < 1) {
    note.textContent = "Enter the entry's number.";
    return;
  }
  const r = await fetch("/api/admin/remove", { method: "POST", headers: headers(), body: JSON.stringify({ id }) });
  note.textContent = r.ok
    ? `Entry ${id} removed.`
    : r.status === 404
      ? `There is no listed entry ${id}.`
      : r.status === 401
        ? "Wrong token."
        : `Could not remove entry ${id} (${r.status}).`;
  if (r.ok) load();
}

$("load").addEventListener("click", load);
$("remove").addEventListener("click", remove);
token.addEventListener("keydown", (e) => {
  if (e.key === "Enter") load();
});
if (token.value) load();
