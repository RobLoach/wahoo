/** Tiny typed querySelector shorthand shared by the UI modules. */
export const $ = <T extends HTMLElement = HTMLElement>(sel: string) =>
  document.querySelector(sel) as T;
