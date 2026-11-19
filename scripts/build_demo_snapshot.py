"""Generate a demo snapshot (data/nodes.json + data/edges.json).

The demo mirrors the structure of the real lineage graph (PostgreSQL bankdb ->
5 Fabric pipelines -> Ontology_Lineage lakehouse) so the app can run fully
offline with `MODE=snapshot`. Replace the files with the output of
`scripts/export_snapshot.py` to work on the real graph offline.

Usage:  python scripts/build_demo_snapshot.py [output_dir]
"""

from __future__ import annotations

import json
import sys
import zlib
from pathlib import Path

nodes: list[dict] = []
edges: list[dict] = []


def node(id_: str, label: str, name: str, **props) -> str:
    nodes.append({"id": id_, "label": label, "name": name, **props})
    return id_


def edge(src: str, rel: str, dst: str, **props) -> None:
    edges.append({"from": src, "rel": rel, "to": dst, **props})


# ---------------------------------------------------------------------------
# PostgreSQL source
# ---------------------------------------------------------------------------
PG = "PostgreSQL"
db = node("pg:bankdb", "Database", "bankdb", platform=PG, host="pg-bank.postgres.database.azure.com")
schema = node("pg:bankdb.banking", "Schema", "banking", platform=PG)
edge(db, "HAS_SCHEMA", schema)

# column spec: (name, data_type, is_pii, is_pk, comment)
PG_TABLES: dict[str, tuple[str, list[tuple]]] = {
    "customers": ("Retail and corporate customers", [
        ("customer_id", "integer", False, True, "Surrogate key"),
        ("first_name", "varchar(80)", True, False, "PII: given name"),
        ("last_name", "varchar(80)", True, False, "PII: family name"),
        ("email", "varchar(200)", True, False, "PII: contact e-mail"),
        ("phone", "varchar(30)", True, False, "PII: contact phone number"),
        ("national_id", "varchar(20)", True, False, "PII: government identifier"),
        ("date_of_birth", "date", True, False, "PII: date of birth"),
        ("address_line", "varchar(200)", True, False, "PII: street address"),
        ("city", "varchar(80)", False, False, None),
        ("country", "char(2)", False, False, "ISO country code"),
        ("segment", "varchar(20)", False, False, "RETAIL / SME / CORPORATE"),
        ("created_at", "timestamp", False, False, None),
    ]),
    "accounts": ("Deposit and current accounts", [
        ("account_id", "integer", False, True, None),
        ("customer_id", "integer", False, False, "FK to customers"),
        ("branch_id", "integer", False, False, "FK to branches"),
        ("account_type", "varchar(20)", False, False, "CURRENT / SAVINGS"),
        ("currency", "char(3)", False, False, None),
        ("balance", "numeric(18,2)", False, False, "Ledger balance"),
        ("status", "varchar(12)", False, False, None),
        ("opened_at", "timestamp", False, False, None),
    ]),
    "loans": ("Loan contracts", [
        ("loan_id", "integer", False, True, None),
        ("customer_id", "integer", False, False, "FK to customers"),
        ("account_id", "integer", False, False, "FK to accounts"),
        ("loan_type", "varchar(20)", False, False, "MORTGAGE / PERSONAL / AUTO"),
        ("principal_amount", "numeric(18,2)", False, False, "Original principal"),
        ("outstanding_amount", "numeric(18,2)", False, False, "Remaining balance"),
        ("interest_rate", "numeric(6,3)", False, False, None),
        ("loan_status", "varchar(12)", False, False, "ACTIVE / ARREARS / DEFAULTED / CLOSED"),
        ("start_date", "date", False, False, None),
        ("maturity_date", "date", False, False, None),
    ]),
    "transactions": ("Account transactions", [
        ("txn_id", "bigint", False, True, None),
        ("account_id", "integer", False, False, "FK to accounts"),
        ("txn_type", "varchar(12)", False, False, "DEBIT / CREDIT"),
        ("amount", "numeric(18,2)", False, False, None),
        ("currency", "char(3)", False, False, None),
        ("txn_ts", "timestamp", False, False, None),
        ("channel", "varchar(12)", False, False, "BRANCH / ONLINE / ATM"),
    ]),
    "branches": ("Bank branches", [
        ("branch_id", "integer", False, True, None),
        ("branch_name", "varchar(80)", False, False, None),
        ("city", "varchar(80)", False, False, None),
        ("region", "varchar(40)", False, False, None),
    ]),
}

