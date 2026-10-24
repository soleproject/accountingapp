export const input = "w-full h-10 rounded border border-slate-300 px-3 text-[15px] text-slate-700 outline-none focus:border-[#1E88E5] placeholder:text-slate-400";

export const Row = ({ label, required, hint, help, labelWidth = "230px", children }) => (
  <div className="grid items-start gap-4 py-2.5" style={{ gridTemplateColumns: `${labelWidth} 1fr` }}>
    <div className="text-[13px] font-semibold uppercase tracking-wide text-slate-800 pt-2.5 flex items-center gap-1">
      {help && <span className="text-slate-400">?</span>}{label}{required && <span className="text-red-500">*</span>}
    </div>
    <div>{children}{hint && <p className="mt-1.5 text-xs text-slate-500">{hint}</p>}</div>
  </div>
);

export const Toggle = ({ value, onChange, testId }) => (
  <button type="button" onClick={() => onChange(!value)} data-testid={testId}
          className={`h-8 min-w-[56px] rounded px-2.5 text-sm font-semibold flex items-center ${value ? "bg-[#1E88E5] text-white justify-start" : "bg-slate-200 text-slate-700 justify-end"}`}>
    {value ? "Yes" : "No"}
  </button>
);

export const Section = ({ title, children, testId }) => (
  <section className="rounded border border-slate-200 bg-white px-8 py-6" data-testid={testId}>
    {title && <h2 className="text-lg font-bold uppercase tracking-wide text-slate-800 mb-3">{title}</h2>}
    {children}
  </section>
);

export const GreenButton = ({ children, onClick, testId, className = "" }) => (
  <button type="button" onClick={onClick} data-testid={testId}
          className={`inline-flex items-center gap-1.5 rounded-full bg-[#43A047] px-4 py-1.5 text-sm font-semibold text-white hover:bg-[#388E3C] ${className}`}>
    {children}
  </button>
);
