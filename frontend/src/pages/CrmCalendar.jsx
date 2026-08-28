import { useEffect, useMemo, useState } from "react";
import { useLocation, Link } from "react-router-dom";
import { toast } from "sonner";
import {
  CalendarDays, ChevronLeft, ChevronRight, Loader2, Plus, Mail,
  Video, MapPin, ExternalLink, Users, Trash2, RefreshCw, X,
} from "lucide-react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";

/* ------------------------------------------------------------------ */
/*  Date helpers                                                       */
/* ------------------------------------------------------------------ */
const pad = (n) => String(n).padStart(2, "0");
const isoDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayISO = () => isoDay(new Date());

const monthWindow = (anchor) => {
  const [y, m] = anchor.split("-").map(Number);
  const first = new Date(y, m - 1, 1);
  const last  = new Date(y, m, 0);
  // Grid starts on Monday
  const gridStart = new Date(first);
  const offset = (first.getDay() + 6) % 7; // Mon=0
  gridStart.setDate(first.getDate() - offset);
  const gridEnd = new Date(last);
  const tail = (7 - ((last.getDay() + 6) % 7) - 1) % 7;
  gridEnd.setDate(last.getDate() + tail);
  const days = [];
  for (let d = new Date(gridStart); d <= gridEnd; d.setDate(d.getDate() + 1)) {
    days.push({
      date: isoDay(d),
      inPeriod: d.getMonth() === first.getMonth(),
    });
  }
  return {
    from: gridStart.toISOString(),
    to:   new Date(gridEnd.getTime() + 24 * 3600 * 1000).toISOString(),
    label: first.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
    days,
  };
};

const shiftMonth = (anchor, delta) => {
  const [y, m] = anchor.split("-").map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return isoDay(d).slice(0, 7) + "-01";
};

const fmtTime = (iso) => {
  if (!iso) return "";
  if (iso.length === 10) return "All day";
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
};

const dayOf = (iso) => (iso || "").slice(0, 10);