PG_VIEWS = {
    "vw_customer_accounts": ("Customers with their accounts", ["customers", "accounts"], [
        ("customer_id", "integer", "customers.customer_id", "DIRECT", None),
        ("segment", "varchar(20)", "customers.segment", "DIRECT", None),
        ("account_id", "integer", "accounts.account_id", "DIRECT", None),
        ("account_type", "varchar(20)", "accounts.account_type", "DIRECT", None),
        ("balance", "numeric(18,2)", "accounts.balance", "DIRECT", None),
    ]),
    "vw_loan_summary": ("Outstanding loans by type", ["loans"], [
        ("loan_type", "varchar(20)", "loans.loan_type", "DIRECT", None),
        ("total_outstanding", "numeric", "loans.outstanding_amount", "AGGREGATED", "SUM(outstanding_amount)"),
        ("loan_count", "bigint", "loans.loan_id", "AGGREGATED", "COUNT(loan_id)"),
    ]),
}


def pg_table_id(t: str) -> str:
    return f"pg:bankdb.banking.{t}"


for tname, (comment, cols) in PG_TABLES.items():
    tid = node(pg_table_id(tname), "Table", tname, full_name=f"banking.{tname}", platform=PG, comment=comment)
    edge(schema, "HAS_TABLE", tid)
    for cname, dtype, pii, pk, ccomment in cols:
        cid = node(f"{tid}.{cname}", "Column", cname, table=f"banking.{tname}", data_type=dtype,
                   is_pii=pii, is_pk=pk, comment=ccomment, platform=PG)
        edge(tid, "HAS_COLUMN", cid)
        if pii:
            edge(cid, "CLASSIFIED_AS", "classification:PII")

for vname, (comment, sources, cols) in PG_VIEWS.items():
    vid = node(pg_table_id(vname), "View", vname, full_name=f"banking.{vname}", platform=PG, comment=comment)
    edge(schema, "HAS_TABLE", vid)
    for s in sources:
        edge(pg_table_id(s), "FEEDS", vid)
    for cname, dtype, src, tr, expr in cols:
        cid = node(f"{vid}.{cname}", "Column", cname, table=f"banking.{vname}", data_type=dtype,
                   is_pii=False, is_pk=False, comment=None, platform=PG)
        edge(vid, "HAS_COLUMN", cid)
        edge(f"pg:bankdb.banking.{src}", "FLOWS_TO", cid, transformation=tr,
             expression=expr or src.split(".")[1], via="view", pipeline=None, activity=None)

FKS = [
    ("accounts.customer_id", "customers.customer_id", "fk_accounts_customer"),
    ("accounts.branch_id", "branches.branch_id", "fk_accounts_branch"),
    ("loans.customer_id", "customers.customer_id", "fk_loans_customer"),
    ("loans.account_id", "accounts.account_id", "fk_loans_account"),
    ("transactions.account_id", "accounts.account_id", "fk_transactions_account"),
]
for a, b, fk in FKS:
    edge(f"pg:bankdb.banking.{a}", "REFERENCES", f"pg:bankdb.banking.{b}", fk_name=fk)

# ---------------------------------------------------------------------------
# Fabric lakehouse
# ---------------------------------------------------------------------------
FAB = "Fabric Lakehouse"
LH = node("fabric:Ontology_Lineage", "Lakehouse", "Ontology_Lineage", platform="Fabric",
          item_id="7d1c2f0e-4b8a-4c51-9f3e-2a6b5d8c1e90")
for s in ("dim", "fact"):
    node(f"{LH}.{s}", "Schema", s, platform=FAB)
    edge(LH, "HAS_SCHEMA", f"{LH}.{s}")

