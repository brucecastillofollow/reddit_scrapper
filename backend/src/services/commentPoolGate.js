/** When true, DB comment workers/coordinator idle to avoid overlapping Reddit load. */
let webshareBatchActive = false;

export function isWebshareBatchActive() {
  return webshareBatchActive;
}

export function setWebshareBatchActive(active) {
  webshareBatchActive = Boolean(active);
}
