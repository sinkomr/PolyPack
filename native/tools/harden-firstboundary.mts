// harden-firstboundary.mts PORT (a tool of the hardening, item 9): how long the first submission on each
// 4-polytope of the boundary space takes, and the second. The server builds a polytope's table once
// (the 120-cell and the 600-cell take about 0.3 s each); the first submission paid for it before the
// tables were built at startup. Posts research records back to a local server; sends nothing elsewhere.
//   node --import tsx native/tools/harden-firstboundary.mts 24107
import { researchRecords } from "./serverdiff/scenarios/data.mts";
const port = Number(process.argv[2]);
// one ball in one cell, as the tesseract's record has it: a configuration of the form of every polytope's P = 1
const ball = researchRecords("boundary", 100000, 500, 1).find((r) => r.id === "boundary/tesseract/ball/1")!;
const lines: string[] = [];
for (const polytope of ["tesseract", "5cell", "16cell", "24cell", "120cell", "600cell"]) {
  const times: string[] = [];
  for (let k = 0; k < 2; k++) {
    const t = performance.now();
    const res = await fetch(`http://127.0.0.1:${port}/api/spaces/submit`, { method: "POST", body: JSON.stringify({ space: "boundary", id: `boundary/${polytope}/ball/1`, name: "first", units: "diameter", config: { ...ball.config, s: 50 } }), headers: { "x-test-client-ip": `10.4.0.${k + 1}` } });
    const text = await res.text();
    times.push(`${res.status} in ${(performance.now() - t).toFixed(1)} ms${k === 0 ? " " + text.slice(0, 60) : ""}`);
  }
  lines.push(`boundary/${polytope}/ball/1: ${times.join("; then ")}`);
}
console.log(lines.join("\n"));
