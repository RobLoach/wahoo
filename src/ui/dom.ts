/** Tiny typed querySelector shorthand shared by the UI modules. */
export const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;

/** Escape a string for interpolation into innerHTML. */
export const esc = (s: string) =>
  s.replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);
