"""Regression — QBO migration must auto-deactivate seeded accounts at
completion. Without this, freshly-migrated companies show dozens of
local-only seeded accounts in the Mirror dry-run wanting to be
pushed to QBO (creating duplicates)."""
from __future__ import annotations
import sys
import inspect

sys.path.insert(0, "/app/backend")


def test_run_migration_calls_cleanup_all_seeded():
    """`run_migration` must invoke `apply_cleanup_all_seeded` before
    marking the job done. This is the auto-adoption behaviour that
    prevents fresh QBO connects from surfacing 28+ seeded accounts
    as push_to_qbo drift."""
    import qbo_service
    src = inspect.getsource(qbo_service.run_migration)
    # Deactivation must happen inside the success branch (before
    # 'status': 'done').
    assert "apply_cleanup_all_seeded" in src, (
        "run_migration must call apply_cleanup_all_seeded at the tail "
        "so a fresh QBO connect ends with 0 seeded accounts pending "
        "push to QBO")
    # Must precede the status-done update so the count is included
    # in the job doc.
    idx_call = src.index("apply_cleanup_all_seeded")
    idx_done = src.index('"status": "done"')
    assert idx_call < idx_done, (
        "apply_cleanup_all_seeded must be called BEFORE flipping the "
        "job status to done, so seeded_deactivated is reported")


def test_seeded_deactivated_reported_in_job_doc():
    """The migration job doc must expose `seeded_deactivated` so the
    UI can show '28 seeded accounts deactivated' in the completion
    banner."""
    import qbo_service
    src = inspect.getsource(qbo_service.run_migration)
    assert '"seeded_deactivated"' in src, (
        "job status update must include a `seeded_deactivated` field")
