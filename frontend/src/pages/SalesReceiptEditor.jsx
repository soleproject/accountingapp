import TransactionEditor from "./TransactionEditor";

/** Full-page editor for cash sales — customer paid at time of sale,
 * no A/R involvement. Persists as `transactions` with
 * `txn_type="SalesReceipt"` and mirrors to QBO's SalesReceipt entity.
 *
 * Route: /sales-receipts/new · /sales-receipts/:id/edit */
export default function SalesReceiptEditor() {
  return <TransactionEditor entityType="SalesReceipt" />;
}
