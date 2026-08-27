import { User, Calendar, GripVertical, Sparkles } from "lucide-react";
import { useMoneyFmt } from "@/lib/company";

/**
 * DealCard — compact Kanban card (Phase C, Feb 2026).
 */
export default function DealCard({ deal, onClick, dragging = false,
                                    insertMarker = false }) {
  const fmt = useMoneyFmt();
  const weighted = Number(deal.value || 0) * Number(deal.probability || 0) / 100;
  return (
    <>
      {insertMarker && (
        <div className="h-0.5 bg-violet-500 rounded-full my-1"
              data-testid={`deal-insert-marker-${deal.id}`} />
      )}
      <div onClick={onClick}
            data-testid={`deal-card-${deal.id}`}
            className={`rounded-lg border p-2.5 bg-white cursor-pointer hover:shadow-md hover:border-violet-300 transition ${
              dragging ? "opacity-40 shadow-inner" : ""
            }`}>
        <div className="flex items-start gap-1">
          <GripVertical size={11} className="text-slate-300 mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-slate-900 truncate"
                  data-testid={`deal-card-title-${deal.id}`}>
              {deal.title}
              {deal.project_id && (
                <Sparkles size={10} className="inline text-emerald-500 ml-1"
                          title="Converted to project" />
              )}
            </div>
            {deal.contact_name && (
              <div className="text-[11px] text-slate-500 truncate flex items-center gap-1 mt-0.5">
                <User size={9} />{deal.contact_name}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center justify-between mt-2 text-[11px]">
          <span className="font-mono-num font-semibold text-slate-900">
            {fmt(deal.value || 0)}
          </span>
          <span className="inline-flex items-center gap-0.5 text-slate-500 font-mono-num"
                 title={`${deal.probability}% · weighted ${fmt(weighted)}`}>
            {deal.probability}%
          </span>
        </div>
        {deal.expected_close_date && (
          <div className="text-[10px] text-slate-400 mt-0.5 flex items-center gap-1 font-mono-num">
            <Calendar size={9} />
            {deal.expected_close_date}
          </div>
        )}
      </div>
    </>
  );
}
