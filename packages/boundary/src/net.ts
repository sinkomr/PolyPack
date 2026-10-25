/**
 * Unfolded nets of the boundary into R^3, for drawing.
 *
 * A net is a spanning tree of the cells' adjacency; each cell is placed by composing the gluings
 * along the tree path from the root: if cell c hangs from its parent p across c's facet f, then
 * c's facet f's `toNeighbor` takes c's frame (beyond f) to p's frame, so
 *   place(c) = place(p) ∘ c.facets[f].toNeighbor.
 * The root's frame is the net's frame.
 */
import { isoCompose, isoFromAffine, isoToAffine, ISO_IDENTITY, Iso3 } from "./linalg";
import type { NetPlacement, Polytope } from "./types";

/** Places the cells along a tree given as parent links (child cell -> [parent cell, child's facet glued to it]). */
export function netFromTree(poly: Polytope, root: number, parents: Map<number, [number, number]>): NetPlacement[] {
  const place = new Map<number, Iso3>([[root, ISO_IDENTITY]]);
  const resolve = (c: number, guard = 0): Iso3 => {
    const got = place.get(c);
    if (got) return got;
    if (guard > poly.cells.length) throw new Error("netFromTree: the parent links are not a tree");
    const link = parents.get(c);
    if (!link) throw new Error(`netFromTree: cell ${c} is not connected to the root`);
    const [p, f] = link;
    const facet = poly.cells[c].facets[f];
    if (facet.neighbor !== p) throw new Error(`netFromTree: facet ${f} of cell ${c} is not glued to cell ${p}`);
    const T = isoCompose(resolve(p, guard + 1), isoFromAffine(facet.toNeighbor));
    place.set(c, T);
    return T;
  };
  return poly.cells.map((cell) => {
    const c = cell.index;
    const link = parents.get(c);
    return { cell: c, place: isoToAffine(resolve(c)), parent: c === root || !link ? null : { cell: link[0], facet: link[1] } };
  });
}

/** Breadth-first spanning tree from cell 0, facets in index order: a generic net (it may overlap itself for some polytopes). */
export function bfsNet(poly: Polytope): NetPlacement[] {
  const parents = new Map<number, [number, number]>();
  const seen = new Set<number>([0]);
  const queue = [0];
  while (queue.length) {
    const c = queue.shift()!;
    for (const f of poly.cells[c].facets) {
      if (seen.has(f.neighbor)) continue;
      seen.add(f.neighbor);
      parents.set(f.neighbor, [c, f.neighborFacet]);
      queue.push(f.neighbor);
    }
  }
  return netFromTree(poly, 0, parents);
}

/**
 * The default net. For the tesseract: the Dali cross, four cubes in a column along the net's z
 * axis (cells 7, 0, 6, 1 from the top) and four around the second from the top (cells 2, 3, 4, 5
 * around cell 0 along -x, +x, -y, +y). Cell 0 (x0 = -1/2) is the root, so net coordinates are
 * cell 0's local coordinates (4D axes x1, x2, x3). Other polytopes: the breadth-first net.
 */
export function defaultNet(poly: Polytope): NetPlacement[] {
  if (poly.name !== "tesseract") return bfsNet(poly);
  const parents = new Map<number, [number, number]>();
  // cell 0's facets 0..5 are -x, +x, -y, +y, -z, +z, glued to cells 2, 3, 4, 5, 6, 7
  for (const f of poly.cells[0].facets) parents.set(f.neighbor, [0, f.neighborFacet]);
  // cell 1 (x0 = +1/2, opposite cell 0) hangs below cell 6 (the cube under cell 0)
  const f61 = poly.cells[1].facets.findIndex((f) => f.neighbor === 6);
  parents.set(1, [6, f61]);
  return netFromTree(poly, 0, parents);
}
