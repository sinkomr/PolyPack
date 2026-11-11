// Writes the texts of the API page (apps/server/src/docs.ts) for the Rust server, so that they are
// not retyped (native/PORTING.md, rule 6):
//
//   native/server/data/docs.json         the template literals of docs.ts, each as its parts (a text,
//                                        or the source of a `${...}` expression, which
//                                        native/server/src/docs.rs evaluates), and SOLVER_METHODS;
//   native/server/data/spaces_docs.json  what docs.ts takes from @polypack/spaces: the stand-in the
//                                        Rust server uses until native/spaces is ported (and the
//                                        values that port's own constants must equal).
//
//   node --import tsx native/tools/app-docs.mts           writes the files
//   node --import tsx native/tools/app-docs.mts --check   fails when a file is out of date
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { SOLVER_METHODS } from "../../apps/server/src/docs.ts";
import {
  BOUNDARY_MAX_CHAINS,
  BOUNDARY_MAX_S,
  POLYHEDRA_MAX_QUATERNION,
  SPACE_BOUND_SLACK,
  SPACE_EXHIBITS,
  SPACE_INFO,
  SPACE_MAX_COORD,
  SPACE_MAX_P,
  SPACE_MAX_SIZE,
  SPACE_MIN_QUATERNION_NORM,
  SPACE_NAMES,
  SPACE_RECORD_MARGIN,
  SPACE_STRICT_NO_RECORD_REASON,
  SPACE_STRICT_REASON,
  SPACE_STRICT_TOL,
  SPACE_TOL,
  SURFACE_MAX_CHAINS,
  TORUS_MAX_TRANSLATES,
} from "@polypack/spaces";

const root = resolve(import.meta.dirname, "../..");
const sourcePath = resolve(root, "apps/server/src/docs.ts");
const source = ts.createSourceFile("docs.ts", readFileSync(sourcePath, "utf8"), ts.ScriptTarget.ES2022, true);

type Part = { text: string } | { expr: string };

/** A template literal as its parts: the cooked texts and the source of each expression between them. */
function partsOf(node: ts.Expression): Part[] {
  if (ts.isNoSubstitutionTemplateLiteral(node)) return [{ text: node.text }];
  if (!ts.isTemplateExpression(node)) throw new Error(`not a template literal: ${node.getText().slice(0, 60)}`);
  const parts: Part[] = [{ text: node.head.text }];
  for (const span of node.templateSpans) {
    parts.push({ expr: span.expression.getText(source) });
    parts.push({ text: span.literal.text });
  }
  return parts.filter((p) => !("text" in p) || p.text !== "");
}

const templates: Record<string, Part[]> = {};
for (const statement of source.statements) {
  // const NAME = `...`
  if (ts.isVariableStatement(statement))
    for (const d of statement.declarationList.declarations)
      if (ts.isIdentifier(d.name) && d.initializer && (ts.isTemplateExpression(d.initializer) || ts.isNoSubstitutionTemplateLiteral(d.initializer)))
        templates[d.name.text] = partsOf(d.initializer);
  // function name() { ...; return `...`; }: the page and its section on the spaces
  if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
    const last = statement.body.statements[statement.body.statements.length - 1];
    if (last && ts.isReturnStatement(last) && last.expression && ts.isTemplateExpression(last.expression))
      templates[statement.name.text] = partsOf(last.expression);
  }
}
for (const name of ["PYTHON", "CURL", "SCHEMA", "RESPONSE", "LEADERS", "PROBLEM", "SOLVE_TS", "SOLVE_CLI", "SPACES_CURL", "SPACE_PROBLEM", "SPACE_SUBMIT", "SPACE_SUBMIT_RESPONSE", "spacesSection", "docsPage"])
  if (!templates[name]) throw new Error(`docs.ts has no template ${name} any more: native/server/src/docs.rs needs a look`);

const docs = JSON.stringify({ source: "apps/server/src/docs.ts", templates, methods: SOLVER_METHODS }, null, 1) + "\n";

const spaces =
  JSON.stringify(
    {
      source: "@polypack/spaces, as apps/server/src/docs.ts reads it",
      names: SPACE_NAMES,
      info: SPACE_NAMES.map((name) => {
        const i = SPACE_INFO[name];
        return { name, viewer: i.viewer, title: i.title, summary: i.summary, problem_id: i.problem_id, conventions: Object.entries(i.conventions), score: i.score, docs: i.docs };
      }),
      exhibits: SPACE_EXHIBITS.map((e) => ({ viewer: e.viewer, title: e.title, summary: e.summary, docs: e.docs })),
      max_p: SPACE_NAMES.map((name) => [name, SPACE_MAX_P[name]]),
      bound_slack: SPACE_BOUND_SLACK,
      min_quaternion_norm: SPACE_MIN_QUATERNION_NORM,
      strict_no_record_reason: SPACE_STRICT_NO_RECORD_REASON,
      strict_reason: SPACE_STRICT_REASON,
      strict_tol: SPACE_STRICT_TOL,
      max_coord: SPACE_MAX_COORD,
      max_size: SPACE_MAX_SIZE,
      polyhedra_max_quaternion: POLYHEDRA_MAX_QUATERNION,
      record_margin_polyhedra: SPACE_RECORD_MARGIN.polyhedra,
      tol: SPACE_TOL,
      surface_max_chains: SURFACE_MAX_CHAINS,
      torus_max_translates: TORUS_MAX_TRANSLATES,
      boundary_max_chains: BOUNDARY_MAX_CHAINS,
      boundary_max_s: BOUNDARY_MAX_S,
    },
    null,
    1,
  ) + "\n";

const files: [string, string][] = [
  [resolve(root, "native/server/data/docs.json"), docs],
  [resolve(root, "native/server/data/spaces_docs.json"), spaces],
];
if (process.argv.includes("--check")) {
  let stale = 0;
  for (const [path, text] of files) {
    let have = "";
    try {
      have = readFileSync(path, "utf8");
    } catch {
      // missing
    }
    if (have !== text) {
      stale++;
      console.error(`${path} is out of date: run node --import tsx native/tools/app-docs.mts`);
    }
  }
  process.exit(stale ? 1 : 0);
}
for (const [path, text] of files) {
  writeFileSync(path, text);
  console.log(`${path}: ${text.length} bytes`);
}
