import TransactionEditor from "./TransactionEditor";

/** Full-page editor for cash outflows to vendors — QBO's "Expense"
 * screen. Persists as `transactions` with `txn_type="Purchase"` and
 * auto-pushes to QBO via the editor branch in `_maybe_autopush_purchase`.
 *
 * Route: /purchases/new · /purchases/:id/edit */
export default function PurchaseEditor() {
  return <TransactionEditor entityType="Purchase" />;
}
