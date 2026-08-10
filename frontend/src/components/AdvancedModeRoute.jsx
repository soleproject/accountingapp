import { Navigate } from "react-router-dom";
import { useCompany } from "@/lib/company";

/**
 * Route guard for Advanced-mode-only pages. When a company is in
 * "simple" accounting mode, backdoor URL navigation to editor pages
 * (`/purchases/new`, `/sales-receipts`, `/credit-memos`, etc.) is
 * silently redirected to `/accounting/transactions` — the primary
 * ledger everyone can use. Keeps the promise "regular users never
 * have to deal with QBO-shaped entities."
 *
 * Loading state: if the company context hasn't hydrated yet, render
 * children optimistically to avoid a flash-of-redirect for the
 * default case (advanced mode). Backend endpoints still enforce
 * permissions, so a fleeting render is harmless.
 */
export default function AdvancedModeRoute({ children }) {
  const { isAdvancedMode, loading, currentId } = useCompany();
  if (loading || !currentId) return children;
  if (!isAdvancedMode) return <Navigate to="/accounting/transactions" replace />;
  return children;
}
