import { Link, useSearchParams } from "react-router-dom";
import { ChevronLeft, CalendarCheck } from "lucide-react";

// Renders a "← Back to July 2026 close" breadcrumb at the top of any page
// the user arrived at via a Month Close deep-link. Silently renders nothing
// when the `from=month-close` param isn't present, so it's safe to drop
// unconditionally at the top of any destination page.
export default function MonthCloseBreadcrumb() {
  const [params] = useSearchParams();
  const from = params.get("from");
  if (from !== "month-close") return null;
  const ym = params.get("ym") || "";
  const label = ymLabel(ym);
  return (
    <nav
      aria-label="Breadcrumb"
      className="mb-3 flex items-center gap-2 text-xs"
      data-testid="month-close-breadcrumb"
    >
      <Link
        to="/accounting/month-close"
        className="inline-flex items-center gap-1 px-2 py-1 rounded-md border bg-white hover:bg-slate-50 text-slate-700"
        data-testid="month-close-breadcrumb-back"
      >
        <ChevronLeft size={12} />
        <CalendarCheck size={12} className="text-slate-500" />
        Back to {label ? `${label} close` : "Month Close"}
      </Link>
    </nav>
  );
}

// "2026-07" → "July 2026". Returns empty string if the param isn't a valid
// YYYY-MM so the breadcrumb falls back to a generic label.
function ymLabel(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym || "");
  if (!m) return "";
  const [, y, mo] = m;
  const yi = Number(y), mi = Number(mo);
  if (mi < 1 || mi > 12) return "";
  return new Date(yi, mi - 1, 1).toLocaleString("en-US", {
    month: "long", year: "numeric",
  });
}
