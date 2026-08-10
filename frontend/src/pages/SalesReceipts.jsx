import TxnTypeListPage from "./TxnTypeListPage";

/** Cash sales — customer paid at time of sale, no A/R involvement.
 * Stored in `transactions` with `txn_type=SalesReceipt` and mirrored
 * to QBO's SalesReceipt entity.
 *
 * Route: /sales-receipts */
export default function SalesReceipts() {
  return (
    <TxnTypeListPage
      entityType="SalesReceipt"
      title="Sales Receipts"
      subtitle="Customer paid at time of sale — no invoice needed. Perfect for retail, cash sales, and one-off transactions."
      newButtonLabel="New Sales Receipt"
      newRoute="/sales-receipts/new"
      editRoutePrefix="/sales-receipts"
      testIdPrefix="sales-receipts"
      showLinkedInvoice={false}
      emptyHint="No sales receipts yet. Create your first one to record a cash sale."
    />
  );
}
