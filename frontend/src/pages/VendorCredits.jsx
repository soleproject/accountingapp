import TxnTypeListPage from "./TxnTypeListPage";

/** Vendor Credits — the AP-side symmetric counterpart to Credit
 * Memos. A vendor credit reduces A/P and reverses expense/COGS.
 * Stored in `transactions` with `txn_type='VendorCredit'` and
 * mirrored to QBO's VendorCredit entity (see `qbo_service._PIPELINE`).
 *
 * Route: /vendor-credits */
export default function VendorCredits() {
  return (
    <TxnTypeListPage
      entityType="VendorCredit"
      title="Vendor Credits"
      subtitle="Credits vendors issued against amounts you owe them — reduce A/P, reverse expense. The AP-side counterpart to Credit Memos."
      newButtonLabel="New Vendor Credit"
      newRoute="/vendor-credits/new"
      editRoutePrefix="/vendor-credits"
      testIdPrefix="vendor-credits"
      contactLabel="Vendor"
      showLinkedBill={true}
      emptyHint="No vendor credits yet. Issue one when a vendor refunds an expense or you need to reduce their A/P balance."
    />
  );
}
