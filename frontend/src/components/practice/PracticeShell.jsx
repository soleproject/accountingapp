import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { Toaster } from "sonner";
import { useAuth } from "@/lib/auth";
import { PracticeTopNav } from "@/components/practice/PracticeTopNav";
import { PracticeRightRail } from "@/components/practice/PracticeRightRail";

const KEY = "practice_sidebar_hidden";

export const PracticeShell = ({ children, withRail = true }) => {
  const { user } = useAuth();
  const [railHidden, setRailHidden] = useState(() => localStorage.getItem(KEY) === "1");
  const setHidden = (v) => { localStorage.setItem(KEY, v ? "1" : "0"); setRailHidden(v); };
  useEffect(() => {
    const h = () => setHidden(false);
    window.addEventListener("practice:show-rail", h);
    return () => window.removeEventListener("practice:show-rail", h);
  }, []);
  if (user?.role !== "superadmin") return <Navigate to="/" replace />;

  const showRail = withRail && !railHidden;

  return (
    <div className="min-h-screen bg-white text-slate-800 flex flex-col" data-testid="practice-shell">
      <Toaster richColors position="top-center" />
      <PracticeTopNav user={user} railHidden={railHidden} onShowRail={() => setHidden(false)} />
      <div className={`flex-1 grid grid-cols-1 gap-6 px-6 py-5 ${showRail ? "xl:grid-cols-[1fr_460px]" : ""}`}>
        <main className="min-w-0">{children}</main>
        {showRail && <PracticeRightRail onHide={() => setHidden(true)} />}
      </div>
      <footer className="px-6 py-3 text-xs text-slate-500 border-t border-slate-100">
        {new Date().getFullYear()} © Practice | <span className="text-[#1E88E5]">Terms of Service</span> | <span className="text-[#1E88E5]">Privacy Policy</span> | <span className="text-[#1E88E5]">What's New?</span>
      </footer>
    </div>
  );
};
