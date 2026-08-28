import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { toast } from "sonner";
import {
  Inbox, Send, FileText as DraftIcon, Star, Archive, Trash2,
  Search, Plus, RefreshCw, Reply, X, Paperclip, ChevronDown, ChevronUp,
  ChevronLeft, Minus, Maximize2, Minimize2,
  Loader2, User as UserIcon, Bold, Italic, Underline as UIcon, Link as LinkIcon,
  List as ListIcon, ListOrdered, Filter, Mail as MailIcon, ExternalLink,
} from "lucide-react";
import { api, BACKEND_URL } from "@/lib/api";
import { useCompany } from "@/lib/company";

/* ------------------------------------------------------------------ */
/*  Folder taxonomy for the left sidebar                              */
/* ------------------------------------------------------------------ */
const FOLDERS = [
  { id: "INBOX",   label: "Inbox",    icon: Inbox },
  { id: "STARRED", label: "Starred",  icon: Star },
  { id: "SENT",    label: "Sent",     icon: Send },
  { id: "DRAFT",   label: "Drafts",   icon: DraftIcon },
  { id: "ALL",     label: "All Mail", icon: Archive },
];

/* ------------------------------------------------------------------ */
/*  Utils                                                             */
/* ------------------------------------------------------------------ */
const extractEmail = (raw) => {
  if (!raw) return "";
  const m = String(raw).match(/<([^>]+)>/);
  return (m ? m[1] : String(raw)).trim().toLowerCase();
};

