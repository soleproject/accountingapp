import TransactionEditor from "./TransactionEditor";

/** Full-page editor for bank deposits — inflows without a linked
 * customer (interest, rebates, loan proceeds, owner contributions).
 * Persists as `transactions` with `txn_type="Deposit"` and mirrors
 * to QBO's Deposit entity.
 *
 * Route: /deposits/new · /deposits/:id/edit */
export default function DepositEditor() {
  return <TransactionEditor entityType="Deposit" />;
}
