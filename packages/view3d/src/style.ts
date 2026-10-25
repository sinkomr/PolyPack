/**
 * The view's own stylesheet, injected once per document. Every rule is scoped to .pp3, and the
 * colours read the site's custom properties (style.css) with fallbacks, so the view looks at home
 * on the site and still works on a bare page.
 */
const CSS = `
.pp3 {
  --pp3-bg: var(--bg, #f6f7f9);
  --pp3-panel: var(--panel, #ffffff);
  --pp3-text: var(--text, #1a1d21);
  --pp3-muted: var(--muted, #56606b);
  --pp3-border: var(--border, #c9ced6);
  --pp3-accent: var(--accent, #0b5fd1);
  --pp3-accent-text: var(--accent-text, #ffffff);
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: var(--pp3-text);
  background: var(--pp3-bg);
  font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
}
@media (prefers-color-scheme: dark) {
  .pp3 {
    --pp3-bg: var(--bg, #14171b);
    --pp3-panel: var(--panel, #1d2127);
    --pp3-text: var(--text, #e8ebef);
    --pp3-muted: var(--muted, #a3acb8);
    --pp3-border: var(--border, #3a414b);
    --pp3-accent: var(--accent, #6aa9ff);
    --pp3-accent-text: var(--accent-text, #0b1420);
  }
}
.pp3 *, .pp3 *::before, .pp3 *::after { box-sizing: border-box; }
.pp3 [hidden] { display: none !important; }
.pp3-bar, .pp3-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  background: var(--pp3-panel);
  border-bottom: 1px solid var(--pp3-border);
}
.pp3-controls { gap: 6px 14px; }
.pp3-group { display: inline-flex; gap: 4px; align-items: center; }
.pp3-group > .pp3-lab { color: var(--pp3-muted); margin-right: 2px; }
.pp3 button {
  font: inherit;
  color: inherit;
  background: var(--pp3-bg);
  border: 1px solid var(--pp3-border);
  border-radius: 6px;
  padding: 4px 10px;
  min-height: 36px;
  min-width: 36px;
  cursor: pointer;
  white-space: nowrap;
}
.pp3 button:hover:not(:disabled) { border-color: var(--pp3-accent); }
.pp3 button:disabled { opacity: 0.5; cursor: default; }
.pp3 button[aria-pressed="true"] {
  background: var(--pp3-accent);
  color: var(--pp3-accent-text);
  border-color: var(--pp3-accent);
}
.pp3 :focus-visible { outline: 3px solid var(--pp3-accent); outline-offset: 2px; }
.pp3-spacer { flex: 1; }
.pp3-range { display: flex; align-items: center; gap: 8px; flex: 1 1 240px; min-width: 0; }
.pp3-range label { color: var(--pp3-muted); white-space: nowrap; }
.pp3-range output { min-width: 7.5em; font-variant-numeric: tabular-nums; white-space: nowrap; }
.pp3 input[type="range"] {
  flex: 1;
  min-width: 100px;
  height: 36px;
  margin: 0;
  accent-color: var(--pp3-accent);
  background: transparent;
}
.pp3-stage { position: relative; flex: 1; min-height: 280px; overflow: hidden; }
.pp3-stage > canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  display: block;
  cursor: grab;
  touch-action: none;
}
.pp3-stage > canvas:active { cursor: grabbing; }
.pp3-stage > canvas:focus-visible { outline-offset: -3px; }
.pp3-under, .pp3-over { position: absolute; inset: 0; pointer-events: none; }
.pp3-card {
  position: absolute;
  background: var(--pp3-panel);
  border: 1px solid var(--pp3-border);
  border-radius: 8px;
}
.pp3-title {
  position: absolute;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
}
.pp3-name { font-weight: 600; }
.pp3-where { margin-left: auto; color: var(--pp3-muted); font-variant-numeric: tabular-nums; }
.pp3-small .pp3-where { display: none; }
.pp3-chip {
  display: inline-block;
  width: 12px;
  height: 12px;
  border-radius: 3px;
  flex: none;
  box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.25);
}
.pp3-legend, .pp3-status {
  margin: 0;
  padding: 5px 8px;
  font-size: 13px;
  color: var(--pp3-muted);
  background: var(--pp3-panel);
  border-top: 1px solid var(--pp3-border);
}
.pp3-legend { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 12px; }
.pp3-key { display: inline-flex; align-items: center; gap: 5px; color: var(--pp3-text); }
.pp3-status { min-height: 28px; }
.pp3-message {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  text-align: center;
  color: var(--pp3-muted);
}
.pp3-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
@media print {
  .pp3-bar, .pp3-controls, .pp3-status { display: none !important; }
  .pp3 { height: auto; }
  .pp3-stage { min-height: 60vh; break-inside: avoid; }
}
@media (max-width: 480px) {
  .pp3 { font-size: 13px; }
  .pp3-range { flex-basis: 160px; }
  .pp3-range output { min-width: 5.5em; }
  .pp3-controls .pp3-range:last-child { flex-basis: 100%; }
}
`;

const ID = "pp3-style";

export function injectStyle(doc: Document) {
  if (doc.getElementById(ID)) return;
  const el = doc.createElement("style");
  el.id = ID;
  el.textContent = CSS;
  doc.head.append(el);
}