const displayName = (raw) => {
  if (!raw) return "";
  const s = String(raw);
  if (s.includes("<")) {
    return s.split("<")[0].trim().replace(/^["']|["']$/g, "") || extractEmail(s);
  }
  return s.trim();
};

const initials = (raw) => {
  const n = displayName(raw) || extractEmail(raw);
  return n.split(/\s+/).slice(0, 2).map(p => p[0]?.toUpperCase() || "").join("") || "?";
};

const fmtWhen = (dateStr, internalDate) => {
  const ms = internalDate ? Number(internalDate) : (dateStr ? Date.parse(dateStr) : NaN);
  if (!ms || isNaN(ms)) return dateStr || "";
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const sameYear = d.getFullYear() === now.getFullYear();
  return sameYear
    ? d.toLocaleDateString([], { month: "short", day: "numeric" })
    : d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
};

const domainOf = (str) => {
  if (!str) return "";
  const at = str.indexOf("@");
  if (at === -1) {
    // maybe website
    try { return new URL(str.startsWith("http") ? str : "http://" + str).hostname.replace(/^www\./, ""); }
    catch { return ""; }
  }
  return str.slice(at + 1).trim().toLowerCase();
};

/* ------------------------------------------------------------------ */
/*  Main page                                                         */
/* ------------------------------------------------------------------ */
export default function CrmEmail() {
  const { currentId } = useCompany();
  const location = useLocation();

  /* connection */
  const [status, setStatus] = useState({ loading: true, connected: false, email: "" });

  /* folder + search state */
  const [folder, setFolder]         = useState("INBOX");
  const [search, setSearch]         = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  /* threads */
  const [threads, setThreads]   = useState([]);
  const [nextToken, setNextToken] = useState(null);
  const [loadingList, setLoadingList] = useState(false);

  /* selected thread */
  const [selectedId, setSelectedId] = useState(null);
  const [selected, setSelected]     = useState(null);
  const [loadingThread, setLoadingThread] = useState(false);

  /* labels */
  const [labels, setLabels] = useState([]);

  /* compose */
  const [composeOpen, setComposeOpen]   = useState(false);
  const [replyToThread, setReplyToThread] = useState(null); // holds thread when replying
  const [initialCompose, setInitialCompose] = useState(null);

  /* contact filter */
  const [contacts, setContacts] = useState([]);
  const [selectedContactId, setSelectedContactId] = useState("");
  const [contactFilterMode, setContactFilterMode] = useState("emails"); // emails | domain | both

  /* ---------- OAuth callback handling ---------- */
  useEffect(() => {
    const p = new URLSearchParams(location.search);
    if (p.get("gmail_connected") === "1") {
      toast.success("Gmail connected");
      window.history.replaceState({}, "", "/crm/email");
    }
    if (p.get("gmail_error")) {
      toast.error("Gmail connection failed: " + p.get("gmail_error"));
      window.history.replaceState({}, "", "/crm/email");
    }
  }, [location.search]);

  /* ---------- Load connection status ---------- */
  const loadStatus = useCallback(async () => {
    try {
      const r = await api.get("/gmail/status");
      setStatus({ loading: false, connected: !!r.data?.connected, email: r.data?.email || "" });
    } catch {
      setStatus({ loading: false, connected: false, email: "" });
    }
  }, []);

  useEffect(() => { loadStatus(); }, [loadStatus]);

  /* ---------- Contacts (for filter chip) ---------- */
  useEffect(() => {
    if (!currentId) return;
    api.get(`/companies/${currentId}/contacts`).then(r => {
      const list = Array.isArray(r.data) ? r.data : (r.data?.contacts || []);
      // Only contacts with an email are useful for the filter
      setContacts(list.filter(c => (c.email || c.website)));
    }).catch(() => {});
  }, [currentId]);

  /* ---------- Compute Gmail search query ---------- */
  const contact = useMemo(
    () => contacts.find(c => c.id === selectedContactId),
    [contacts, selectedContactId],
  );

  const gmailQuery = useMemo(() => {
    const parts = [];
    // Contact filter
    if (contact) {
      const emails  = [contact.email].filter(Boolean);
      const domain  = domainOf(contact.website) || domainOf(contact.email);
      const emailQ  = emails.length ? `(from:${emails[0]} OR to:${emails[0]})` : "";
      const domainQ = domain
        ? `(from:@${domain} OR to:@${domain})`
        : "";
      if (contactFilterMode === "emails" && emailQ) parts.push(emailQ);
      else if (contactFilterMode === "domain" && domainQ) parts.push(domainQ);
      else if (contactFilterMode === "both") {
        const both = [emailQ, domainQ].filter(Boolean).join(" OR ");
        if (both) parts.push(`(${both})`);
      } else if (emailQ) parts.push(emailQ);
      else if (domainQ) parts.push(domainQ);
    }
    if (debouncedQ) parts.push(debouncedQ);
    return parts.join(" ");
  }, [contact, contactFilterMode, debouncedQ]);

  /* ---------- Load threads ---------- */
  const loadThreads = useCallback(async (opts = {}) => {
    if (!status.connected) return;
    setLoadingList(true);
    try {
      const params = new URLSearchParams();
      params.set("label", folder);
      if (gmailQuery) params.set("q", gmailQuery);
      params.set("max_results", "25");
      if (opts.pageToken) params.set("page_token", opts.pageToken);
      const r = await api.get(`/gmail/threads?${params.toString()}`);
      const items = r.data?.threads || [];
      setThreads(opts.pageToken ? [...threads, ...items] : items);
      setNextToken(r.data?.next_page_token || null);
    } catch (e) {
      const msg = e?.response?.data?.detail || "Failed to load threads";
      if (e?.response?.status === 401) {
        setStatus({ loading: false, connected: false, email: "" });
      } else {
        toast.error(msg);
      }
    } finally {
      setLoadingList(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status.connected, folder, gmailQuery]);

  useEffect(() => { loadThreads(); }, [loadThreads]);

  /* ---------- Load labels ---------- */
  useEffect(() => {
    if (!status.connected) return;
    api.get("/gmail/labels").then(r => setLabels(r.data?.labels || [])).catch(() => {});
  }, [status.connected]);

  /* ---------- Open a thread ---------- */
  const openThread = async (t) => {
    setSelectedId(t.id);
    setSelected(null);
    setLoadingThread(true);
    try {
      const q = currentId ? `?company_id=${encodeURIComponent(currentId)}` : "";
      const r = await api.get(`/gmail/threads/${t.id}${q}`);
      setSelected(r.data);
      // Mark thread as read
      if (t.unread) {
        api.post(`/gmail/threads/${t.id}/mark-read?read=true`).catch(() => {});
        setThreads(ts => ts.map(x => x.id === t.id ? { ...x, unread: false } : x));
      }
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to load thread");
    } finally { setLoadingThread(false); }
  };

  /* ---------- Star toggle ---------- */
  const toggleStar = async (t) => {
    const newStarred = !t.starred;
    setThreads(ts => ts.map(x => x.id === t.id ? { ...x, starred: newStarred } : x));
    try {
      await api.post(`/gmail/threads/${t.id}/star?starred=${newStarred}`);
    } catch (e) {
      setThreads(ts => ts.map(x => x.id === t.id ? { ...x, starred: !newStarred } : x));
      toast.error("Failed to update star");
    }
  };

  /* ---------- Trash ---------- */
  const trashThread = async (t) => {
    if (!window.confirm("Move this thread to Trash?")) return;
    try {
      await api.post(`/gmail/threads/${t.id}/trash`);
      setThreads(ts => ts.filter(x => x.id !== t.id));
      if (selectedId === t.id) { setSelectedId(null); setSelected(null); }
      toast.success("Moved to Trash");
    } catch { toast.error("Failed to trash thread"); }
  };

  /* ---------- Connect / Disconnect ---------- */
  const connect = async () => {
    try {
      const r = await api.get("/oauth/gmail/start?return_to=/crm/email");
      window.location.href = r.data.auth_url;
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to start Gmail connect");
    }
  };

  const disconnect = async () => {
    if (!window.confirm("Disconnect Gmail?")) return;
    try {
      await api.post("/gmail/disconnect");
      setStatus({ loading: false, connected: false, email: "" });
      setThreads([]); setSelected(null); setSelectedId(null);
      toast.success("Gmail disconnected");
    } catch { toast.error("Failed to disconnect"); }
  };

  /* ---------- UI ---------- */
  if (status.loading) {
    return <div className="p-8 flex items-center gap-2 text-slate-500">
      <Loader2 className="animate-spin" size={16}/> Loading Gmail…
    </div>;
  }

  if (!status.connected) {
    return <ConnectPanel onConnect={connect} />;
  }

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]" data-testid="crm-email-page">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-200 bg-white">
        <MailIcon size={18} className="text-cyan-600" />
        <div className="font-semibold text-slate-900">Email</div>
        <div className="text-xs text-slate-500 hidden md:block">{status.email}</div>
        <div className="flex-1" />
        <button
          data-testid="email-compose-btn"
          onClick={() => { setReplyToThread(null); setInitialCompose(null); setComposeOpen(true); }}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-cyan-600 hover:bg-cyan-700 text-white text-sm shadow-sm">
          <Plus size={14}/> Compose
        </button>
        <button
          data-testid="email-refresh-btn"
          onClick={() => loadThreads()}
          className="p-1.5 rounded hover:bg-slate-100 text-slate-600" title="Refresh">
          <RefreshCw size={16}/>
        </button>
        <button
          data-testid="email-disconnect-btn"
          onClick={disconnect}
          className="text-xs text-slate-500 hover:text-rose-600 underline underline-offset-2">
          Disconnect
        </button>
      </div>

      {/* Toolbar row */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-slate-200 bg-white/60">
        {/* Folder pills */}
        <div className="flex items-center gap-1 overflow-x-auto">
          {FOLDERS.map(f => {
            const Icon = f.icon;
            const lbl = labels.find(l => l.id === f.id);
            const unread = lbl?.messages_unread || 0;
            const active = folder === f.id;
            return (
              <button
                key={f.id}
                data-testid={`email-folder-${f.id.toLowerCase()}`}
                onClick={() => { setFolder(f.id); setSelectedId(null); setSelected(null); }}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs transition ${
                  active
                    ? "bg-cyan-50 text-cyan-800 border border-cyan-200 font-medium"
                    : "text-slate-600 hover:bg-slate-100 border border-transparent"
                }`}>
                <Icon size={13}/> {f.label}
                {unread > 0 && f.id === "INBOX" && (
                  <span className="ml-1 px-1.5 py-0.5 rounded-full bg-cyan-600 text-white text-[10px] font-semibold">
                    {unread}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="flex-1" />

        {/* Contact filter chip */}
        <ContactFilter
          contacts={contacts}
          selectedId={selectedContactId}
          setSelectedId={setSelectedContactId}
          mode={contactFilterMode}
          setMode={setContactFilterMode}
        />

        {/* Search */}
        <div className="relative">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400"/>
          <input
            data-testid="email-search"
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search…"
            className="pl-7 pr-2 py-1 text-xs rounded-md border border-slate-200 bg-white focus:outline-none focus:border-cyan-400 w-52"
          />
        </div>
      </div>

      {/* Full-width single-column, drills into a full-page reader */}
      <div className="flex-1 overflow-hidden bg-slate-50">
        {!selectedId ? (
          /* ─── List view ─── */
          <div className="h-full overflow-y-auto bg-white" data-testid="email-thread-list">
            {loadingList && threads.length === 0 && (
              <div className="p-8 flex items-center gap-2 text-slate-500 text-sm">
                <Loader2 className="animate-spin" size={14}/> Loading messages…
              </div>
            )}
            {!loadingList && threads.length === 0 && (
              <div className="p-16 text-center text-slate-500 text-sm">
                No messages in {FOLDERS.find(f => f.id === folder)?.label || folder}.
              </div>
            )}
            {threads.map(t => (
              <ThreadRow
                key={t.id}
                thread={t}
                onOpen={() => openThread(t)}
                onToggleStar={() => toggleStar(t)}
                onTrash={() => trashThread(t)}
              />
            ))}
            {nextToken && (
              <div className="p-4 text-center">
                <button
                  onClick={() => loadThreads({ pageToken: nextToken })}
                  className="text-xs text-cyan-600 hover:text-cyan-700 underline">
                  Load more
                </button>
              </div>
            )}
          </div>
        ) : (
          /* ─── Full-page reading view ─── */
          <div className="h-full overflow-y-auto" data-testid="email-reading-pane">
            <div className="max-w-5xl mx-auto">
              {/* Back bar */}
              <div className="sticky top-0 z-10 bg-slate-50/95 backdrop-blur px-6 py-2 border-b border-slate-200 flex items-center gap-2">
                <button
                  data-testid="email-back-btn"
                  onClick={() => { setSelectedId(null); setSelected(null); }}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-slate-100 text-slate-600 text-sm">
                  <ChevronLeft size={16}/> Back to {FOLDERS.find(f => f.id === folder)?.label || "Inbox"}
                </button>
              </div>
              {loadingThread && (
                <div className="p-8 flex items-center gap-2 text-slate-500 text-sm">
                  <Loader2 className="animate-spin" size={14}/> Loading thread…
                </div>
              )}
              {selected && (
                <ThreadView
                  thread={selected}
                  onReply={() => {
                    setReplyToThread(selected);
                    setInitialCompose(null);
                    setComposeOpen(true);
                  }}
                  onTrash={() => trashThread({ id: selected.id })}
                />
              )}
            </div>
          </div>
        )}
      </div>

      {/* Compose modal */}
      {composeOpen && (
        <ComposeModal
          onClose={() => setComposeOpen(false)}
          onSent={() => {
            setComposeOpen(false);
            toast.success("Email sent");
            if (folder === "SENT") loadThreads();
          }}
          replyThread={replyToThread}
          initial={initialCompose}
          companyId={currentId}
        />
      )}
    </div>
  );
}


/* ------------------------------------------------------------------ */
/*  Connect Panel                                                     */
/* ------------------------------------------------------------------ */
function ConnectPanel({ onConnect }) {
  return (
    <div className="p-8 max-w-2xl mx-auto" data-testid="email-connect-panel">
      <div className="rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-lg bg-cyan-50">
            <MailIcon size={24} className="text-cyan-600"/>
          </div>
          <div>
            <div className="text-lg font-semibold text-slate-900">Connect Google Workspace</div>
            <div className="text-sm text-slate-500">
              One consent screen unlocks Gmail <em>and</em> Google Calendar inside your CRM.
            </div>
          </div>
        </div>
        <ul className="mt-6 space-y-2 text-sm text-slate-600">
          <li className="flex items-start gap-2"><span className="mt-1 h-1.5 w-1.5 rounded-full bg-cyan-500"/> Full Gmail inbox with folders, search, and filter by Contact</li>
          <li className="flex items-start gap-2"><span className="mt-1 h-1.5 w-1.5 rounded-full bg-cyan-500"/> Compose with rich formatting, CC/BCC, and attachments</li>
          <li className="flex items-start gap-2"><span className="mt-1 h-1.5 w-1.5 rounded-full bg-cyan-500"/> Google Calendar events overlaid on Team Calendar &amp; a dedicated CRM Calendar</li>
          <li className="flex items-start gap-2"><span className="mt-1 h-1.5 w-1.5 rounded-full bg-cyan-500"/> Schedule meetings from Deals and auto-invite the linked Contact</li>
        </ul>
        <div className="mt-6 flex items-center gap-3">
          <button
            data-testid="email-connect-btn"
            onClick={onConnect}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-cyan-600 hover:bg-cyan-700 text-white text-sm shadow-sm">
            <MailIcon size={14}/> Connect Google
          </button>
          <div className="text-xs text-slate-500">You'll be redirected to Google to authorize.</div>
        </div>
      </div>
    </div>
  );
}


/* ------------------------------------------------------------------ */
/*  Thread row (Gmail-style: sender · subject · snippet inline)       */
/* ------------------------------------------------------------------ */
function ThreadRow({ thread, onOpen, onToggleStar, onTrash }) {
  const sender = displayName(thread.from) || extractEmail(thread.from);
  const unread = thread.unread;
  return (
    <div
      onClick={onOpen}
      data-testid={`email-thread-row-${thread.id}`}
      className={`group grid grid-cols-[36px_220px_1fr_120px] items-center gap-2 px-4 py-2 border-b border-slate-100 cursor-pointer transition ${
        unread ? "bg-white hover:bg-slate-50" : "bg-slate-50/50 hover:bg-white"
      }`}>
      {/* Star */}
      <button
        onClick={e => { e.stopPropagation(); onToggleStar(); }}
        className={`${thread.starred ? "text-amber-500" : "text-slate-300 hover:text-amber-500"}`}
        data-testid={`email-thread-star-${thread.id}`}>
        <Star size={15} fill={thread.starred ? "currentColor" : "none"}/>
      </button>
      {/* Sender */}
      <div className={`text-sm truncate ${unread ? "font-bold text-slate-900" : "text-slate-700"}`}>
        {sender || "(unknown)"}
        {thread.message_count > 1 && (
          <span className="ml-1 text-slate-500 font-normal text-xs">
            ({thread.message_count})
          </span>
        )}
      </div>
      {/* Subject + snippet */}
      <div className="min-w-0 flex items-baseline gap-2 overflow-hidden">
        <span className={`text-sm truncate shrink-0 max-w-[45%] ${unread ? "font-bold text-slate-900" : "text-slate-700"}`}>
          {thread.subject || "(no subject)"}
        </span>
        <span className="text-slate-400">—</span>
        <span className="text-sm text-slate-500 truncate">{thread.snippet}</span>
      </div>
      {/* Date + hover trash */}
      <div className="text-xs text-slate-500 shrink-0 flex items-center justify-end gap-2">
        <button
          onClick={e => { e.stopPropagation(); onTrash?.(); }}
          className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-rose-50 text-slate-400 hover:text-rose-600 transition"
          title="Move to Trash">
          <Trash2 size={14}/>
        </button>
        <span>{fmtWhen(thread.date, thread.internal_date)}</span>
      </div>
    </div>
  );
}


/* ------------------------------------------------------------------ */
/*  Thread view                                                       */
/* ------------------------------------------------------------------ */
function ThreadView({ thread, onReply, onTrash }) {
  const messages = thread.messages || [];
  // Newest first — Gmail's default when viewing a thread from the inbox
  const orderedMessages = [...messages].reverse();
  const subject = messages[0]?.subject || "(no subject)";
  const [expandedIds, setExpandedIds] = useState(
    // Expand only the newest message by default (which now sits at index 0)
    new Set(orderedMessages.length ? [orderedMessages[0].id] : [])
  );

  const toggle = (id) => setExpandedIds(s => {
    const n = new Set(s);
    n.has(id) ? n.delete(id) : n.add(id);
    return n;
  });

  return (
    <div className="p-6 md:p-8" data-testid="email-thread-view">
      <div className="flex items-start gap-3 mb-6">
        <div className="flex-1">
          <div className="text-2xl font-semibold text-slate-900 leading-tight">{subject}</div>
          <div className="text-xs text-slate-500 mt-1">{messages.length} message{messages.length > 1 ? "s" : ""} · newest first</div>
        </div>
        <button onClick={onReply} data-testid="email-reply-btn"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-cyan-600 hover:bg-cyan-700 text-white text-sm">
          <Reply size={14}/> Reply
        </button>
        <button onClick={onTrash} data-testid="email-trash-btn"
                className="p-1.5 rounded hover:bg-rose-50 text-slate-500 hover:text-rose-600" title="Move to Trash">
          <Trash2 size={16}/>
        </button>
      </div>

      <div className="space-y-3">
        {orderedMessages.map((m, idx) => (
          <MessageCard
            key={m.id}
            message={m}
            expanded={expandedIds.has(m.id) || idx === 0}
            onToggle={() => toggle(m.id)}
            isLast={idx === 0}
          />
        ))}
      </div>
    </div>
  );
}


function MessageCard({ message, expanded, onToggle, isLast }) {
  const from = displayName(message.from);
  const fromEmail = extractEmail(message.from);

  return (
    <div className="bg-white rounded-lg border border-slate-200 shadow-sm">
      <button onClick={onToggle}
              className="w-full flex items-start gap-3 px-4 py-3 text-left"
              data-testid={`email-message-header-${message.id}`}>
        <div className="h-8 w-8 rounded-full bg-cyan-100 text-cyan-800 flex items-center justify-center text-xs font-semibold shrink-0">
          {initials(message.from)}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-slate-900 truncate">
            {from || fromEmail} <span className="text-slate-400 font-normal text-xs">&lt;{fromEmail}&gt;</span>
          </div>
          <div className="text-xs text-slate-500 truncate">
            To: {message.to || "(none)"}
            {message.cc && <span className="ml-2">Cc: {message.cc}</span>}
          </div>
          {!expanded && (
            <div className="text-xs text-slate-500 truncate mt-1">{message.snippet}</div>
          )}
        </div>
        <div className="text-xs text-slate-500 shrink-0 mr-2">
          {fmtWhen(message.date, message.internal_date)}
        </div>
        {expanded ? <ChevronUp size={14} className="text-slate-400 shrink-0"/>
                  : <ChevronDown size={14} className="text-slate-400 shrink-0"/>}
      </button>
      {expanded && (
        <div className="px-4 pb-4">
          <MessageBody message={message}/>
          {message.attachments?.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-2">
              {message.attachments.map((a, i) => (
                <AttachmentChip key={i} messageId={message.id} att={a}/>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}


function MessageBody({ message }) {
  const html = message.html;
  const text = message.text;
  if (html) {
    // Sanitize *very lightly* — strip scripts, event handlers, and force
    // links to open in a new tab. Gmail already sanitizes inbound HTML
    // so this is defense-in-depth.
    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/ on\w+="[^"]*"/gi, "")
      .replace(/ on\w+='[^']*'/gi, "")
      .replace(/<a /gi, '<a target="_blank" rel="noopener noreferrer" ');
    return (
      <div className="prose prose-sm max-w-none text-slate-800"
           dangerouslySetInnerHTML={{ __html: cleaned }}
           data-testid={`email-body-${message.id}`}/>
    );
  }
  return <pre className="text-sm text-slate-800 whitespace-pre-wrap font-sans"
              data-testid={`email-body-${message.id}`}>{text || "(no content)"}</pre>;
}


function AttachmentChip({ messageId, att }) {
  const [busy, setBusy] = useState(false);
  const download = async () => {
    setBusy(true);
    try {
      const r = await api.get(`/gmail/messages/${messageId}/attachments/${att.attachment_id}`);
      const b64 = (r.data?.data || "").replace(/-/g, "+").replace(/_/g, "/");
      const binary = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: att.mime_type || "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = att.filename || "attachment";
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch { toast.error("Download failed"); }
    finally { setBusy(false); }
  };
  return (
    <button onClick={download} disabled={busy}
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-slate-200 bg-slate-50 hover:bg-slate-100 text-xs text-slate-700">
      <Paperclip size={12}/> {att.filename}
      {busy && <Loader2 size={10} className="animate-spin"/>}
    </button>
  );
}


/* ------------------------------------------------------------------ */
/*  Contact filter                                                    */
/* ------------------------------------------------------------------ */
function ContactFilter({ contacts, selectedId, setSelectedId, mode, setMode }) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState("");
  const ref = useRef(null);
  useEffect(() => {
    const on = e => { if (!ref.current?.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", on);
    return () => document.removeEventListener("mousedown", on);
  }, []);
  const selected = contacts.find(c => c.id === selectedId);
  const filtered = useMemo(() => {
    const t = term.trim().toLowerCase();
    if (!t) return contacts.slice(0, 40);
    return contacts.filter(c =>
      (c.name || "").toLowerCase().includes(t)
      || (c.email || "").toLowerCase().includes(t)).slice(0, 40);
  }, [contacts, term]);

  return (
    <div className="relative" ref={ref}>
      <button
        data-testid="email-contact-filter-btn"
        onClick={() => setOpen(o => !o)}
        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs border transition ${
          selected
            ? "bg-indigo-50 text-indigo-800 border-indigo-200"
            : "bg-white text-slate-600 border-slate-200 hover:bg-slate-50"
        }`}>
        <Filter size={12}/>
        {selected ? (
          <>
            <span className="max-w-[130px] truncate">{selected.name}</span>
            <X size={12} onClick={e => { e.stopPropagation(); setSelectedId(""); }}
               className="hover:text-rose-600"/>
          </>
        ) : "Filter by Contact"}
      </button>
      {open && (
        <div className="absolute right-0 top-8 z-30 w-80 rounded-lg border border-slate-200 bg-white shadow-lg p-2"
             data-testid="email-contact-filter-dropdown">
          <input
            autoFocus
            value={term} onChange={e => setTerm(e.target.value)}
            placeholder="Search contacts…"
            className="w-full px-2 py-1 text-xs rounded border border-slate-200 focus:outline-none focus:border-cyan-400"
          />
          {/* mode toggle */}
          {selected && (
            <div className="mt-2 flex items-center gap-1 text-[10px]">
              {[
                { id: "emails", label: "Email only" },
                { id: "domain", label: "Domain only" },
                { id: "both",   label: "Both" },
              ].map(m => (
                <button key={m.id}
                        data-testid={`email-contact-filter-mode-${m.id}`}
                        onClick={() => setMode(m.id)}
                        className={`px-1.5 py-0.5 rounded ${
                          mode === m.id
                            ? "bg-indigo-600 text-white"
                            : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                        }`}>{m.label}</button>
              ))}
            </div>
          )}
          <div className="mt-2 max-h-64 overflow-y-auto">
            {filtered.length === 0 && (
              <div className="p-3 text-xs text-slate-400 text-center">No contacts</div>
            )}
            {filtered.map(c => (
              <button
                key={c.id}
                data-testid={`email-contact-filter-option-${c.id}`}
                onClick={() => { setSelectedId(c.id); setOpen(false); }}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left hover:bg-slate-50 ${
                  selectedId === c.id ? "bg-indigo-50" : ""
                }`}>
                <UserIcon size={12} className="text-slate-400"/>
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-slate-900 truncate">{c.name}</div>
                  <div className="text-[10px] text-slate-500 truncate">{c.email || domainOf(c.website)}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}


/* ------------------------------------------------------------------ */
/*  Compose Modal (Gmail-style bottom-right dock with min/max/close)  */
/* ------------------------------------------------------------------ */
function ComposeModal({ onClose, onSent, replyThread, initial, companyId }) {
  const isReply = !!replyThread;
  const lastMsg = isReply
    ? (replyThread.messages?.[replyThread.messages.length - 1] || {})
    : {};

  const [to, setTo]           = useState(initial?.to ?? (isReply ? extractEmail(lastMsg.from) : ""));
  const [cc, setCc]           = useState(initial?.cc ?? "");
  const [bcc, setBcc]         = useState(initial?.bcc ?? "");
  const [subject, setSubject] = useState(
    initial?.subject ?? (isReply
      ? (lastMsg.subject?.toLowerCase().startsWith("re:") ? lastMsg.subject : `Re: ${lastMsg.subject || ""}`)
      : "")
  );
  const [showCc, setShowCc]   = useState(!!cc || !!bcc);
  const [attachments, setAttachments] = useState([]);
  const [sending, setSending] = useState(false);
  // window state: "normal" (bottom-right dock), "min" (title bar only),
  // "full" (fullscreen centered — for heavy editing)
  const [windowState, setWindowState] = useState("normal");
  const bodyRef = useRef(null);

  const applyFormat = (cmd, value = null) => {
    document.execCommand(cmd, false, value);
    bodyRef.current?.focus();
  };

  const insertLink = () => {
    const url = window.prompt("Enter URL:");
    if (url) applyFormat("createLink", url);
  };

  const onFileChange = (e) => {
    const list = Array.from(e.target.files || []);
    setAttachments(prev => [...prev, ...list]);
    e.target.value = "";
  };

  const removeAttachment = (i) => setAttachments(prev => prev.filter((_, idx) => idx !== i));

  const send = async () => {
    if (!to.trim()) { toast.error("Recipient is required"); return; }
    setSending(true);
    try {
      const fd = new FormData();
      const html = bodyRef.current?.innerHTML || "";
      const text = bodyRef.current?.innerText || "";
      if (isReply) {
        fd.append("body_html", html);
        fd.append("body_text", text);
        fd.append("to_override", to);
        if (cc) fd.append("cc", cc);
        if (companyId) fd.append("company_id", companyId);
        attachments.forEach(f => fd.append("attachments", f));
        await api.post(`/gmail/threads/${replyThread.id}/reply`, fd, {
          headers: { "Content-Type": "multipart/form-data" },
        });
      } else {
        fd.append("to", to);
        if (cc) fd.append("cc", cc);
        if (bcc) fd.append("bcc", bcc);
        fd.append("subject", subject);
        fd.append("body_html", html);
        fd.append("body_text", text);
        if (companyId) fd.append("company_id", companyId);
        attachments.forEach(f => fd.append("attachments", f));
        await api.post("/gmail/send", fd, {
          headers: { "Content-Type": "multipart/form-data" },
        });
      }
      onSent();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Failed to send");
    } finally { setSending(false); }
  };

  // Position/sizing per window state — no backdrop in normal/min so the
  // rest of the app stays interactive (Gmail-style non-modal compose).
  // Higher z-index than the AI panel (z-60). When the AI panel is
  // expanded (body[data-ai-panel-open="1"]), offset the compose to the
  // left by --ai-panel-width so it never hides behind the assistant.
  const [aiOpen, setAiOpen] = useState(
    () => (typeof document !== "undefined")
      && document.body.getAttribute("data-ai-panel-open") === "1");
  useEffect(() => {
    const check = () => setAiOpen(document.body.getAttribute("data-ai-panel-open") === "1");
    check();
    const mo = new MutationObserver(check);
    mo.observe(document.body, { attributes: true, attributeFilter: ["data-ai-panel-open"] });
    return () => mo.disconnect();
  }, []);

  const isFull   = windowState === "full";
  const isMin    = windowState === "min";
  const rightOffset = aiOpen ? "calc(24px + var(--ai-panel-width, 0px))" : "24px";
  const outerCls = isFull
    ? "fixed inset-0 z-[70] flex items-center justify-center bg-black/40"
    : "fixed z-[70] bottom-0 pointer-events-none";
  const outerStyle = isFull ? undefined : { right: rightOffset };
  const cardCls = isFull
    ? "bg-white rounded-xl w-[92vw] max-w-[1100px] h-[86vh] flex flex-col shadow-2xl pointer-events-auto"
    : isMin
      ? "bg-white rounded-t-xl w-[380px] shadow-2xl border border-slate-200 border-b-0 pointer-events-auto"
      : "bg-white rounded-t-xl w-[540px] max-w-[92vw] h-[560px] max-h-[80vh] flex flex-col shadow-2xl border border-slate-200 border-b-0 pointer-events-auto";
  const onBackdrop = isFull ? onClose : undefined;

  return (
    <div className={outerCls} style={outerStyle} onClick={onBackdrop}>
      <div className={cardCls}
           onClick={e => e.stopPropagation()}
           data-testid="email-compose-modal"
           data-window-state={windowState}>
        {/* Header — dark like Gmail, clickable to toggle min */}
        <div
          onClick={() => isMin && setWindowState("normal")}
          className={`flex items-center px-4 py-2 bg-slate-800 text-white ${
            isFull ? "rounded-t-xl" : "rounded-t-xl"
          } ${isMin ? "cursor-pointer" : ""}`}>
          <div className="text-sm font-medium truncate flex-1">
            {isReply
              ? `Reply${subject ? ": " + subject.replace(/^Re:\s*/i, "") : ""}`
              : (subject || "New Message")}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button onClick={e => { e.stopPropagation(); setWindowState(s => s === "min" ? "normal" : "min"); }}
                    className="p-1 rounded hover:bg-white/10"
                    data-testid="email-compose-minimize"
                    title={isMin ? "Restore" : "Minimize"}>
              <Minus size={14}/>
            </button>
            <button onClick={e => { e.stopPropagation(); setWindowState(s => s === "full" ? "normal" : "full"); }}
                    className="p-1 rounded hover:bg-white/10"
                    data-testid="email-compose-maximize"
                    title={isFull ? "Exit full screen" : "Full screen"}>
              {isFull ? <Minimize2 size={13}/> : <Maximize2 size={13}/>}
            </button>
            <button onClick={e => { e.stopPropagation(); onClose(); }}
                    className="p-1 rounded hover:bg-white/10"
                    data-testid="email-compose-close"
                    title="Close">
              <X size={14}/>
            </button>
          </div>
        </div>

        {!isMin && (<>
        <div className="px-4 py-2 space-y-1 text-sm">
          <FieldRow label="To">
            <input value={to} onChange={e => setTo(e.target.value)}
                   placeholder="recipient@example.com"
                   data-testid="email-compose-to"
                   className="flex-1 outline-none text-sm py-1"/>
            {!showCc && (
              <button onClick={() => setShowCc(true)}
                      data-testid="email-compose-showcc"
                      className="text-xs text-slate-500 hover:text-slate-700 px-2">Cc/Bcc</button>
            )}
          </FieldRow>
          {showCc && (
            <>
              <FieldRow label="Cc">
                <input value={cc} onChange={e => setCc(e.target.value)}
                       placeholder="cc@example.com"
                       data-testid="email-compose-cc"
                       className="flex-1 outline-none text-sm py-1"/>
              </FieldRow>
              <FieldRow label="Bcc">
                <input value={bcc} onChange={e => setBcc(e.target.value)}
                       placeholder="bcc@example.com"
                       data-testid="email-compose-bcc"
                       className="flex-1 outline-none text-sm py-1"/>
              </FieldRow>
            </>
          )}
          {!isReply && (
            <FieldRow label="Subject">
              <input value={subject} onChange={e => setSubject(e.target.value)}
                     placeholder="Subject"
                     data-testid="email-compose-subject"
                     className="flex-1 outline-none text-sm py-1 font-medium"/>
            </FieldRow>
          )}
        </div>

        {/* Toolbar */}
        <div className="flex items-center gap-1 px-3 py-1.5 border-y border-slate-100">
          <ToolbarBtn onClick={() => applyFormat("bold")} icon={Bold} label="Bold"/>
          <ToolbarBtn onClick={() => applyFormat("italic")} icon={Italic} label="Italic"/>
          <ToolbarBtn onClick={() => applyFormat("underline")} icon={UIcon} label="Underline"/>
          <div className="mx-1 h-4 w-px bg-slate-200"/>
          <ToolbarBtn onClick={() => applyFormat("insertUnorderedList")} icon={ListIcon} label="Bulleted list"/>
          <ToolbarBtn onClick={() => applyFormat("insertOrderedList")} icon={ListOrdered} label="Numbered list"/>
          <div className="mx-1 h-4 w-px bg-slate-200"/>
          <ToolbarBtn onClick={insertLink} icon={LinkIcon} label="Insert link"/>
          <label className="inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-slate-100 text-xs text-slate-600 cursor-pointer"
                 data-testid="email-compose-attach-btn">
            <Paperclip size={13}/> Attach
            <input type="file" multiple onChange={onFileChange} className="hidden"/>
          </label>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">
          <div
            ref={bodyRef}
            contentEditable
            suppressContentEditableWarning
            data-testid="email-compose-body"
            className="min-h-[220px] outline-none text-sm text-slate-900 leading-relaxed"
            style={{ wordBreak: "break-word" }}
          />
        </div>

        {/* Attachments preview */}
        {attachments.length > 0 && (
          <div className="px-4 pb-2 flex flex-wrap gap-2">
            {attachments.map((f, i) => (
              <div key={i} className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md border border-slate-200 bg-slate-50 text-xs">
                <Paperclip size={12}/>
                <span className="truncate max-w-[180px]">{f.name}</span>
                <button onClick={() => removeAttachment(i)}
                        className="text-slate-400 hover:text-rose-600">
                  <X size={12}/>
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center gap-2 px-4 py-3 border-t border-slate-200">
          <button
            onClick={send}
            disabled={sending}
            data-testid="email-compose-send"
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-cyan-600 hover:bg-cyan-700 text-white text-sm disabled:opacity-50">
            {sending ? <Loader2 size={14} className="animate-spin"/> : <Send size={14}/>}
            Send
          </button>
          <div className="flex-1"/>
          <button onClick={onClose}
                  className="text-sm text-slate-600 hover:text-slate-800">Discard</button>
        </div>
        </>)}
      </div>
    </div>
  );
}


function FieldRow({ label, children }) {
  return (
    <div className="flex items-center gap-2 border-b border-slate-100 py-0.5">
      <div className="text-xs text-slate-500 w-14 shrink-0">{label}</div>
      {children}
    </div>
  );
}


function ToolbarBtn({ onClick, icon: Icon, label }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className="p-1.5 rounded hover:bg-slate-100 text-slate-600">
      <Icon size={14}/>
    </button>
  );
}
