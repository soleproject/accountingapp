/*
 * WelcomeComplete — the "you did it" celebration surface. Users arrive
 * here from `/accounting/review-chat?from=onboarding` the moment their
 * review-chat queue empties. It's deliberately quiet: one big check
 * mark, a confident closer, and one primary CTA into the dashboard.
 *
 * We intentionally do NOT auto-redirect after N seconds — this is the
 * one screen in the app where we want the user to sit for a beat and
 * enjoy the win before moving on.
 */

import React, { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import confetti from "canvas-confetti";
import { CheckCircle2, ArrowRight, Sparkles } from "lucide-react";

import { useCompany } from "@/lib/company";

export default function WelcomeComplete() {
  const nav = useNavigate();
  const { current } = useCompany();

  // Fire a soft confetti burst on mount — one pop, not a barrage.
  // Deferred to next frame so the entrance animation and confetti
  // don't fight for the first paint budget.
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        confetti({
          particleCount: 90,
          spread: 80,
          startVelocity: 40,
          origin: { y: 0.35 },
          colors: ["#10b981", "#14b8a6", "#0ea5e9", "#f59e0b"],
          scalar: 0.9,
        });
      } catch { /* confetti is best-effort */ }
    }, 250);
    return () => clearTimeout(t);
  }, []);

  return (
    <div
      className="min-h-screen bg-gradient-to-br from-emerald-50 via-white to-teal-50 flex items-center justify-center p-6"
      data-testid="welcome-complete-page"
    >
      <div className="w-full max-w-xl">
        {/* Trophy / check hero — sits above the copy so the eye lands
            on the reward first before it reads the sentence. */}
        <div className="flex items-center justify-center mb-6">
          <div className="relative">
            <div className="w-24 h-24 rounded-full bg-gradient-to-br from-emerald-400 to-teal-500 flex items-center justify-center shadow-2xl shadow-emerald-500/25">
              <CheckCircle2 size={44} className="text-white" strokeWidth={2.5} />
            </div>
            <div className="absolute -top-1 -right-1 w-9 h-9 rounded-full bg-white flex items-center justify-center shadow-lg">
              <Sparkles size={16} className="text-amber-500" />
            </div>
          </div>
        </div>

        {/* Copy stack — three beats: eyebrow, headline, promise. */}
        <div className="text-center">
          <div className="text-[10px] uppercase tracking-widest text-emerald-700 font-bold mb-2">
            Onboarding · 100%
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold text-slate-900 leading-tight tracking-tight">
            You did it.
          </h1>
          <p className="mt-4 text-slate-700 text-lg leading-relaxed">
            <b>{current?.name || "Your business"}</b>'s books are done — and
            more importantly, they're <b>correct</b>, <b>accurate</b>, and
            something you can be proud of.
          </p>
          <p className="mt-3 text-slate-600 text-[15px] leading-relaxed">
            From here on out I'll keep everything up to date in the background.
            Head into your dashboard whenever you want a fresh look.
          </p>
        </div>

        {/* CTA — one button, big and centered, no dark distractions. */}
        <div className="mt-8 flex items-center justify-center">
          <button
            type="button"
            onClick={() => nav("/dashboard")}
            className="inline-flex items-center gap-2 px-7 py-3 rounded-full bg-emerald-600 hover:bg-emerald-700 text-white font-semibold shadow-lg shadow-emerald-500/25 hover:shadow-emerald-500/40 transition-shadow"
            data-testid="welcome-complete-dashboard"
          >
            Take me to my books <ArrowRight size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
