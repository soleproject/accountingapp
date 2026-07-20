import { useState } from "react";

// Deterministic pastel colors for letter avatars — same contact always
// gets the same background across sessions.
const AVATAR_PALETTE = [
  "#e0e7ff-#3730a3", // indigo
  "#dcfce7-#166534", // green
  "#fef3c7-#92400e", // amber
  "#fce7f3-#9d174d", // pink
  "#cffafe-#155e75", // cyan
  "#f5d0fe-#701a75", // fuchsia
  "#fee2e2-#991b1b", // red
  "#e9d5ff-#6b21a8", // purple
];

function _hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// Small circular badge showing a merchant logo when available, falling
// back to a colored letter avatar deterministic on the contact name.
// Used to prefix the Contact cell on the Transactions table so a CPA can
// scan the ledger visually the way QuickBooks / Ramp / Xero do it.
export function ContactBadge({ contact, name, size = 20 }) {
  const displayName = (name || contact?.name || "").trim();
  const logoUrl = contact?.logo_url;
  const [broken, setBroken] = useState(false);
  const dim = { width: size, height: size };
  const letter = (displayName[0] || "?").toUpperCase();
  const [bg, fg] = (AVATAR_PALETTE[_hash(displayName) % AVATAR_PALETTE.length]).split("-");
  if (logoUrl && !broken) {
    return (
      <img
        src={logoUrl}
        alt=""
        onError={() => setBroken(true)}
        className="rounded-full object-contain bg-white ring-1 ring-slate-200 shrink-0"
        style={dim}
      />
    );
  }
  if (!displayName) {
    return (
      <div
        className="rounded-full bg-slate-200 text-slate-500 flex items-center justify-center shrink-0 text-[10px]"
        style={dim}
      >
        ?
      </div>
    );
  }
  return (
    <div
      className="rounded-full flex items-center justify-center shrink-0 font-semibold"
      style={{ ...dim, background: bg, color: fg, fontSize: Math.max(9, Math.floor(size / 2.2)) }}
    >
      {letter}
    </div>
  );
}
