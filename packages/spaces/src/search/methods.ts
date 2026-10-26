/**
 * The search methods a space problem offers, as the board and the volunteer client choose them:
 *
 *  - "auto", always first and the default: the space's own search (run.ts runEngine), as before
 *    methods could be chosen;
 *  - the generic methods of @polypack/methods that the problem's kernel can run (kernels.ts),
 *    when its space builds one for it: methodsFor(kernel), in their registration order;
 *  - for surface problems in the nofold mode, which are planar problems of one face, the polygon
 *    solver's own methods instead (nofold.ts; the board runs them in apps/web/src/space/nofold-round.ts).
 *    They come from nofold-methods.ts, which holds the polygon solver, so that a client that does
 *    not offer them does not load it: until useNofoldMethods() has run, nofold problems offer Auto
 *    alone.
 *
 * A result's method is recorded under a name that reads like the spaces' earlier ones
 * (SPACE_METHOD): the space, then the method ("sphere basin_hopping").
 */
import { getMethod, methodParams, methodsFor } from "@polypack/methods";
import { type ParameterSchema, clone, fillDefaults, validate } from "@polypack/solver/schema";
import type { SpaceName } from "../types";
import { spaceKernel, spaceKernelError } from "./kernels";
import { SPACE_METHOD, SURFACE_NOFOLD_METHOD, type SearchProblem, nofoldOnPolygonEngine } from "./model";

/** The name of each problem's own search. */
export const AUTO = "auto";

/**
 * The kinds of search: one per space, the planar search of nofold problems on the Platonic solids
 * ("nofold"), and the surface search in its nofold mode on the other solids ("nofold-surface"), whose
 * faces are not all one regular polygon.
 */
export type SearchKind = SpaceName | "nofold" | "nofold-surface";

export const searchKind = (p: SearchProblem): SearchKind =>
  p.space === "surface" && p.mode === "nofold" ? (nofoldOnPolygonEngine(p) ? "nofold" : "nofold-surface") : p.space;

/** What Auto does in each kind, in the board's words. */
export const AUTO_TEXT: Record<SearchKind, string> = {
  surface:
    "Fold search: penalty compression on the solid, basin hopping and a contact polish, then the space's own validator.",
  nofold:
    "Every piece stays in one face, so the fullest face is a planar problem: basin hopping packs it, and the result is copied onto every face.",
  "nofold-surface":
    "Every piece stays in one face: penalty compression of the pieces in their faces, basin hopping and a contact polish, then the space's own validator.",
  curved: "Penalty compression at curvature K, an LP polish and basin hopping, in rounds from the best so far.",
  sphere: "Penalty relaxation, the smallest valid radius by bisection with the space's validator, and basin hopping.",
  torus: "Penalty relaxation, the smallest valid lattice by bisection with the space's validator, and basin hopping.",
  boundary:
    "Penalty relaxation of the pieces across the cells, compression of the edge s, a polish, and hops between basins; every result passes the space's validator.",
  polyhedra:
    "Soft hops of a soft-to-rigid simulator and random jiggles from the best so far, each polished by a separating-plane penalty method, then the space's own validator.",
  balls:
    "Basin hopping from the best so far: move or shake some pieces, then a penalty method with the container's size as a variable (separating planes for solids), scaled apart to an exact clearance, then the space's own validator.",
};

/** The polygon method Auto runs on the face of a nofold problem. */
export const NOFOLD_AUTO = "basin_hopping";
/** The name a nofold result of Auto is recorded under. */
export const NOFOLD_METHOD = "surface nofold: basin hopping on one face";

/** A method as a client offers it. */
export interface SpaceMethodInfo {
  /** "auto", or the method's name in its registry. */
  name: string;
  title: string;
  /** One plain sentence. */
  summary: string;
  /** Its parameters (Auto has none). */
  schema: ParameterSchema;
  defaults: Record<string, unknown>;
}

const NO_PARAMETERS: ParameterSchema = { type: "object", additionalProperties: false, properties: {} };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isName = (v: string) => /^[a-z][a-z0-9_]*$/.test(v);

let nofold: readonly SpaceMethodInfo[] = [];

/** Sets the polygon solver's methods that nofold problems offer (nofold-methods.ts useNofoldMethods). */
export function setNofoldMethods(methods: readonly SpaceMethodInfo[]): void {
  nofold = methods;
}

/** The polygon solver's methods a nofold problem offers, once nofold-methods.ts has given them. */
export const nofoldMethods = (): readonly SpaceMethodInfo[] => nofold;

