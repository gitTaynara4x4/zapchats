// js/atendimentos/core/dom.js
export const $  = (sel) => document.querySelector(sel);
export const $$ = (sel) => Array.from(document.querySelectorAll(sel));
