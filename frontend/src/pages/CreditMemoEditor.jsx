import TransactionEditor from "./TransactionEditor";

/** Full-page editor for credit memos — reduces A/R without a cash
 * refund. Applies against a specific customer (optionally linked to
 * the invoice being credited). Persists as `transactions` with
 * `txn_type="CreditMemo"` and mirrors to QBO's CreditMemo entity.
 *
 * Route: /credit-memos/new · /credit-memos/:id/edit */
export default function CreditMemoEditor() {
  return <TransactionEditor entityType="CreditMemo" />;
}