# target table -> (comment, [(column, data_type, source "table.col" | [sources], transformation, expression)])
FABRIC_TABLES: dict[str, tuple[str, list[tuple]]] = {
    "dim.customer": ("Customer dimension (PII masked)", [
        ("customer_id", "int", "customers.customer_id", "DIRECT", "customer_id"),
        ("last_name_masked", "string", "customers.last_name", "MASKED", "LEFT(last_name, 1) || '***'"),
        ("email_masked", "string", "customers.email", "MASKED", "REGEXP_REPLACE(email, '(^.).*(@.*$)', '\\1***\\2')"),
        ("phone_masked", "string", "customers.phone", "MASKED", "'*******' || RIGHT(phone, 3)"),
        ("national_id_masked", "string", "customers.national_id", "MASKED", "SHA256(national_id)"),
        ("birth_year", "int", "customers.date_of_birth", "MASKED", "EXTRACT(YEAR FROM date_of_birth)"),
        ("city", "string", "customers.city", "DIRECT", "city"),
        ("country", "string", "customers.country", "DIRECT", "country"),
        ("segment", "string", "customers.segment", "DIRECT", "segment"),
        ("customer_since", "date", "customers.created_at", "CAST", "CAST(created_at AS date)"),
    ]),
    "dim.account": ("Account dimension", [
        ("account_id", "int", "accounts.account_id", "DIRECT", "account_id"),
        ("customer_id", "int", "accounts.customer_id", "DIRECT", "customer_id"),
        ("account_type", "string", "accounts.account_type", "DIRECT", "account_type"),
        ("currency", "string", "accounts.currency", "DIRECT", "currency"),
        ("balance", "decimal(18,2)", "accounts.balance", "CAST", "CAST(balance AS decimal(18,2))"),
        ("status", "string", "accounts.status", "DIRECT", "status"),
        ("opened_date", "date", "accounts.opened_at", "CAST", "CAST(opened_at AS date)"),
        ("branch_name", "string", "branches.branch_name", "DIRECT", "b.branch_name"),
        ("branch_region", "string", "branches.region", "DIRECT", "b.region"),
    ]),
    "fact.loan_portfolio": ("Loan portfolio with risk classification", [
        ("loan_id", "int", "loans.loan_id", "DIRECT", "loan_id"),
        ("customer_id", "int", "loans.customer_id", "DIRECT", "customer_id"),
        ("account_id", "int", "loans.account_id", "DIRECT", "account_id"),
        ("loan_type", "string", "loans.loan_type", "DIRECT", "loan_type"),
        ("principal_amount", "decimal(18,2)", "loans.principal_amount", "CAST", "CAST(principal_amount AS decimal(18,2))"),
        ("outstanding_amount", "decimal(18,2)", "loans.outstanding_amount", "CAST", "CAST(outstanding_amount AS decimal(18,2))"),
        ("interest_rate", "decimal(6,3)", "loans.interest_rate", "CAST", "CAST(interest_rate AS decimal(6,3))"),
        ("loan_status", "string", "loans.loan_status", "DIRECT", "loan_status"),
        ("risk_bucket", "string", ["loans.loan_status", "loans.outstanding_amount", "loans.principal_amount"], "DERIVED",
         "CASE WHEN loan_status = 'DEFAULTED' THEN 'HIGH' "
         "WHEN outstanding_amount / NULLIF(principal_amount, 0) > 0.8 THEN 'MEDIUM' ELSE 'LOW' END"),
        ("repayment_ratio", "decimal(9,4)", ["loans.outstanding_amount", "loans.principal_amount"], "DERIVED",
         "1 - outstanding_amount / NULLIF(principal_amount, 0)"),
        ("term_months", "int", ["loans.start_date", "loans.maturity_date"], "DERIVED",
         "DATEDIFF(month, start_date, maturity_date)"),
    ]),
    "fact.transactions_daily": ("Daily transaction totals per account", [
        ("account_id", "int", "transactions.account_id", "DIRECT", "account_id"),
        ("txn_date", "date", "transactions.txn_ts", "DERIVED", "CAST(txn_ts AS date)"),
        ("txn_type", "string", "transactions.txn_type", "DIRECT", "txn_type"),
        ("channel", "string", "transactions.channel", "DIRECT", "channel"),
        ("total_amount", "decimal(18,2)", "transactions.amount", "AGGREGATED", "SUM(amount)"),
        ("txn_count", "bigint", "transactions.txn_id", "AGGREGATED", "COUNT(txn_id)"),
    ]),
    "fact.customer_360": ("One row per customer with balances and loan exposure", [
        ("customer_id", "int", "dim.customer.customer_id", "DIRECT", "c.customer_id"),
        ("segment", "string", "dim.customer.segment", "DIRECT", "c.segment"),
        ("email_masked", "string", "dim.customer.email_masked", "DIRECT", "c.email_masked"),
        ("account_count", "bigint", "dim.account.account_id", "AGGREGATED", "COUNT(DISTINCT a.account_id)"),
        ("total_balance", "decimal(18,2)", "dim.account.balance", "AGGREGATED", "SUM(a.balance)"),
        ("active_loans", "bigint", "fact.loan_portfolio.loan_id", "AGGREGATED", "COUNT(l.loan_id)"),
        ("total_outstanding", "decimal(18,2)", "fact.loan_portfolio.outstanding_amount", "AGGREGATED",
         "SUM(l.outstanding_amount)"),
        ("high_risk_loans", "bigint", "fact.loan_portfolio.risk_bucket", "AGGREGATED",
         "SUM(CASE WHEN l.risk_bucket = 'HIGH' THEN 1 ELSE 0 END)"),
    ]),
}

