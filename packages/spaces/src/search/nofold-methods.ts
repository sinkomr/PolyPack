/**
 * The polygon solver's methods as surface problems in the nofold mode offer them (methods.ts):
 * all but identity, which only evaluates its start, under their schemas' titles and the first
 * sentence of their descriptions. This module holds the whole polygon solver, so it is apart from
 * the search entry: the board's page imports it only when it shows a nofold problem, its search
 * thread when it starts ("@polypack/spaces/search/nofold-methods"). The package has no side
 * effects, so the methods are given by a call, not by the import.
 */
import { registry } from "@polypack/solver";
import { setNofoldMethods } from "./methods";

/** The first sentence of a text. */
const firstSentence = (text: string) => {
  const end = text.search(/\.(\s|$)/);
  return end < 0 ? text : text.slice(0, end + 1);
};

/** Gives nofold problems the polygon solver's methods (spaceMethodsFor, checkSpaceMethod). */
export function useNofoldMethods(): void {
  setNofoldMethods(
    registry
      .list()
      .filter((m) => m.name !== "identity")
      .map((m) => ({
        name: m.name,
        title: m.schema.title ?? m.name,
        summary: firstSentence(m.schema.description ?? ""),
        schema: m.schema,
        defaults: m.defaults,
      })),
  );
}
