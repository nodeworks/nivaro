/** sessionStorage key the queue page uses to hand a question to the Ask page
 *  (the Ask page submits it once and clears it). A `?q=` in the URL only fills
 *  the box — a link from outside must never fire a question for the reader. */
export const ASK_HANDOFF_KEY = 'nvr:ask-handoff'
