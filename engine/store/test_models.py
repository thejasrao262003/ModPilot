"""Schema sanity tests — invariants we want CI to enforce.

These don't need a live database; they walk the SQLAlchemy metadata.
"""

from sqlalchemy import Table, UniqueConstraint

from store.models import Base


def _unique_column_tuples(table: Table) -> set[tuple[str, ...]]:
    """Return every (col, col, ...) tuple covered by a UniqueConstraint or unique Index."""
    pairs: set[tuple[str, ...]] = set()
    for constraint in table.constraints:
        if isinstance(constraint, UniqueConstraint):
            pairs.add(tuple(c.name for c in constraint.columns))
    for idx in table.indexes:
        if idx.unique:
            pairs.add(tuple(c.name for c in idx.columns))
    return pairs

# Tables E-2.1 must create. If you add a new persisted table, append it here
# AND make sure it carries subreddit_id per invariant I-7.
EXPECTED_TABLES = frozenset(
    {
        "subreddit_profile",
        "user_memory",
        "investigation",
        "evidence",
        "feedback",
        "audit_log",
    }
)


def test_all_required_tables_declared() -> None:
    declared = set(Base.metadata.tables.keys())
    missing = EXPECTED_TABLES - declared
    assert not missing, f"missing tables: {sorted(missing)}"


def test_every_table_has_subreddit_id() -> None:
    """Invariant I-7: every persisted row is subreddit_id-scoped."""
    offenders = []
    for name, table in Base.metadata.tables.items():
        if "subreddit_id" not in table.columns:
            offenders.append(name)
    assert not offenders, f"tables missing subreddit_id: {offenders}"


def test_investigation_correlation_id_unique() -> None:
    table = Base.metadata.tables["investigation"]
    assert ("correlation_id",) in _unique_column_tuples(table)


def test_user_memory_uniqueness() -> None:
    """Per-(subreddit, user) memory is one row, not many."""
    table = Base.metadata.tables["user_memory"]
    assert ("subreddit_id", "user_id") in _unique_column_tuples(table)


def test_evidence_id_unique_per_investigation() -> None:
    """`ev-N` ids must be unique within an investigation."""
    table = Base.metadata.tables["evidence"]
    assert ("investigation_id", "evidence_id") in _unique_column_tuples(table)
