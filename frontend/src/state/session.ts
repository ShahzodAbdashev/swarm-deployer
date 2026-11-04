/** A server error mapped to a wizard step + field (from a 400 on POST /api/deploys). */
export interface PendingErr { step: string; field: string; msg: string }

/** In-memory, per-tab flags that outlive one page. Never persisted. */
export const session = {
  /** One-shot info shown on the next wizard step (reload / try-again note). */
  note: null as string | null,
  fromReview: false,
  /** Wizard steps where Next was pressed (errors show live from then on). */
  tried: {} as Record<string, boolean>,
  pendingErr: null as PendingErr | null,
  /** "Also save the current image as a .tar": null = use the option's default. */
  saveTar: null as boolean | null,
  /** Package step: only show this service's group. */
  filter: null as string | null,
  /** Service detail: section id to scroll to once loaded. */
  scrollTo: null as string | null,
};
