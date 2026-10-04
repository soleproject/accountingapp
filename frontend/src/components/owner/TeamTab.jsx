import React from "react";
import { useNavigate } from "react-router-dom";
import { Bot, CalendarCheck } from "lucide-react";
import { Card, Pill, Button, fmtDay } from "./ui";

export default function TeamTab({ data }) {
  const navigate = useNavigate();
  const { team, books } = data;
  const nc = team.next_checkin;
  const w = team.weekly;
  return (
    <div data-testid="owner-team-tab">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="The people & AI handling your books" data-testid="owner-team-members">
          <div className="divide-y divide-dashed divide-slate-200">
            {team.members.map(m => (
              <div key={m.name} className="flex gap-3 py-3" data-testid={`owner-team-member-${m.is_ai ? "ai" : m.user_id}`}>
                <span className={`flex-none w-9 h-9 rounded-full grid place-items-center text-white text-xs font-semibold ${m.is_ai ? "bg-emerald-600" : "bg-primary"}`}>{m.is_ai ? <Bot size={16} /> : m.initials}</span>
                <div><div className="text-sm font-semibold">{m.name}</div><div className="text-xs text-slate-500">{m.title}</div></div>
              </div>
            ))}
          </div>
        </Card>

        <Card title="Your next check-in" data-testid="owner-team-checkin">
          {nc ? (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
              <div className="text-[10px] tracking-[0.12em] uppercase text-emerald-700 font-semibold">Quick check-in · {nc.status === "scheduled" ? "scheduled" : "in progress"}</div>
              <div className="font-heading text-xl mt-1">{nc.total - nc.answered > 0 ? `${nc.total - nc.answered} quick question${nc.total - nc.answered === 1 ? "" : "s"} waiting` : "All answered — thank you"}</div>
              <div className="text-xs text-slate-600 mt-0.5">{nc.sent_at && `Sent ${fmtDay(nc.sent_at)} · `}{nc.answered} of {nc.total} answered · about {Math.max(1, Math.ceil((nc.total - nc.answered) / 2))} min to finish</div>
              {nc.total - nc.answered > 0 && <Button primary className="mt-3" onClick={() => navigate(nc.href)} data-testid="owner-team-checkin-continue">Continue →</Button>}
            </div>
          ) : <div className="text-sm text-slate-500 py-4">No open check-in. Your team will reach out when they need a quick answer.</div>}
          <div className="text-xs text-slate-500 mt-3 flex items-center gap-1.5">
            <CalendarCheck size={13} />
            {team.booking_url ? <>Want to talk it through? <a href={team.booking_url} target="_blank" rel="noreferrer" className="text-primary font-semibold" data-testid="owner-team-booking-link">Pick a time with {team.members.find(m => !m.is_ai)?.name?.split(",")[0] || "your bookkeeper"}</a></> : "Your bookkeeper hasn't set up online booking yet."}
          </div>
        </Card>

        <Card title="Recent conversations" data-testid="owner-team-conversations">
          {team.conversations.length === 0 && <div className="text-sm text-slate-500 py-4">No messages yet.</div>}
          <div className="divide-y divide-dashed divide-slate-200">
            {team.conversations.map((c, i) => (
              <div key={i} className="py-3">
                <div className="text-xs text-slate-500"><b className="text-slate-900">{c.actor}</b> · {c.at ? new Date(c.at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : ""}</div>
                <p className="text-sm my-1">{c.subject}</p>
                {c.href && <Button onClick={() => navigate(c.href)}>Open</Button>}
              </div>
            ))}
          </div>
        </Card>

        <Card title="What we're working on" data-testid="owner-team-working">
          <div className="divide-y divide-slate-200">
            {team.working_on.map((wo, i) => (
              <div key={i} className="flex items-center justify-between py-3">
                <div><div className="text-sm font-semibold">{wo.title}</div><div className="text-xs text-slate-500">{wo.subtitle}</div></div>
                <Pill tone={wo.tone}>{wo.status}</Pill>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card className="mt-4" data-testid="owner-team-weekly">
        <h2 className="font-heading text-xl mb-3">Completed this week <span className="text-sm text-slate-500 font-sans">· {w.label}</span></h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {[["Transactions categorized", w.categorized], ["Receipts matched", w.receipts_matched], ["Bank transactions reconciled", w.reconciled]].map(([l, v]) => (
            <div key={l} className="rounded-xl border border-slate-200 bg-slate-50/60 p-4"><div className="font-mono-num text-2xl font-medium">{v}</div><div className="text-xs text-slate-500">{l}</div></div>
          ))}
        </div>
        <div className="text-xs text-slate-500 mt-3">{books.period_label} close: {books.checkpoints_green} of {books.checkpoints_total} checkpoints complete.</div>
      </Card>
    </div>
  );
}
