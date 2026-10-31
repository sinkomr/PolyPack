import type { RecordPair } from "./api";

/**
 * The marks of the records page's shape menus: a piece is marked when any of its pairs has a published
 * value or a site entry, a container when its pair with the chosen piece has.
 */
export const RECORD_MARK = "✓";

export interface RecordShapes {
  pieces: Set<number>;
  /** For each piece, the containers it has records in. */
  containers: Map<number, Set<number>>;
}

export function recordShapes(pairs: readonly RecordPair[]): RecordShapes {
  const shapes: RecordShapes = { pieces: new Set(), containers: new Map() };
  for (const { N, M } of pairs) addRecordPair(shapes, N, M);
  return shapes;
}

/** Notes one more pair with records, such as one that got its first entry while the page is open. */
export function addRecordPair(shapes: RecordShapes, N: number, M: number): void {
  shapes.pieces.add(N);
  let c = shapes.containers.get(N);
  if (!c) shapes.containers.set(N, (c = new Set()));
  c.add(M);
}

export const markedLabel = (label: string, marked: boolean): string => (marked ? `${label} ${RECORD_MARK}` : label);
