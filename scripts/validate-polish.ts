import { readFileSync } from "node:fs";
import { evaluate, parseConfig } from "@polypack/geometry";

const [inputPath, resultPath] = process.argv.slice(2);
if (!inputPath || inputPath === "--help" || !resultPath) {
  console.log(
    "Usage: node --import tsx scripts/validate-polish.ts contacts.json refined.json\nPrints the improved valid result, otherwise the valid input; all scores use server auto-orientation.",
  );
} else {
  const input = JSON.parse(readFileSync(inputPath, "utf8"));
  const output = JSON.parse(readFileSync(resultPath, "utf8"));
  const start = parseConfig(input.config);
  const refined = parseConfig(output.config);
  const before = start.ok ? evaluate(start.config, { autoOrient: true }) : undefined;
  const after = refined.ok ? evaluate(refined.config, { autoOrient: true }) : undefined;
  const sameProblem =
    start.ok && refined.ok && ["N", "M", "P"].every((key) => start.config[key as "N"] === refined.config[key as "N"]);
  const improved =
    sameProblem && after?.valid && after.score !== null && (!before?.valid || after.score < before.score!);
  console.log(
    JSON.stringify(
      {
        config: improved && refined.ok ? refined.config : before?.valid && start.ok ? start.config : null,
        score: improved ? after!.score : before?.valid ? before.score : null,
        valid: !!(improved || before?.valid),
        accepted_refinement: !!improved,
        container_size_50_digits: improved ? output.container_size_50_digits : null,
      },
      null,
      2,
    ),
  );
}
