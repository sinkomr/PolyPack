/** Three-dimensional views of the Dimensions packings, drawn with three.js. */
export { createBoundaryView, VIEWS, type BoundaryView, type BoundaryViewOptions, type ViewKey } from "./view";
export type { Engine } from "./model";
export { engineFor } from "./engine";
export type { PieceShape } from "./clip";
export { ballRadius } from "./clip";
// the pure parts, for tests and for other drawings
export { gridLayout, type GridLayout, type Tile } from "./layout";
export { Folder, foldAlignment, INNER_RATIO } from "./fold";
export { ballSectionRadius, slicePlane, stripPositions, SLICE_CUT, SLICE_MISS, SLICE_WHOLE } from "./slice";
export { cellColors, cellNames, pieceColor } from "./palette";
