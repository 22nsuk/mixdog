export const overlayStyles = `
:root { --accent:#58a6ff;color-scheme:dark;font-family:"Mixdog Overlay","Malgun Gothic","Segoe UI",sans-serif; }
* { box-sizing:border-box; }
html,body { width:100%;height:100%;margin:0;overflow:hidden;background:transparent; }
body { display:flex;align-items:flex-start;justify-content:flex-end;padding:10px; }
/* A black island: the Mixdog mark on the left, the words centred, Stop on the
   right. Stop keeps its own slot at the end of the row, so no state change
   ever moves the control or resizes the pill under a press. */
#pill { display:flex;align-items:center;width:100%;max-width:100%;height:38px;padding:0 5px 0 10px;
border-radius:19px;background:#060608;box-shadow:inset 0 0 0 1px #ffffff17,0 4px 12px -2px #0008;color:#f5f5f7;
transition:opacity 180ms ease,transform 180ms ease; }
body.hiding #pill { opacity:0;transform:translateY(-4px); }
/* The one sign of work in progress: the mark's arcs turn in the session's
   accent around a star that holds still. */
#mark { flex-shrink:0;width:20px;height:20px; }
#arcs { stroke:var(--accent);transform-origin:128px 128px;animation:arcs-turn 2.6s linear infinite; }
#star { fill:#fff; }
#status { flex:1;min-width:0;padding:0 6px;text-align:center; }
#title { font-size:14px;line-height:20px;font-weight:500;letter-spacing:-.02em;white-space:nowrap; }
/* The only control, pinned to the right end in every state: quiet at rest,
   solid red only under the pointer that is about to end the task. */
#stop { flex-shrink:0;display:grid;place-items:center;width:28px;height:28px;padding:0;border:0;border-radius:50%;
background:#2c2c30;color:#f5f5f7;cursor:pointer;
transition:background 140ms ease,color 140ms ease,transform 120ms ease; }
#stop:hover { background:#ff453a;color:#fff; }
/* A press answers immediately, before the host does. Without it, a press the
   host later rejects is indistinguishable from one that never reached this
   window at all. */
#stop:active { transform:scale(.9); }
#stop[aria-busy="true"] { opacity:.6; }
#stop:focus-visible { outline:2px solid var(--accent);outline-offset:2px; }
#stop svg { width:16px;height:16px;fill:currentColor; }
/* Paused: the arcs stop where they are, grey out, and the words say why. */
body[data-paused="true"] #arcs { animation-play-state:paused;stroke:#6e6e73; }
body[data-paused="true"] #star { fill:#8e8e93; }
/* The check state asks for a decision: an amber edge and a still, amber mark,
   while the wording stays plain. */
body[data-error="true"] #pill { box-shadow:inset 0 0 0 1px #ff9f0a80,0 4px 12px -2px #0008; }
body[data-error="true"] #arcs { animation:none;stroke:#ff9f0a; }
body[data-error="true"] #star { fill:#fff; }
@keyframes arcs-turn { to { transform:rotate(360deg); } }
@media (prefers-reduced-motion:reduce) {
  #arcs { animation:none; }
}
`;
