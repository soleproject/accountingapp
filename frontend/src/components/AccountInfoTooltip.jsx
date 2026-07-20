import { useState, useRef } from "react";
import { createPortal } from "react-dom";
import { Info } from "lucide-react";
import { accountDefinition } from "@/lib/accountDefinitions";

// Portal-based hover tooltip that surfaces the GAAP definition of a Chart-of-
// Accounts category. Rendering in a portal lets the tooltip escape scrollable
// containers / modal overflow clips. Used next to every category dropdown so
// a reviewer can hover the info icon to double-check what a category means
// before approving a transaction.
export function AccountInfoTooltip({ account, size = 12 }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const ref = useRef(null);
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ x: r.left + r.width / 2, y: r.top });
    setOpen(true);
  };
  return (
    <>
      <span
        ref={ref}
        onMouseEnter={show}
        onMouseLeave={() => setOpen(false)}
        onFocus={show}
        onBlur={() => setOpen(false)}
        tabIndex={0}
        className="shrink-0 inline-flex items-center cursor-help"
      >
        <Info size={size} className="text-slate-400 hover:text-slate-600" />
      </span>
      {open && account && createPortal(
        <div
          role="tooltip"
          style={{
            position: "fixed",
            left: pos.x,
            top: pos.y,
            transform: "translate(-50%, calc(-100% - 8px))",
            zIndex: 100,
            pointerEvents: "none",
          }}
          className="w-80 rounded-md bg-slate-900 text-white text-sm leading-relaxed px-3.5 py-3 shadow-xl"
        >
          <span className="block font-semibold text-base mb-1 font-mono-num">
            {account.code} · {account.name}
          </span>
          <span className="block text-slate-200">
            {accountDefinition(account)}
          </span>
        </div>,
        document.body
      )}
    </>
  );
}
