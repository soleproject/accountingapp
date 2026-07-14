import { createContext, useContext, useState } from "react";

const Ctx = createContext(null);

export function AiFocusProvider({ children }) {
  const [focus, setFocus] = useState(null);
  return <Ctx.Provider value={{ focus, setFocus }}>{children}</Ctx.Provider>;
}

export const useAiFocus = () => useContext(Ctx);
