/**
 * Shared derivation for "Human Assistant Can Help" items.
 *
 * Consumed by the compact panel on `/cockpit/today-v7` (max 3 cards,
 * carousel-paged when there are more) and the full-list page at
 * `/cockpit/assistant`. Same rules; identical shape.
 *
 * Input: raw payload from GET /api/cockpit/today-v4.
 * Output: an array of { id, company, headline, steps[], suggested, route }.
 */
export function deriveAssistantItems(data) {
  if (!data || data.empty) return [];
  const items = [];

  // Silent-client escalations from the "conversations" section.
  const waiting = (data.conversations && data.conversations.waiting) || [];
  waiting.filter(w => w.days_silent >= 3).forEach(w => {
    const attempts = w.days_silent >= 5 ? 3 : w.days_silent >= 4 ? 2 : 1;
    const steps = ["Sent initial check-in"];
    if (attempts >= 2) steps.push("Sent automated reminder");
    if (attempts >= 3) steps.push("Sent second follow-up");
    items.push({
      id: `wait-${w.id}`,
      company_id: w.company_id,
      company: w.company,
      headline: `Client has missed ${attempts} AI check-in${attempts === 1 ? "" : "s"}.`,
      steps,
      suggested: attempts >= 3
        ? "Personal call or email may help re-engage client."
        : "A warm ping may help before the next AI reminder.",
      route: w.route,
    });
  });

  // Aging-outreach optional items — anything that reads like vendor
  // follow-up gets promoted from "optional" to an assistant task.
  const optional = (data.judgment && data.judgment.optional) || [];
  optional.forEach(o => {
    if ((o.id || "").startsWith("aging-outreach") || (o.text || "").toLowerCase().includes("vendor")) {
      items.push({
        id: o.id,
        company_id: null,
        company: "Vendor outreach aging",
        headline: o.text,
        steps: ["Sent initial vendor outreach", "Sent weekly follow-ups"],
        suggested: "A quick call to the vendor is likely faster than another email.",
        route: o.route,
      });
    }
  });

  // Relationship items — clients who have ghosted across enough
  // batches that the AI is now diminishing-returns territory.
  const relationship = (data.judgment && data.judgment.relationship) || [];
  relationship.forEach(r => {
    const [company] = (r.text || "Client").split(" has ");
    items.push({
      id: r.id,
      company_id: r.company_id,
      company,
      headline: r.text,
      steps: ["Sent check-ins across two batches", "Waited beyond the reminder cadence"],
      suggested: "Personal outreach — a call or short email — will feel human.",
      route: r.route,
    });
  });

  return items;
}
