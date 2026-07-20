import { createContext, useContext, useRef, useState } from "react";

const Ctx = createContext(null);

export function AiFocusProvider({ children }) {
  const [focus, setFocusState] = useState(null);
  // Track whether the current focus was pinned by an explicit click (e.g. the
  // per-row Sparkle button) vs. an ephemeral hover. Pinned focus survives
  // onMouseLeave so voice commands like "approve this" still resolve when the
  // user has moved their pointer away from the row into the AI input.
  const pinnedRef = useRef(false);
  // Mirror pinned into React state so the AI panel can show/hide the
  // "Cancel focus" button — it should ONLY appear when the user explicitly
  // pinned via the sparkle, not while hover-focus is bleeding through.
  const [pinned, setPinned] = useState(false);

  const setFocus = (val, opts = {}) => {
    if (val === null) {
      // Clearing: honor 'force' to override pin, otherwise skip if pinned.
      if (pinnedRef.current && !opts.force) return;
      pinnedRef.current = false;
      setPinned(false);
      setFocusState(null);
      return;
    }
    // Hover (unpinned) events must not clobber a pinned focus from an
    // explicit Sparkle click. Only an explicit pin call replaces a pin.
    if (pinnedRef.current && !opts.pin) return;
    pinnedRef.current = !!opts.pin;
    setPinned(!!opts.pin);
    setFocusState(val);
  };

  return <Ctx.Provider value={{ focus, setFocus, pinned }}>{children}</Ctx.Provider>;
}

export const useAiFocus = () => useContext(Ctx);