/* ------------------------------------------------------------------ */
/*  Main page                                                          */
/* ------------------------------------------------------------------ */
export default function CrmCalendar() {
  const { currentId } = useCompany();
  const location = useLocation();

  const [status, setStatus] = useState({ loading: true, connected: false, email: "" });
  const [anchor, setAnchor] = useState(() => todayISO().slice(0, 7) + "-01");
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [calendars, setCalendars] = useState([]);
  const [calendarId, setCalendarId] = useState("primary");
  const [creating, setCreating] = useState(false);
  const [selectedDate, setSelectedDate] = useState(null);
  const [detailEvent, setDetailEvent] = useState(null);

  const { from, to, days, label } = useMemo(() => monthWindow(anchor), [anchor]);

  /* ── OAuth callback toast (shared with /crm/email) ── */
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    if (p.get("gmail_connected") === "1") {
      toast.success("Google connected");
      window.history.replaceState({}, "", "/crm/calendar");
    }
    if (p.get("gmail_error")) {
      toast.error("Google connection failed: " + p.get("gmail_error"));
      window.history.replaceState({}, "", "/crm/calendar");
    }
  }, [location.search]);

  /* ── connection status ── */
  const loadStatus = async () => {
    try {
      const r = await api.get("/gmail/status");
      setStatus({ loading: false, connected: !!r.data?.connected, email: r.data?.email || "" });
    } catch { setStatus({ loading: false, connected: false, email: "" }); }
  };
  useEffect(() => { loadStatus(); }, []);

  /* ── calendars ── */
  useEffect(() => {
    if (!status.connected) return;
    api.get("/google/calendar/list").then(r => setCalendars(r.data?.calendars || []))
       .catch(() => {});
  }, [status.connected]);

  /* ── events ── */
  const loadEvents = async () => {
    if (!status.connected) return;
    setLoading(true);
    try {
      const params = new URLSearchParams({ time_min: from, time_max: to, calendar_id: calendarId });
      const r = await api.get(`/google/calendar/events?${params.toString()}`);
      setEvents(r.data?.events || []);
    } catch (e) {
      if (e?.response?.status === 401) {
        setStatus({ loading: false, connected: false, email: "" });
      } else {
        toast.error(e?.response?.data?.detail || "Failed to load events");
      }
    } finally { setLoading(false); }
  };
  useEffect(() => { loadEvents(); /* eslint-disable-next-line */ }, [status.connected, anchor, calendarId]);

  const byDay = useMemo(() => {
    const map = {};
    for (const e of events) {
      const d = dayOf(e.start);
      if (!d) continue;
      (map[d] = map[d] || []).push(e);
    }
    for (const d of Object.values(map)) {
      d.sort((a, b) => (a.start || "").localeCompare(b.start || ""));
    }
    return map;
  }, [events]);

  const connect = async () => {
    try {
      const r = await api.get("/oauth/gmail/start?return_to=/crm/calendar");
      window.location.href = r.data.auth_url;
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to start Google connect");
    }
  };

  const deleteEvent = async (ev) => {
    if (!window.confirm("Delete this event?")) return;
    try {
      await api.delete(`/google/calendar/events/${ev.id}?calendar_id=${calendarId}&send_updates=all`);
      setEvents(es => es.filter(x => x.id !== ev.id));
      setDetailEvent(null);
      toast.success("Event deleted");
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Delete failed");
    }
  };

  if (status.loading) {
    return <div className="p-8 flex items-center gap-2 text-slate-500">
      <Loader2 className="animate-spin" size={16}/> Loading calendar…
    </div>;
  }

  if (!status.connected) {
    return (
      <div className="p-8 max-w-2xl mx-auto" data-testid="calendar-connect-panel">
        <div className="rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-lg bg-emerald-50">
              <CalendarDays size={24} className="text-emerald-600"/>
            </div>
            <div>
              <div className="text-lg font-semibold text-slate-900">Connect Google Workspace</div>
              <div className="text-sm text-slate-500">
                Bring your Google Calendar into the CRM. Also connects Gmail.
              </div>
            </div>
          </div>
          <div className="mt-6">
            <button onClick={connect}
                    data-testid="calendar-connect-btn"
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm">
              <CalendarDays size={14}/> Connect Google
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl space-y-5 p-2" data-testid="crm-calendar-page">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-heading text-3xl font-bold tracking-tight flex items-center gap-2">
            <CalendarDays size={22} className="text-emerald-600"/>
            CRM Calendar
          </h1>
          <div className="text-slate-500 text-sm mt-1">
            Your Google Calendar synced live. Click any day to schedule.
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <select value={calendarId} onChange={e => setCalendarId(e.target.value)}
                  data-testid="calendar-select"
                  className="border border-slate-200 rounded px-2 py-1 bg-white text-xs">
            {calendars.map(c => (
              <option key={c.id} value={c.id}>{c.summary}{c.primary ? " (primary)" : ""}</option>
            ))}
          </select>
          <button onClick={() => { setSelectedDate(todayISO()); setCreating(true); }}
                  data-testid="calendar-new-event-btn"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm">
            <Plus size={14}/> New event
          </button>
          <button onClick={loadEvents} title="Refresh"
                  className="p-1.5 rounded hover:bg-slate-100 text-slate-500">
            <RefreshCw size={14}/>
          </button>
        </div>
      </div>

      {/* Nav */}
      <div className="flex items-center justify-between">
        <div className="text-sm font-semibold text-slate-900 flex items-center gap-2">
          {label}
          {loading && <Loader2 size={12} className="animate-spin text-slate-400"/>}
          <span className="text-xs text-slate-400 font-normal">· {status.email}</span>
        </div>
        <div className="flex items-center gap-1">
          <button onClick={() => setAnchor(shiftMonth(anchor, -1))}
                  className="p-1.5 rounded hover:bg-slate-100 text-slate-500"
                  data-testid="calendar-prev">
            <ChevronLeft size={14}/>
          </button>
          <button onClick={() => setAnchor(todayISO().slice(0, 7) + "-01")}
                  data-testid="calendar-today"
                  className="text-xs px-2.5 py-1 rounded border border-slate-200 bg-white hover:bg-slate-50">
            Today
          </button>
          <button onClick={() => setAnchor(shiftMonth(anchor, 1))}
                  className="p-1.5 rounded hover:bg-slate-100 text-slate-500"
                  data-testid="calendar-next">
            <ChevronRight size={14}/>
          </button>
        </div>
      </div>

      {/* Grid */}
      <div className="rounded-xl border bg-white overflow-hidden">
        <div className="grid grid-cols-7 bg-slate-50 border-b text-[10px] uppercase tracking-wider text-slate-500 font-semibold">
          {["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(w => (
            <div key={w} className="px-2 py-2 text-center">{w}</div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {days.map((d) => {
            const list = byDay[d.date] || [];
            const isToday = d.date === todayISO();
            return (
              <div key={d.date}
                    data-testid={`calendar-cell-${d.date}`}
                    onClick={() => d.inPeriod && (setSelectedDate(d.date), setCreating(true))}
                    className={`border-b border-r p-1.5 space-y-1 min-h-[110px] cursor-pointer ${
                      d.inPeriod ? "bg-white hover:bg-slate-50/60" : "bg-slate-50/60 text-slate-400"
                    }`}>
                <div className={`text-[11px] ${isToday ? "text-emerald-700 font-bold" : "text-slate-600"}`}>
                  {d.date.slice(-2).replace(/^0/, "")}
                </div>
                {list.slice(0, 4).map(e => (
                  <div key={e.id}
                        data-testid={`calendar-event-${e.id}`}
                        onClick={(ev) => { ev.stopPropagation(); setDetailEvent(e); }}
                        className="text-[10px] rounded px-1 py-0.5 bg-emerald-50 border border-emerald-200 text-emerald-800 flex items-center gap-1 truncate hover:bg-emerald-100">
                    {e.hangout_link && <Video size={9} className="shrink-0"/>}
                    {!e.all_day && (
                      <span className="font-mono-num text-[9px] font-semibold shrink-0">
                        {fmtTime(e.start)}
                      </span>
                    )}
                    <span className="truncate">{e.summary || "(no title)"}</span>
                  </div>
                ))}
                {list.length > 4 && (
                  <div className="text-[9px] text-slate-500 italic">+ {list.length - 4} more…</div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Create event modal */}
      {creating && (
        <EventComposeModal
          date={selectedDate}
          calendarId={calendarId}
          onClose={() => setCreating(false)}
          onSaved={() => { setCreating(false); loadEvents(); toast.success("Event created"); }}
        />
      )}

      {/* Detail drawer */}
      {detailEvent && (
        <EventDetailModal
          event={detailEvent}
          onClose={() => setDetailEvent(null)}
          onDelete={() => deleteEvent(detailEvent)}
        />
      )}
    </div>
  );
}


/* ------------------------------------------------------------------ */
/*  Compose modal                                                      */
/* ------------------------------------------------------------------ */
export function EventComposeModal({ date, calendarId = "primary", defaultAttendees = [], defaultSummary = "", defaultDescription = "", onClose, onSaved }) {
  const [summary, setSummary]         = useState(defaultSummary);
  const [description, setDescription] = useState(defaultDescription);
  const [location, setLocation]       = useState("");
  const [startDate, setStartDate]     = useState(date || todayISO());
  const [startTime, setStartTime]     = useState("09:00");
  const [endTime, setEndTime]         = useState("09:30");
  const [allDay, setAllDay]           = useState(false);
  const [attendeesText, setAttendeesText] = useState(
    (defaultAttendees || []).map(a => a.email).filter(Boolean).join(", ")
  );
  const [sendInvites, setSendInvites] = useState(true);
  const [addMeet, setAddMeet]         = useState(false);
  const [busy, setBusy]               = useState(false);

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  const submit = async () => {
    if (!summary.trim()) { toast.error("Give this event a title"); return; }
    setBusy(true);
    try {
      const attendees = attendeesText.split(/[,;]/).map(s => s.trim()).filter(Boolean)
        .map(email => ({ email }));
      const payload = {
        summary,
        description,
        location,
        calendar_id: calendarId,
        all_day: allDay,
        time_zone: tz,
        start: allDay ? startDate : `${startDate}T${startTime}:00`,
        end:   allDay ? startDate : `${startDate}T${endTime}:00`,
        attendees,
        send_updates: sendInvites ? "all" : "none",
        add_meet_link: addMeet,
      };
      await api.post("/google/calendar/events", payload);
      onSaved && onSaved();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to create event");
    } finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
           data-testid="calendar-compose-modal"
           className="bg-white rounded-xl w-full max-w-lg mx-3 shadow-2xl">
        <div className="flex items-center px-4 py-3 border-b border-slate-200">
          <div className="text-sm font-semibold">New event</div>
          <div className="flex-1"/>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100">
            <X size={16}/>
          </button>
        </div>
        <div className="p-4 space-y-3 text-sm">
          <input value={summary} onChange={e => setSummary(e.target.value)}
                 placeholder="Add title"
                 data-testid="event-title"
                 className="w-full px-2 py-2 text-base font-medium border-b border-slate-200 focus:outline-none focus:border-emerald-500"/>
          <div className="flex items-center gap-2">
            <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)}
                   data-testid="event-date"
                   className="px-2 py-1 border border-slate-200 rounded text-sm"/>
            {!allDay && (
              <>
                <input type="time" value={startTime} onChange={e => setStartTime(e.target.value)}
                       data-testid="event-start-time"
                       className="px-2 py-1 border border-slate-200 rounded text-sm"/>
                <span className="text-slate-400">→</span>
                <input type="time" value={endTime} onChange={e => setEndTime(e.target.value)}
                       data-testid="event-end-time"
                       className="px-2 py-1 border border-slate-200 rounded text-sm"/>
              </>
            )}
            <label className="ml-1 text-xs text-slate-600 inline-flex items-center gap-1">
              <input type="checkbox" checked={allDay} onChange={e => setAllDay(e.target.checked)}
                     data-testid="event-all-day"/> All day
            </label>
          </div>
          <div className="flex items-center gap-2">
            <Users size={14} className="text-slate-400 shrink-0"/>
            <input value={attendeesText} onChange={e => setAttendeesText(e.target.value)}
                   placeholder="Attendees, comma-separated (email@…)"
                   data-testid="event-attendees"
                   className="flex-1 px-2 py-1 border border-slate-200 rounded text-sm"/>
          </div>
          <div className="flex items-center gap-2">
            <MapPin size={14} className="text-slate-400 shrink-0"/>
            <input value={location} onChange={e => setLocation(e.target.value)}
                   placeholder="Location"
                   data-testid="event-location"
                   className="flex-1 px-2 py-1 border border-slate-200 rounded text-sm"/>
          </div>
          <textarea value={description} onChange={e => setDescription(e.target.value)}
                    placeholder="Description"
                    data-testid="event-description"
                    className="w-full px-2 py-1 border border-slate-200 rounded text-sm min-h-[70px]"/>
          <div className="flex items-center gap-4 text-xs">
            <label className="inline-flex items-center gap-1 text-slate-600">
              <input type="checkbox" checked={sendInvites} onChange={e => setSendInvites(e.target.checked)}
                     data-testid="event-send-invites"/>
              Email invites to attendees
            </label>
            <label className="inline-flex items-center gap-1 text-slate-600">
              <input type="checkbox" checked={addMeet} onChange={e => setAddMeet(e.target.checked)}
                     data-testid="event-add-meet"/>
              Add Google Meet link
            </label>
          </div>
        </div>
        <div className="flex items-center gap-2 px-4 py-3 border-t border-slate-200">
          <button onClick={submit} disabled={busy}
                  data-testid="event-save-btn"
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-700 text-white text-sm disabled:opacity-50">
            {busy ? <Loader2 size={14} className="animate-spin"/> : <Plus size={14}/>}
            Create
          </button>
          <div className="flex-1"/>
          <button onClick={onClose} className="text-sm text-slate-600 hover:text-slate-800">Cancel</button>
        </div>
      </div>
    </div>
  );
}


/* ------------------------------------------------------------------ */
/*  Detail modal                                                       */
/* ------------------------------------------------------------------ */
function EventDetailModal({ event, onClose, onDelete }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
           data-testid="calendar-event-detail"
           className="bg-white rounded-xl w-full max-w-lg mx-3 shadow-2xl">
        <div className="flex items-center px-4 py-3 border-b border-slate-200">
          <div className="text-sm font-semibold truncate">{event.summary || "(no title)"}</div>
          <div className="flex-1"/>
          {event.html_link && (
            <a href={event.html_link} target="_blank" rel="noreferrer"
               className="text-xs text-emerald-700 hover:underline inline-flex items-center gap-1 mr-3">
              Open in Google <ExternalLink size={11}/>
            </a>
          )}
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100">
            <X size={16}/>
          </button>
        </div>
        <div className="p-4 space-y-2 text-sm">
          <div className="text-slate-700">
            {event.all_day ? "All day" : `${fmtTime(event.start)} – ${fmtTime(event.end)}`}
            <span className="text-slate-400 ml-2">· {dayOf(event.start)}</span>
          </div>
          {event.location && (
            <div className="text-slate-600 flex items-center gap-1"><MapPin size={12}/> {event.location}</div>
          )}
          {event.hangout_link && (
            <div>
              <a href={event.hangout_link} target="_blank" rel="noreferrer"
                 className="inline-flex items-center gap-1 text-emerald-700 hover:underline">
                <Video size={13}/> Join Google Meet
              </a>
            </div>
          )}
          {event.description && (
            <div className="text-slate-700 whitespace-pre-wrap text-xs bg-slate-50 border border-slate-200 rounded p-2 max-h-40 overflow-y-auto">
              {event.description}
            </div>
          )}
          {event.attendees?.length > 0 && (
            <div className="text-xs">
              <div className="text-slate-500 mb-1">Attendees</div>
              <div className="space-y-0.5">
                {event.attendees.map((a, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500"/>
                    <span className="text-slate-800">{a.display_name || a.email}</span>
                    <span className="text-slate-400 text-[10px]">{a.response_status}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2 px-4 py-3 border-t border-slate-200">
          <button onClick={onDelete}
                  data-testid="calendar-event-delete"
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm text-rose-700 hover:bg-rose-50">
            <Trash2 size={14}/> Delete
          </button>
          <div className="flex-1"/>
          <button onClick={onClose} className="text-sm text-slate-600 hover:text-slate-800">Close</button>
        </div>
      </div>
    </div>
  );
}
