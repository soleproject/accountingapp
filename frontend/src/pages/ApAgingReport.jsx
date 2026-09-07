import { AgingReport } from "./ArAgingReport";

// Reuses the shared AgingReport shell in kind="ap" mode. Renders
// "A/P Aging (Bills to Pay)" with the same 5-bucket summary + detail
// table, grouped by vendor.
export default function ApAgingReport() {
  return <AgingReport kind="ap" />;
}
