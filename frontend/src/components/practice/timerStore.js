import { useEffect, useState } from "react";

const KEY = "practice_timer";
const listeners = new Set();
const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) || null; } catch { return null; } };
const write = (v) => { v ? localStorage.setItem(KEY, JSON.stringify(v)) : localStorage.removeItem(KEY); listeners.forEach(l => l()); };

export const timerSeconds = (t) => t ? t.base + (t.running ? Math.floor((Date.now() - t.startedAt) / 1000) : 0) : 0;
export const fmtClock = (s) => [s / 3600, (s % 3600) / 60, s % 60].map(n => String(Math.floor(n)).padStart(2, "0")).join(":");

export const timer = {
  start: () => write({ base: 0, running: true, startedAt: Date.now(), notes: "" }),
  pause: () => { const t = read(); if (t) write({ ...t, base: timerSeconds(t), running: false }); },
  resume: () => { const t = read(); if (t) write({ ...t, running: true, startedAt: Date.now() }); },
  setNotes: (notes) => { const t = read(); if (t) write({ ...t, notes }); },
  clear: () => write(null),
};

export function usePracticeTimer() {
  const [t, setT] = useState(read);
  const [, tick] = useState(0);
  useEffect(() => {
    const sync = () => setT(read());
    listeners.add(sync);
    window.addEventListener("storage", sync);
    const i = setInterval(() => tick(n => n + 1), 1000);
    return () => { listeners.delete(sync); window.removeEventListener("storage", sync); clearInterval(i); };
  }, []);
  return { active: !!t, running: !!t?.running, seconds: timerSeconds(t), notes: t?.notes || "" };
}
