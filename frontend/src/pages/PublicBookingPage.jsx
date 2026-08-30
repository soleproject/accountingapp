/**
 * PublicBookingPage — Calendly-style /book/:slug page.
 *
 * Unauthenticated. Reads the host's free/busy from the backend and
 * lets a visitor pick a slot + fill their name/email. Confirmation
 * creates a Google Calendar event on the host's calendar with the
 * visitor as an attendee (Meet link auto-attached when the host's
 * default is google_meet).
 */
import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { Calendar, Clock, User, Loader2, Check, ChevronLeft, ChevronRight } from "lucide-react";
import axios from "axios";

const API = (process.env.REACT_APP_BACKEND_URL || "") + "/api";

function ymd(d)      { const p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`; }
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function addMonth(d, delta) { return new Date(d.getFullYear(), d.getMonth()+delta, 1); }
function isSameDate(a, b) { return a && b && a.toDateString() === b.toDateString(); }

export default function PublicBookingPage() {
  const { slug } = useParams();
  const [profile, setProfile] = useState(null);
  const [monthCursor, setMonth] = useState(() => startOfMonth(new Date()));
  const [selectedDate, setSelectedDate] = useState(null);
  const [slots, setSlots] = useState([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [name, setName]   = useState("");
  const [email, setEmail] = useState("");
  const [note, setNote]   = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [confirmed, setConfirmed]   = useState(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    axios.get(`${API}/book/${slug}`).then(r => setProfile(r.data))
      .catch(e => setErr(e?.response?.data?.detail || "Page not found"));
  }, [slug]);

  useEffect(() => {
    if (!selectedDate || !profile) return;
    setLoadingSlots(true); setSelectedSlot(null);
    axios.get(`${API}/book/${slug}/slots`, { params: { date: ymd(selectedDate) } })
      .then(r => setSlots(r.data.slots || []))
      .catch(() => setSlots([]))
      .finally(() => setLoadingSlots(false));
  }, [selectedDate, slug, profile]);

  const days = useMemo(() => {
    const first = startOfMonth(monthCursor);
    const startWeekday = first.getDay();
    const daysInMonth = new Date(first.getFullYear(), first.getMonth()+1, 0).getDate();
    const cells = Array(startWeekday).fill(null);
    for (let i = 1; i <= daysInMonth; i++)
      cells.push(new Date(first.getFullYear(), first.getMonth(), i));
    return cells;
  }, [monthCursor]);

  const workingDays = profile?.working_days || [0, 1, 2, 3, 4];
  const isWorking = (d) => {
    if (!d) return false;
    // JS Date.getDay() is 0=Sun..6=Sat. Backend stores 0=Mon..6=Sun.
    const backendDay = (d.getDay() + 6) % 7;
    return workingDays.includes(backendDay);
  };
  const isPast = (d) => !d || d < new Date(new Date().setHours(0, 0, 0, 0));

  const submit = async () => {
    if (!name.trim() || !email.trim() || !selectedSlot) return;
    setSubmitting(true); setErr("");
    try {
      const r = await axios.post(`${API}/book/${slug}/book`, {
        slot_iso: selectedSlot, name: name.trim(),
        email: email.trim(), note: note.trim(),
      });
      setConfirmed(r.data.booking);
    } catch (e) {
      setErr(e?.response?.data?.detail || "Booking failed");
    } finally { setSubmitting(false); }
  };

  if (err && !profile) {
    return <div className="min-h-screen flex items-center justify-center text-slate-500 text-sm">{err}</div>;
  }
  if (!profile) {
    return <div className="min-h-screen flex items-center justify-center"><Loader2 size={20} className="animate-spin text-slate-400"/></div>;
  }
  if (confirmed) {
    const dt = new Date(confirmed.start_iso);
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md text-center"
              data-testid="booking-confirmed">
          <div className="w-14 h-14 rounded-full bg-emerald-100 text-emerald-600 mx-auto flex items-center justify-center mb-3">
            <Check size={26}/>
          </div>
          <h1 className="text-xl font-bold text-slate-900 mb-1">You're booked</h1>
          <p className="text-sm text-slate-500 mb-4">
            {dt.toLocaleString(undefined, { dateStyle: "full", timeStyle: "short" })}
            {" · "}{confirmed.duration_min} min with {profile.display_name}
          </p>
          {confirmed.meet_link && (
            <a href={confirmed.meet_link} target="_blank" rel="noreferrer"
                data-testid="booking-meet-link"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-violet-600 hover:bg-violet-700 text-white text-sm">
              Join meeting
            </a>
          )}
          <div className="text-[11px] text-slate-400 mt-4">
            A calendar invite has been sent to {confirmed.visitor_email}.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 py-8 px-4" data-testid="booking-page">
      <div className="max-w-3xl mx-auto bg-white rounded-2xl shadow-xl overflow-hidden">
        <div className="px-6 pt-6 pb-3 border-b border-slate-100">
          <div className="text-[10px] uppercase tracking-widest text-violet-600 font-semibold">
            Book a call
          </div>
          <h1 className="text-2xl font-bold text-slate-900">
            with {profile.display_name}
          </h1>
          <div className="text-xs text-slate-500 mt-1 flex items-center gap-3">
            <span className="inline-flex items-center gap-1"><Clock size={11}/> {profile.duration_min} min</span>
            <span className="inline-flex items-center gap-1"><Calendar size={11}/> {profile.timezone}</span>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2">
          {/* Calendar */}
          <div className="p-6 border-b md:border-b-0 md:border-r border-slate-100">
            <div className="flex items-center justify-between mb-3">
              <button onClick={() => setMonth(addMonth(monthCursor, -1))}
                      data-testid="booking-prev-month"
                      className="p-1 rounded hover:bg-slate-100 text-slate-500">
                <ChevronLeft size={16}/>
              </button>
              <div className="text-sm font-semibold text-slate-800">
                {monthCursor.toLocaleString(undefined, { month: "long", year: "numeric" })}
              </div>
              <button onClick={() => setMonth(addMonth(monthCursor, 1))}
                      data-testid="booking-next-month"
                      className="p-1 rounded hover:bg-slate-100 text-slate-500">
                <ChevronRight size={16}/>
              </button>
            </div>
            <div className="grid grid-cols-7 gap-1 text-[10px] uppercase tracking-widest text-slate-400 font-semibold mb-1">
              {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map(w => <div key={w} className="text-center">{w}</div>)}
            </div>
            <div className="grid grid-cols-7 gap-1">
              {days.map((d, i) => {
                if (!d) return <div key={i}/>;
                const disabled = isPast(d) || !isWorking(d);
                const selected = isSameDate(d, selectedDate);
                return (
                  <button key={i}
                          disabled={disabled}
                          onClick={() => setSelectedDate(d)}
                          data-testid={`booking-day-${ymd(d)}`}
                          className={`aspect-square rounded text-sm transition ${
                            selected ? "bg-violet-600 text-white font-semibold"
                            : disabled ? "text-slate-300 cursor-not-allowed"
                            : "hover:bg-violet-50 text-slate-700"
                          }`}>
                    {d.getDate()}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Slots / form */}
          <div className="p-6">
            {!selectedDate ? (
              <div className="text-sm text-slate-400 italic h-full flex items-center justify-center">
                Pick a date to see times
              </div>
            ) : selectedSlot ? (
              <div data-testid="booking-form">
                <div className="text-sm font-semibold text-slate-800 mb-2">
                  Your details
                </div>
                <div className="text-xs text-slate-500 mb-4">
                  {new Date(selectedSlot).toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" })}
                  {" · "}{profile.duration_min} min
                </div>
                <input value={name} onChange={e => setName(e.target.value)}
                        placeholder="Your name"
                        data-testid="booking-name"
                        className="w-full text-sm px-3 py-2 border border-slate-300 rounded mb-2"/>
                <input value={email} onChange={e => setEmail(e.target.value)}
                        placeholder="Email"
                        type="email"
                        data-testid="booking-email"
                        className="w-full text-sm px-3 py-2 border border-slate-300 rounded mb-2"/>
                <textarea value={note} onChange={e => setNote(e.target.value)}
                            placeholder="What would you like to talk about? (optional)"
                            rows={3}
                            data-testid="booking-note"
                            className="w-full text-sm px-3 py-2 border border-slate-300 rounded mb-3"/>
                {err && <div className="text-xs text-rose-600 mb-2">{err}</div>}
                <div className="flex items-center gap-2">
                  <button onClick={() => setSelectedSlot(null)}
                          className="text-sm text-slate-500 hover:text-slate-800">Back</button>
                  <div className="flex-1"/>
                  <button onClick={submit}
                          disabled={submitting || !name || !email}
                          data-testid="booking-confirm"
                          className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-violet-600 hover:bg-violet-700 text-white text-sm disabled:opacity-50">
                    {submitting ? <Loader2 size={13} className="animate-spin"/> : <Check size={13}/>}
                    Confirm booking
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="text-sm font-semibold text-slate-800 mb-3">
                  {selectedDate.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
                </div>
                {loadingSlots ? (
                  <div className="text-center py-6 text-slate-400">
                    <Loader2 size={16} className="animate-spin mx-auto"/>
                  </div>
                ) : slots.length === 0 ? (
                  <div className="text-sm text-slate-400 italic py-6 text-center">
                    Nothing available. Try another day.
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2 max-h-96 overflow-y-auto">
                    {slots.map(s => (
                      <button key={s}
                              onClick={() => setSelectedSlot(s)}
                              data-testid={`booking-slot-${s}`}
                              className="text-sm px-3 py-2 rounded border border-slate-200 hover:border-violet-500 hover:bg-violet-50 text-slate-700 transition">
                        {new Date(s).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      <div className="text-center text-[10px] text-slate-400 mt-4">
        Powered by SmartBooks · <a href="/" className="hover:text-slate-600">Get your own booking page</a>
      </div>
    </div>
  );
}
