import { useEffect, useRef, useState } from "react";

/**
 * useColumnBox — measure a content column's `left` + `width` and keep
 * the result in state, updating whenever the column resizes (e.g. when
 * a side panel is toggled) or the viewport changes.
 *
 * Used by pages that want a `position: fixed; bottom: X` footer that
 * stays horizontally aligned with a centered content column above,
 * regardless of sidebar / AI-panel state.
 *
 * Usage:
 *   const { columnRef, colBox } = useColumnBox([current?.id]);
 *   return (
 *     <div ref={columnRef} className="max-w-2xl mx-auto">…</div>
 *     <div style={{ position: "fixed", bottom: 16,
 *                   left: colBox.left, width: colBox.width,
 *                   visibility: colBox.ready ? "visible" : "hidden" }} />
 *   );
 *
 * The `deps` argument lets callers re-attach the observer once async
 * data lands and the column node is finally rendered (e.g. after an
 * early-return guard flips to false). Pass any identifier that changes
 * when the column becomes rendered.
 */
export function useColumnBox(deps = []) {
  const columnRef = useRef(null);
  const [colBox, setColBox] = useState({ left: 0, width: 0, ready: false });

  useEffect(() => {
    const el = columnRef.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect();
      setColBox({ left: r.left, width: r.width, ready: true });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    // Also observe the document root so we catch panel toggles that
    // resize the column indirectly (flex-1 reflows).
    ro.observe(document.documentElement);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { columnRef, colBox };
}

export default useColumnBox;
