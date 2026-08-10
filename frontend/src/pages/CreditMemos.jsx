import TxnTypeListPage from "./TxnTypeListPage";

/** Credit Memos — reduce A/R without a cash refund. CPAs use the
 * list to see outstanding customer credit balances and apply them
 * against open invoices. Stored in `transactions` with
 * `txn_type=CreditMemo` and mirrored to QBO's CreditMemo entity.
 *
 * Route: /credit-memos */
export default function CreditMemos() {
  return (
    <TxnTypeListPage
      entityType="CreditMemo"
      title="Credit Memos"
      subtitle="Reduce a customer's A/R without moving cash — for returns, adjustments, and promised credits. Apply to any open invoice."
      newButtonLabel="New Credit Memo"
      newRoute="/credit-memos/new"
      editRoutePrefix="/credit-memos"
      testIdPrefix="credit-memos"
      showLinkedInvoice={true}
      emptyHint="No credit memos yet. Issue one when a customer returns an item or you need to reduce their balance."
    />
  );
}
