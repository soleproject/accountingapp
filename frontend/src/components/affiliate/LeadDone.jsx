import { Check, CalendarClock, PhoneCall, Send } from "lucide-react";

function toPath(url) {
  if (!url) return null;
  try { const u = new URL(url); return u.pathname + u.search; } catch { return url; }
}

export function LeadDone({ result, variant, referrer, firm, onSignup }) {
  const { next, booking_url, form } = result;
  const first = (form?.name || "").split(" ")[0] || "there";
  const email = form?.email;
  const refNote = referrer ? `${referrer} has been told you came through their link (not your details — just that it worked).` : null;

  const content = {
    signup: {
      icon: Check, title: `You're in, ${first}.`,
      body: <>We emailed <b>{email}</b> a confirmation. One step left — create your login, then connect a bank (about 60 seconds).</>,
      steps: ["Create your login & connect a bank (60s)", "We import recent transactions and auto-categorize", "You get a text when your first Quick Check-in is ready"],
      cta: { label: "Create my account", onClick: onSignup, testid: "lead-done-signup-btn" },
    },
    book: {
      icon: CalendarClock, title: "Pick a time for your walkthrough.",
      body: <>We emailed <b>{email}</b> the booking link too. 20 minutes, on a sandbox firm with sample clients — no slides.</>,
      steps: ["Pick a slot that suits you", "We pre-load a sandbox firm with 2 sample clients", "Leave with a migration plan from your current software"],
      cta: { label: "Pick a time", href: toPath(booking_url), testid: "lead-done-book-btn" },
    },
    call: {
      icon: PhoneCall, title: `Got it, ${first} — we'll be in touch.`,
      body: <>{variant.key === "enterprise" ? "A specialist will call" : "We'll reach out"} within one business day{form?.phone ? <> on <b>{form.phone}</b></> : null}. Confirmation sent to <b>{email}</b>. Reply to it with a better time if needed.</>,
      steps: variant.key === "enterprise"
        ? ["15-minute discovery call about your entities", "We map your structure to a portfolio", "Pilot on 2 entities, free for 30 days"]
        : ["We call to understand your practice", "Sandbox firm with 2 sample clients", "Migration plan from your current software"],
    },
    firm_contact: {
      icon: Send, title: `Sent to ${firm?.name || "your accountant"}.`,
      body: <>{firm?.name} will email <b>{email}</b> within one business day to set up your books. You can create your login now so they have something to look at.</>,
      steps: [`${firm?.name || "They"} review your request`, "You connect a bank (optional, 60s)", "Your first check-in arrives on your phone"],
      cta: { label: "Create my account now", onClick: onSignup, testid: "lead-done-signup-btn" },
    },
  }[next] || null;
  if (!content) return null;
  const Icon = content.icon;
  const accent = firm?.color || "#0f172a";

  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-[0_12px_40px_rgba(15,23,42,.08)]" data-testid="lead-done">
      <div className="w-14 h-14 rounded-full bg-emerald-50 text-emerald-700 grid place-items-center"><Icon size={26} /></div>
      <h3 className="font-heading font-bold text-2xl text-slate-900 mt-4" data-testid="lead-done-title">{content.title}</h3>
      <p className="text-sm text-slate-600 mt-2 leading-relaxed">{content.body}</p>
      {refNote && <p className="text-xs text-slate-500 mt-2">{refNote}</p>}
      <div className="mt-5 rounded-xl border border-slate-200 p-4">
        <div className="text-[11px] font-bold tracking-[.14em] uppercase text-indigo-600">What happens next</div>
        <ol className="mt-2 space-y-2">
          {content.steps.map((s, i) => (
            <li key={i} className="flex gap-3 text-sm text-slate-700"><span className="w-5 h-5 rounded-full bg-emerald-50 text-emerald-700 text-[11px] font-bold grid place-items-center shrink-0">{i + 1}</span>{s}</li>
          ))}
        </ol>
      </div>
      {content.cta && (content.cta.href
        ? <a href={content.cta.href} data-testid={content.cta.testid} className="mt-5 w-full h-12 rounded-full font-semibold text-white flex items-center justify-center" style={{ background: accent }}>{content.cta.label}</a>
        : <button onClick={content.cta.onClick} data-testid={content.cta.testid} className="mt-5 w-full h-12 rounded-full font-semibold text-white flex items-center justify-center" style={{ background: accent }}>{content.cta.label}</button>)}
      {content.cta && <p className="text-[11px] text-slate-500 text-center mt-2.5">Didn't get the email? Check spam, or reply to any {firm?.name || "SmartBooks"} message.</p>}
    </div>
  );
}
