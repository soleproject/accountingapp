import TransactionEditor from "./TransactionEditor";

/** Full-page editor for vendor credits — reduces A/P without a cash
 * outflow. Applies against a specific vendor (optionally linked to
 * the bill being credited). Persists as `transactions` with
 * `txn_type="VendorCredit"` and mirrors to QBO's VendorCredit entity.
 *
 * AP-side counterpart to Credit Memo (which lives on the AR side).
 *
 * Route: /vendor-credits/new · /vendor-credits/:id/edit */
export default function VendorCreditEditor() {
  return <TransactionEditor entityType="VendorCredit" />;
}