PIPELINES = {
    "PL_CP_Customer_Dim": ("dim.customer", ["banking.customers"]),
    "PL_CP_Account_Dim": ("dim.account", ["banking.accounts", "banking.branches"]),
    "PL_CP_Loan_Portfolio": ("fact.loan_portfolio", ["banking.loans"]),
    "PL_CP_Transactions_Daily": ("fact.transactions_daily", ["banking.transactions"]),
    "PL_CP_Customer_360": ("fact.customer_360", ["dim.customer", "dim.account", "fact.loan_portfolio"]),
}
PIPELINE_OF_TARGET = {tgt: pl for pl, (tgt, _) in PIPELINES.items()}
FABRIC_PKS = {
    ("dim.customer", "customer_id"),
    ("dim.account", "account_id"),
    ("fact.loan_portfolio", "loan_id"),
    ("fact.customer_360", "customer_id"),
}


def table_id(full: str) -> str:
    if full.startswith("banking."):
        return pg_table_id(full.split(".", 1)[1])
    return f"{LH}.{full}"


def column_id(ref: str) -> str:
    """'customers.email' -> pg column id; 'dim.customer.email_masked' -> fabric column id."""
    parts = ref.split(".")
    if len(parts) == 2:
        return f"pg:bankdb.banking.{ref}"
    return f"{LH}.{ref}"


for full, (comment, cols) in FABRIC_TABLES.items():
    tid = node(table_id(full), "Table", full.split(".")[1], full_name=full, platform=FAB, comment=comment)
    edge(f"{LH}.{full.split('.')[0]}", "HAS_TABLE", tid)
    pipeline = PIPELINE_OF_TARGET[full]
    for cname, dtype, srcs, tr, expr in cols:
        cid = node(f"{tid}.{cname}", "Column", cname, table=full, data_type=dtype, is_pii=False,
                   is_pk=(full, cname) in FABRIC_PKS, comment=None, platform=FAB)
        edge(tid, "HAS_COLUMN", cid)
        if tr == "MASKED":
            edge(cid, "CLASSIFIED_AS", "classification:PII_MASKED")
        for src in [srcs] if isinstance(srcs, str) else srcs:
            edge(column_id(src), "FLOWS_TO", cid, transformation=tr, expression=expr,
                 pipeline=pipeline, activity="Copy data1", via="pipeline")

# Pipelines and activities
for pl, (target, sources) in PIPELINES.items():
    pid = node(f"fabric:pipeline:{pl}", "Pipeline", pl, platform="Fabric Data Factory",
               item_id=f"pl-{zlib.crc32(pl.encode()):08x}")
    copy = node(f"{pid}.Copy data1", "Activity", "Copy data1", pipeline=pl, activity_type="Copy",
                query=f"SELECT * FROM {sources[0]}" if sources[0].startswith("banking.") else None,
                pre_copy_script=f"DELETE FROM {target}")
    edge(pid, "CONTAINS", copy)
    for s in sources:
        edge(copy, "READS_FROM", table_id(s))
    edge(copy, "WRITES_TO", table_id(target))

