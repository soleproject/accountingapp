import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { QRCodeSVG } from "qrcode.react";
import { Share2, Copy, Check, Users, DollarSign, Loader2 } from "lucide-react";

/**
 * Affiliate share page — every user has a stable referral slug and can
 * copy their link, download a QR, and see how many signups + paying
 * referrals they've driven. Slug is minted on first visit.
 *
 * Earnings numbers are 0 until the Stripe webhook + revenue-share ledger
 * ship (next session); the empty state renders the same shape so no UI
 * work is needed when the numbers start flowing.
 */
export default function Share() {
  const [data, setData] = useState(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    api.get("/share").then(r => setData(r.data)).catch(() => setData({}));
  }, []);

  const copy = async () => {
    if (!data?.link) return;
    await navigator.clipboard.writeText(data.link);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const downloadQR = () => {
    const svg = document.querySelector('[data-testid="share-qr-svg"]');
    if (!svg) return;
    const src = new XMLSerializer().serializeToString(svg);
    const blob = new Blob([src], { type: "image/svg+xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `smartbooks-referral-${data.slug}.svg`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  if (!data) return (
    <div className="p-10 text-center text-slate-400 text-sm">
      <Loader2 size={16} className="inline animate-spin mr-2" /> Loading…
    </div>
  );

  return (
    <div className="p-6 max-w-4xl mx-auto" data-testid="share-page">
      <div className="flex items-center gap-2 text-slate-500 text-sm mb-1">
        <Share2 size={14} /> Affiliate
      </div>
      <h1 className="text-2xl font-heading font-bold text-slate-900">
        Refer &amp; earn
      </h1>
      <p className="text-sm text-slate-500 mt-1 mb-6">
        Share your link. When someone signs up and pays, you get credited automatically.
      </p>

      <div className="grid md:grid-cols-2 gap-4 mb-6">
        <StatCard icon={Users} label="Signups" value={data.referred_count ?? 0} accent="cyan" />
        <StatCard icon={Users} label="Paying" value={data.paying_count ?? 0} accent="emerald" />
        <StatCard
          icon={DollarSign} label="Earned"
          value={`$${((data.earnings_cents || 0) / 100).toFixed(2)}`} accent="emerald"
        />
        <StatCard
          icon={DollarSign} label="Pending payout"
          value={`$${((data.pending_cents || 0) / 100).toFixed(2)}`} accent="amber"
        />
      </div>

      <div className="bg-white rounded-lg border border-slate-200 p-6">
        <div className="text-xs uppercase tracking-wide text-slate-500 mb-2">Your referral link</div>
        <div className="flex items-center gap-2 flex-wrap">
          <input
            readOnly
            value={data.link || ""}
            onFocus={e => e.target.select()}
            className="flex-1 min-w-[260px] border border-slate-200 rounded-md px-3 py-2 text-sm font-mono bg-slate-50"
            data-testid="share-link-input"
          />
          <button
            onClick={copy}
            className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-slate-900 text-white text-sm hover:bg-slate-800"
            data-testid="share-copy-btn"
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
            {copied ? "Copied" : "Copy"}
          </button>
        </div>

        <div className="mt-6 grid md:grid-cols-[220px_1fr] gap-6 items-start">
          <div className="p-4 rounded-lg bg-white border border-slate-200 flex flex-col items-center">
            <QRCodeSVG
              value={data.link || ""}
              size={180}
              level="M"
              includeMargin
              data-testid="share-qr-svg"
            />
            <button
              onClick={downloadQR}
              className="mt-3 text-xs text-cyan-700 hover:underline"
              data-testid="share-qr-download"
            >
              Download SVG
            </button>
          </div>
          <div className="text-sm text-slate-600 space-y-2 leading-relaxed">
            <p><b>How it works</b></p>
            <ul className="list-disc pl-5 space-y-1">
              <li>Share your link or QR code. Signups that come through it are permanently credited to you.</li>
              <li>When a referral becomes a paying subscriber, you earn a percentage of their subscription for as long as they pay (rate set by admin).</li>
              <li>Payouts appear in <span className="font-medium">Earned</span> once the billing period closes.</li>
            </ul>
            <p className="text-xs text-slate-500 pt-2">
              Your affiliate slug: <span className="font-mono font-medium">{data.slug}</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, accent }) {
  const tone = {
    cyan: "text-cyan-700 bg-cyan-50 border-cyan-100",
    emerald: "text-emerald-700 bg-emerald-50 border-emerald-100",
    amber: "text-amber-700 bg-amber-50 border-amber-100",
  }[accent] || "text-slate-700 bg-slate-50 border-slate-100";
  return (
    <div className="bg-white rounded-lg border border-slate-200 p-4">
      <div className="flex items-center gap-2">
        <div className={`w-8 h-8 rounded-md flex items-center justify-center border ${tone}`}>
          <Icon size={14} />
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-slate-500">{label}</div>
          <div className="text-xl font-heading font-bold text-slate-900 tabular-nums">{value}</div>
        </div>
      </div>
    </div>
  );
}
