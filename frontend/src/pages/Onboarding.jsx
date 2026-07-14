import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { TID } from "@/constants/testIds";
import { CheckCircle2, ChevronRight, Loader2, Sparkles, ArrowLeft } from "lucide-react";
import { toast } from "sonner";

const STEPS = [
  "Business profile",
  "QuickBooks link",
  "AI Chart of Accounts",
  "Bank connection (Plaid)",
  "Statement upload (Veryfi)",
  "Ready to review",
];

export default function Onboarding() {
  const nav = useNavigate();
  const { currentId, current, refresh } = useCompany();
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState({});
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [plaidAccts, setPlaidAccts] = useState([]);
  const [selectedPlaid, setSelectedPlaid] = useState(new Set());
  const [imported, setImported] = useState({ plaid: 0, veryfi: 0 });

  useEffect(() => {
    if (!currentId) return;
    api.get(`/companies/${currentId}/onboarding`).then(r => {
      setStep(r.data.onboarding.step || 0);
      setAnswers(r.data.onboarding.answers || {});
    });
  }, [currentId]);

  const persist = async (patch) => {
    await api.patch(`/companies/${currentId}/onboarding`, patch);
  };

  const next = async () => {
    await persist({ step: step + 1, answers });
    setStep(step + 1);
  };
  const back = async () => {
    if (step > 0) { await persist({ step: step - 1 }); setStep(step - 1); }
  };
  const finish = async () => {
    await persist({ complete: true, step: STEPS.length, answers });
    await refresh();
    toast.success("Onboarding complete! Welcome to Axiom Ledger.");
    nav("/accounting/transactions");
  };

  const generateCoa = async () => {
    setBusy(true);
    const r = await api.post(`/companies/${currentId}/onboarding/generate-coa`);
    setSuggestions(r.data.suggestions || []);
    setBusy(false);
    toast.success(`AI added ${r.data.added} industry-specific accounts`);
  };
  const mockPlaid = async () => {
    setBusy(true);
    const r = await api.post(`/companies/${currentId}/onboarding/mock-plaid`);
    setPlaidAccts(r.data.accounts || []);
    setBusy(false);
  };
  const importPlaid = async () => {
    setBusy(true);
    const r = await api.post(`/companies/${currentId}/onboarding/import-plaid`, [...selectedPlaid]);
    setImported(v => ({ ...v, plaid: r.data.imported }));
    setBusy(false);
    toast.success(`AI categorized ${r.data.imported} imported transactions`);
  };
  const mockVeryfi = async () => {
    setBusy(true);
    const r = await api.post(`/companies/${currentId}/onboarding/mock-veryfi`);
    setImported(v => ({ ...v, veryfi: r.data.imported }));
    setBusy(false);
    toast.success(`Veryfi OCR'd ${r.data.imported} statement lines`);
  };

  const setAns = (k, v) => setAnswers({ ...answers, [k]: v });

  if (!current) return <div>Select a company.</div>;

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-indigo-100 flex items-center justify-center">
          <Sparkles className="text-indigo-600" size={20} />
        </div>
        <div>
          <h1 className="font-heading text-2xl font-bold">AI-assisted onboarding</h1>
          <p className="text-slate-500 text-sm">Getting {current.name} ready for the books.</p>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        {STEPS.map((s, i) => (
          <div key={i} className={`flex items-center gap-1 text-xs px-2 py-1 rounded-full border ${i < step ? "bg-emerald-50 border-emerald-300 text-emerald-700" : i === step ? "bg-slate-900 text-white" : "bg-white text-slate-500"}`}>
            {i < step && <CheckCircle2 size={12} />} {i + 1}. {s}
          </div>
        ))}
      </div>

      <div className="rounded-xl border bg-white p-6">
        {step === 0 && (
          <div className="space-y-3">
            <h2 className="font-heading text-xl font-semibold">Tell us about {current.name}</h2>
            <div>
              <label className="text-xs uppercase text-slate-500">Business type</label>
              <input placeholder="e.g. Marketing agency, restaurant, SaaS company"
                     value={answers.business_type || current.business_type || ""}
                     onChange={(e) => setAns("business_type", e.target.value)}
                     className="w-full mt-1 border rounded px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs uppercase text-slate-500">What does the business do?</label>
              <textarea rows={3} value={answers.business_description || current.business_description || ""}
                        onChange={(e) => setAns("business_description", e.target.value)}
                        className="w-full mt-1 border rounded px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-xs uppercase text-slate-500">Reporting basis</label>
              <div className="mt-1 inline-flex rounded-md border">
                {["accrual", "cash"].map(b => (
                  <button key={b} onClick={() => setAns("basis", b)}
                          className={`px-3 py-1.5 text-sm ${(answers.basis || "accrual") === b ? "bg-slate-900 text-white" : ""}`}>
                    {b[0].toUpperCase() + b.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-3">
            <h2 className="font-heading text-xl font-semibold">Do you already use QuickBooks Online?</h2>
            <p className="text-sm text-slate-500">We can link via QBO API and pull your existing chart of accounts and transactions. (Mocked in this MVP.)</p>
            <div className="flex gap-2">
              <button onClick={() => { setAns("qbo", "yes"); toast.success("QBO mock-linked. Data will sync in background."); }}
                      className={`px-4 py-2 rounded-md border text-sm ${answers.qbo === "yes" ? "bg-slate-900 text-white" : ""}`}>
                Yes — link QuickBooks (mock)
              </button>
              <button onClick={() => setAns("qbo", "no")}
                      className={`px-4 py-2 rounded-md border text-sm ${answers.qbo === "no" ? "bg-slate-900 text-white" : ""}`}>
                No — set up fresh
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3">
            <h2 className="font-heading text-xl font-semibold">AI-generated Chart of Accounts</h2>
            <p className="text-sm text-slate-500">
              We seed a GAAP-compliant baseline. AI adds industry-specific accounts based on what your business does.
            </p>
            <button data-testid={TID.onboardingCoaGenerate} onClick={generateCoa} disabled={busy}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-slate-900 text-white text-sm">
              {busy && <Loader2 size={13} className="animate-spin" />} Generate industry accounts with AI
            </button>
            {suggestions.length > 0 && (
              <div className="mt-3 rounded-md border bg-slate-50 p-3">
                <div className="text-xs uppercase tracking-wide text-slate-500 mb-2">AI added</div>
                <div className="space-y-1">
                  {suggestions.map((s, i) => (
                    <div key={i} className="text-sm"><span className="font-mono-num text-slate-500">{s.code}</span> {s.name} <span className="text-xs text-slate-500">({s.type})</span></div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {step === 3 && (
          <div className="space-y-3">
            <h2 className="font-heading text-xl font-semibold">Connect your bank via Plaid</h2>
            <p className="text-sm text-slate-500">Select which accounts belong to this company. We log the balance with every transaction so we can auto-reconcile later.</p>
            {!plaidAccts.length ? (
              <button data-testid={TID.onboardingMockPlaid} onClick={mockPlaid} disabled={busy}
                      className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-slate-900 text-white text-sm">
                {busy && <Loader2 size={13} className="animate-spin" />} Launch Plaid Link (mock)
              </button>
            ) : (
              <div className="space-y-2">
                {plaidAccts.map(a => (
                  <label key={a.id} className="flex items-center gap-3 p-3 border rounded-md">
                    <input type="checkbox" checked={selectedPlaid.has(a.id)}
                           onChange={(e) => {
                             const s = new Set(selectedPlaid);
                             e.target.checked ? s.add(a.id) : s.delete(a.id);
                             setSelectedPlaid(s);
                           }} />
                    <div className="flex-1">
                      <div className="font-medium text-sm">{a.name}</div>
                      <div className="text-xs text-slate-500">{a.institution} · {a.subtype}</div>
                    </div>
                    <div className="font-mono-num text-sm">${a.balance.toLocaleString()}</div>
                  </label>
                ))}
                <button onClick={importPlaid} disabled={!selectedPlaid.size || busy}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-emerald-600 text-white text-sm disabled:opacity-50">
                  {busy && <Loader2 size={13} className="animate-spin" />} Import & AI-categorize selected
                </button>
                {imported.plaid > 0 && (
                  <div className="text-xs text-emerald-700">✓ Imported {imported.plaid} transactions. AI categorized each per GAAP.</div>
                )}
              </div>
            )}
          </div>
        )}

        {step === 4 && (
          <div className="space-y-3">
            <h2 className="font-heading text-xl font-semibold">Upload statements Plaid couldn't reach</h2>
            <p className="text-sm text-slate-500">Veryfi OCR pulls transactions off PDFs and images. AI categorizes the same way.</p>
            <button data-testid={TID.onboardingMockVeryfi} onClick={mockVeryfi} disabled={busy}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-slate-900 text-white text-sm">
              {busy && <Loader2 size={13} className="animate-spin" />} Simulate Veryfi upload
            </button>
            {imported.veryfi > 0 && (
              <div className="text-xs text-emerald-700">✓ Imported {imported.veryfi} lines from mock statement.</div>
            )}
          </div>
        )}

        {step === 5 && (
          <div className="space-y-3">
            <h2 className="font-heading text-xl font-semibold">You're set.</h2>
            <p className="text-sm text-slate-500">
              I've categorized every transaction I could. Anything I wasn't sure about is flagged for review.
              You can scroll through transactions and tell me which ones look right — or hover a row and tell me anything about it.
            </p>
            <button data-testid={TID.onboardingComplete} onClick={finish}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-emerald-600 text-white text-sm">
              Enter my books <ChevronRight size={14} />
            </button>
          </div>
        )}

        <div className="flex items-center justify-between mt-6 pt-4 border-t">
          <button data-testid={TID.onboardingBack} disabled={step === 0} onClick={back}
                  className="inline-flex items-center gap-1 text-sm text-slate-600 disabled:opacity-40">
            <ArrowLeft size={13} /> Back
          </button>
          {step < STEPS.length - 1 && (
            <button data-testid={TID.onboardingNext} onClick={next}
                    className="inline-flex items-center gap-1 px-4 py-1.5 rounded-md bg-slate-900 text-white text-sm">
              Next <ChevronRight size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
