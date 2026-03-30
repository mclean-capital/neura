/** Shared app-level state, avoids circular imports between main modules. */
export let isQuitting = false;

export function setQuitting(v: boolean) {
  isQuitting = v;
}
