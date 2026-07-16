'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface Thread {
  contactId: string | null;
  contactName: string | null;
  contactPhone: string | null;
  lastMessageAt: string;
  lastMessageBody: string;
  lastDirection: 'inbound' | 'outbound';
  unreadCount: number;
}

interface Message {
  id: string;
  direction: 'inbound' | 'outbound';
  body: string;
  status: string | null;
  fromPhone: string;
  toPhone: string;
  sentByUserId: string | null;
  createdAt: string;
}

interface ContactOption {
  id: string;
  name: string;
  phone: string;
}

interface Props {
  initialThreads: Thread[];
  contactsWithPhone: ContactOption[];
}

function threadKey(t: Thread): string {
  return t.contactId ?? 'none';
}

function threadDisplayName(t: Thread): string {
  return t.contactName ?? t.contactPhone ?? 'Unknown number';
}

export function TextsWorkspace({ initialThreads, contactsWithPhone }: Props) {
  const [threads, setThreads] = useState<Thread[]>(initialThreads);
  const [activeKey, setActiveKey] = useState<string | null>(
    initialThreads[0] ? threadKey(initialThreads[0]) : null,
  );
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeContactId, setComposeContactId] = useState('');
  const [composeBody, setComposeBody] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const activeThread = useMemo(
    () => threads.find((t) => threadKey(t) === activeKey) ?? null,
    [threads, activeKey],
  );

  const refreshThreads = useCallback(async () => {
    const res = await fetch('/api/texts/threads');
    if (!res.ok) return;
    const json = (await res.json()) as { threads: Thread[] };
    setThreads(json.threads);
  }, []);

  const loadMessages = useCallback(async (key: string) => {
    setLoadingMsgs(true);
    setMessages([]);
    try {
      const res = await fetch(`/api/texts/${encodeURIComponent(key)}/messages`);
      if (!res.ok) return;
      const json = (await res.json()) as { messages: Message[] };
      setMessages(json.messages);
    } finally {
      setLoadingMsgs(false);
    }
  }, []);

  useEffect(() => {
    if (activeKey) loadMessages(activeKey);
  }, [activeKey, loadMessages]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages]);

  const sendDraft = useCallback(async () => {
    if (!activeThread || !activeThread.contactId || !draft.trim()) return;
    const body = draft.trim();
    setSending(true);
    setSendError(null);
    try {
      const res = await fetch('/api/texts/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId: activeThread.contactId, body }),
      });
      const json = (await res.json()) as { id?: string; status?: string; error?: string };
      if (!res.ok) throw new Error(json.error ?? `send ${res.status}`);
      setDraft('');
      await Promise.all([loadMessages(threadKey(activeThread)), refreshThreads()]);
    } catch (err) {
      setSendError((err as Error).message);
    } finally {
      setSending(false);
    }
  }, [activeThread, draft, loadMessages, refreshThreads]);

  const sendNewThread = useCallback(async () => {
    if (!composeContactId || !composeBody.trim()) return;
    setSending(true);
    setSendError(null);
    try {
      const res = await fetch('/api/texts/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactId: composeContactId, body: composeBody.trim() }),
      });
      const json = (await res.json()) as { id?: string; status?: string; error?: string };
      if (!res.ok) throw new Error(json.error ?? `send ${res.status}`);
      setComposeBody('');
      setComposeOpen(false);
      await refreshThreads();
      setActiveKey(composeContactId);
    } catch (err) {
      setSendError((err as Error).message);
    } finally {
      setSending(false);
    }
  }, [composeContactId, composeBody, refreshThreads]);

  return (
    <div className="flex h-[calc(100vh-12rem)] overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
      <aside className="flex w-72 shrink-0 flex-col border-r border-zinc-200 dark:border-zinc-800">
        <div className="border-b border-zinc-200 p-3 dark:border-zinc-800">
          <button
            type="button"
            onClick={() => setComposeOpen((v) => !v)}
            className="w-full rounded-md bg-sky-600 px-3 py-2 text-sm font-medium text-white hover:bg-sky-700"
          >
            {composeOpen ? 'Cancel new text' : 'New text'}
          </button>
        </div>
        {composeOpen && (
          <div className="space-y-2 border-b border-zinc-200 p-3 dark:border-zinc-800">
            <select
              value={composeContactId}
              onChange={(e) => setComposeContactId(e.target.value)}
              className="block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            >
              <option value="">— pick a contact —</option>
              {contactsWithPhone.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.phone}
                </option>
              ))}
            </select>
            <textarea
              value={composeBody}
              onChange={(e) => setComposeBody(e.target.value)}
              rows={3}
              placeholder="Your message…"
              className="block w-full rounded-md border border-zinc-300 bg-white px-2 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            />
            <button
              type="button"
              onClick={sendNewThread}
              disabled={!composeContactId || !composeBody.trim() || sending}
              className="w-full rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {sending ? 'Sending…' : 'Send'}
            </button>
          </div>
        )}
        <ul className="flex-1 overflow-y-auto">
          {threads.length === 0 && (
            <li className="p-4 text-sm text-zinc-500">No conversations yet.</li>
          )}
          {threads.map((t) => {
            const key = threadKey(t);
            const active = key === activeKey;
            return (
              <li key={key}>
                <button
                  type="button"
                  onClick={() => setActiveKey(key)}
                  className={`flex w-full items-start gap-2 border-b border-zinc-100 p-3 text-left text-sm transition-colors dark:border-zinc-800 ${
                    active ? 'bg-sky-50 dark:bg-sky-950/40' : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-zinc-900 dark:text-zinc-100">
                        {threadDisplayName(t)}
                      </span>
                      {t.unreadCount > 0 && (
                        <span className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-semibold text-white">
                          {t.unreadCount}
                        </span>
                      )}
                    </div>
                    <p className="truncate text-xs text-zinc-500">
                      {t.lastDirection === 'outbound' ? 'You: ' : ''}
                      {t.lastMessageBody}
                    </p>
                  </div>
                  <span className="shrink-0 text-[10px] text-zinc-400">
                    {new Date(t.lastMessageAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <section className="flex flex-1 flex-col">
        {activeThread ? (
          <>
            <header className="border-b border-zinc-200 p-3 dark:border-zinc-800">
              <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
                {threadDisplayName(activeThread)}
              </h2>
              {activeThread.contactPhone && (
                <p className="text-xs text-zinc-500">{activeThread.contactPhone}</p>
              )}
            </header>
            <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto p-4">
              {loadingMsgs && <p className="text-sm text-zinc-500">Loading…</p>}
              {!loadingMsgs &&
                messages.map((m) => (
                  <div
                    key={m.id}
                    className={`flex ${m.direction === 'outbound' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[75%] rounded-2xl px-3 py-2 text-sm ${
                        m.direction === 'outbound'
                          ? 'bg-sky-600 text-white'
                          : 'bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100'
                      }`}
                    >
                      <p className="whitespace-pre-wrap">{m.body}</p>
                      <p
                        className={`mt-1 text-[10px] ${
                          m.direction === 'outbound' ? 'text-sky-100' : 'text-zinc-500'
                        }`}
                      >
                        {new Date(m.createdAt).toLocaleString()}
                        {m.status && m.direction === 'outbound' ? ` · ${m.status}` : ''}
                      </p>
                    </div>
                  </div>
                ))}
            </div>
            <div className="border-t border-zinc-200 p-3 dark:border-zinc-800">
              {!activeThread.contactId ? (
                <p className="text-sm text-zinc-500">
                  This thread has no matched contact. Add a contact with this phone number to reply.
                </p>
              ) : (
                <div className="flex gap-2">
                  <textarea
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                        e.preventDefault();
                        sendDraft();
                      }
                    }}
                    rows={2}
                    placeholder="Type a reply…  (⌘/Ctrl+Enter to send)"
                    className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                  />
                  <button
                    type="button"
                    onClick={sendDraft}
                    disabled={!draft.trim() || sending}
                    className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50"
                  >
                    {sending ? '…' : 'Send'}
                  </button>
                </div>
              )}
              {sendError && (
                <p className="mt-2 text-xs text-rose-600 dark:text-rose-400">{sendError}</p>
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">
            Pick a conversation or hit New text to start one.
          </div>
        )}
      </section>
    </div>
  );
}