/** True when `method` names the space's own search: none, "auto", or the name jobs carried before methods could be chosen. */
export const isAutoMethod = (space: SpaceName, method: string | undefined): boolean =>
  method === undefined || method === AUTO || method === SPACE_METHOD[space];

/** Auto, then the methods the problem's kernel can run (or, for nofold, the polygon solver's). */
export function spaceMethodsFor(p: SearchProblem): SpaceMethodInfo[] {
  const auto: SpaceMethodInfo = {
    name: AUTO,
    title: "Auto",
    summary: AUTO_TEXT[searchKind(p)],
    schema: NO_PARAMETERS,
    defaults: {},
  };
  // the polygon solver packs one face, which needs every face alike: the Platonic solids' ("nofold");
  // the other solids' nofold problems run the surface search's nofold mode, Auto only
  if (searchKind(p) === "nofold") return [auto, ...nofoldMethods()];
  if (searchKind(p) === "nofold-surface") return [auto];
  const kernel = spaceKernel(p);
  if (!kernel) return [auto];
  return [
    auto,
    ...methodsFor(kernel).map((m) => ({
      name: m.name,
      title: m.title,
      summary: m.summary,
      schema: m.schema,
      defaults: m.defaults,
    })),
  ];
}

/** True when the problem offers the method. */
export const offersSpaceMethod = (p: SearchProblem, method: string): boolean =>
  isAutoMethod(p.space, method) || spaceMethodsFor(p).some((m) => m.name === method);

/**
 * Why a method and its parameters cannot run on the problem, in a sentence, or null when they
 * can. `params` overrides the method's defaults; Auto takes none.
 */
export function checkSpaceMethod(p: SearchProblem, method: string | undefined, params?: unknown): string | null {
  if (params !== undefined && !isObject(params)) return "the method's parameters must be a JSON object";
  const given = params !== undefined && Object.keys(params).length > 0;
  if (isAutoMethod(p.space, method)) return given ? "auto, the space's own search, takes no parameters" : null;
  const name = method!;
  const offered = spaceMethodsFor(p);
  const list = offered.map((m) => m.name).join(", ");
  const m = offered.find((o) => o.name === name);
  if (!m) {
    if (searchKind(p) !== "nofold" && isName(name) && getMethod(name) && spaceKernel(p))
      return `${name} needs a kernel capability (${getMethod(name)!.requires.join(", ")}) that ${p.space} lacks; ${p.id} offers ${list}`;
    if (searchKind(p) !== "nofold" && isName(name) && getMethod(name))
      return `${p.id} offers no generic method (${spaceKernelError(p) ?? "it has no kernel"}): use auto`;
    return `unknown method ${JSON.stringify(name.slice(0, 40))} for ${p.id}; it offers ${list}`;
  }
  try {
    if (searchKind(p) === "nofold") validate(m.schema, fillDefaults(clone(m.defaults), params ?? {}));
    else methodParams(getMethod(name)!, (params ?? {}) as Record<string, unknown>);
  } catch (error) {
    return `${name}: ${(error as Error).message}`;
  }
  return null;
}

/**
 * The name a space result's method is recorded under: the space's own search name for Auto
 * (SPACE_METHOD, "sphere basin hopping"), else the space and the method ("sphere basin_hopping").
 * A name that is already a description (an older record's) is kept as it is.
 */
export function spaceMethodName(space: SpaceName, method?: string): string {
  if (isAutoMethod(space, method)) return SPACE_METHOD[space];
  return isName(method!) ? `${space} ${method}` : method!;
}

/**
 * The name a submission gives a result, with the method's parameters when the run had any and
 * they fit in `max` characters, so that the entry says how to reproduce it: "sphere penalty
 * {"seedShare":0.5}". Parameters that do not fit are left out (the volunteer client's best file
 * and history keep them in full).
 */
export function spaceMethodNote(
  space: SpaceName,
  method: string | undefined,
  params: Record<string, unknown> | undefined,
  max = 80,
): string {
  const name = spaceMethodName(space, method);
  if (!params || !Object.keys(params).length || isAutoMethod(space, method)) return name;
  const full = `${name} ${JSON.stringify(params)}`;
  return full.length <= max ? full : name;
}

/** As spaceMethodName, with the nofold problems' names: "surface nofold: penalty on one face". */
export function searchMethodName(p: SearchProblem, method?: string): string {
  if (searchKind(p) === "nofold-surface" && isAutoMethod(p.space, method)) return SURFACE_NOFOLD_METHOD;
  if (searchKind(p) !== "nofold") return spaceMethodName(p.space, method);
  return isAutoMethod(p.space, method) ? NOFOLD_METHOD : `surface nofold: ${method} on one face`;
}