# richer control flow
lookup = node("fabric:pipeline:PL_CP_Loan_Portfolio.Lookup watermark", "Activity", "Lookup watermark",
              pipeline="PL_CP_Loan_Portfolio", activity_type="Lookup",
              query="SELECT MAX(start_date) AS watermark FROM banking.loans", pre_copy_script=None)
edge("fabric:pipeline:PL_CP_Loan_Portfolio", "CONTAINS", lookup)
edge(lookup, "READS_FROM", table_id("banking.loans"))
edge(lookup, "PRECEDES", "fabric:pipeline:PL_CP_Loan_Portfolio.Copy data1")

invoke = node("fabric:pipeline:PL_CP_Customer_360.Invoke dimensions", "Activity", "Invoke dimensions",
              pipeline="PL_CP_Customer_360", activity_type="ExecutePipeline", query=None, pre_copy_script=None)
edge("fabric:pipeline:PL_CP_Customer_360", "CONTAINS", invoke)
edge(invoke, "INVOKES", "fabric:pipeline:PL_CP_Customer_Dim")
edge(invoke, "INVOKES", "fabric:pipeline:PL_CP_Account_Dim")
edge(invoke, "PRECEDES", "fabric:pipeline:PL_CP_Customer_360.Copy data1")

# ---------------------------------------------------------------------------
# Business ontology and classifications
# ---------------------------------------------------------------------------
node("classification:PII", "Classification", "PII", description="Personally identifiable information")
node("classification:PII_MASKED", "Classification", "PII_MASKED",
     description="Derived from PII through masking, hashing or generalisation")

CONCEPTS = {
    "Customer": "A person or organisation that holds products with the bank",
    "Account": "A deposit or current account held by a customer",
    "Loan": "A credit facility granted to a customer",
    "Transaction": "A debit or credit movement on an account",
    "Branch": "A physical branch that services accounts",
    "CreditRisk": "Risk classification of the loan book",
}
for c, d in CONCEPTS.items():
    node(f"concept:{c}", "BusinessConcept", c, description=d)

for a, b, via in [
    ("Customer", "Account", "accounts.customer_id"),
    ("Customer", "Loan", "loans.customer_id"),
    ("Account", "Transaction", "transactions.account_id"),
    ("Account", "Branch", "accounts.branch_id"),
    ("Loan", "Account", "loans.account_id"),
    ("Loan", "CreditRisk", "loan_portfolio.risk_bucket"),
]:
    edge(f"concept:{a}", "RELATED_TO", f"concept:{b}", via=via)

for t, c in [
    ("banking.customers", "Customer"), ("dim.customer", "Customer"), ("fact.customer_360", "Customer"),
    ("banking.accounts", "Account"), ("dim.account", "Account"), ("banking.vw_customer_accounts", "Account"),
    ("banking.loans", "Loan"), ("fact.loan_portfolio", "Loan"), ("banking.vw_loan_summary", "Loan"),
    ("banking.transactions", "Transaction"), ("fact.transactions_daily", "Transaction"),
    ("banking.branches", "Branch"), ("fact.loan_portfolio", "CreditRisk"),
]:
    edge(table_id(t), "REPRESENTS", f"concept:{c}")


def main() -> None:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "data"
    out.mkdir(parents=True, exist_ok=True)
    ids = {n["id"] for n in nodes}
    missing = [e for e in edges if e["from"] not in ids or e["to"] not in ids]
    if missing:
        raise SystemExit(f"Dangling edges: {missing[:3]}")
    (out / "nodes.json").write_text(json.dumps(nodes, indent=1), encoding="utf-8")
    (out / "edges.json").write_text(json.dumps(edges, indent=1), encoding="utf-8")
    print(f"Wrote {len(nodes)} nodes and {len(edges)} edges to {out}")


if __name__ == "__main__":
    main()
