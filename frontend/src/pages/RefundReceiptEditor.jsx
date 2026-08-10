import TransactionEditor from "./TransactionEditor";

/** Full-page editor for refund receipts — cash refund back to the
 * customer for a prior sale. Different from a Credit Memo because
 * money actually leaves the bank. Persists as `transactions` with
 * `txn_type="RefundReceipt"` and mirrors to QBO's RefundReceipt entity.
 *
 * Route: /refund-receipts/new · /refund-receipts/:id/edit */
export default function RefundReceiptEditor() {
  return <TransactionEditor entityType="RefundReceipt" />;
}
