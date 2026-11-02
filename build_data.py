#!/usr/bin/env python3
"""Convert the G6 availability CSV into data.js for the static web UI."""

from __future__ import annotations

import argparse
import csv
import json
import re
from collections import Counter
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def collection_of(call: str) -> str:
    c = (call or "").strip().upper()
    if c.startswith("TEEN"):
        return "Teen"
    if c.startswith("J"):
        return "Juvenile"
    if c.startswith("GN"):
        return "Graphic novels"
    if c.startswith("RO "):
        return "Romance"
    if c.startswith("SPANISH"):
        return "Spanish"
    if c.startswith("CHINESE"):
        return "Chinese"
    if c.startswith("F "):
        return "Fiction"
    if c[:1].isdigit():
        return "Nonfiction"
    if c.startswith("B "):
        return "Biography"
    return "Other"


def norm_call(value: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", (value or "").upper())


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "csv",
        nargs="?",
        default=str(ROOT / "sfpl_g6_available.csv"),
        help="input CSV (default: sfpl_g6_available.csv next to this script)",
    )
    parser.add_argument(
        "out",
        nargs="?",
        default=str(ROOT / "data.js"),
        help="output JavaScript file (default: data.js next to this script)",
    )
    args = parser.parse_args()

    rows = []
    with open(args.csv, newline="", encoding="utf-8-sig") as fh:
        for row in csv.DictReader(fh):
            rows.append(
                {
                    "title": row.get("title", "").strip(),
                    "author": row.get("author", "").strip(),
                    "call": row.get("call_number", "").strip(),
                    "catalogCall": row.get("catalog_call_number", "").strip(),
                    "format": row.get("format", "").strip(),
                    "copies": int(row.get("copies_listed_at_branch") or 0),
                    "year": row.get("year", "").strip(),
                    "source": row.get("metadata_source", "").strip(),
                }
            )

    counts = Counter(collection_of(r["call"]) for r in rows)
    meta = {
        "branch": "Golden Gate Valley",
        "branchCode": "G6",
        "generated": date.today().isoformat(),
        "total": len(rows),
        "uniqueCalls": len({norm_call(r["call"]) for r in rows}),
        "withAuthor": sum(bool(r["author"]) for r in rows),
        "collections": dict(sorted(counts.items())),
        "availabilityNote": (
            "Each row is a title with at least one copy available at the branch. "
            "The copies number counts all copy rows shown for that title, including "
            "copies that may be checked out."
        ),
    }

    payload = "window.G6_META = %s;\nwindow.G6_BOOKS = %s;\n" % (
        json.dumps(meta, ensure_ascii=False, indent=2),
        json.dumps(rows, ensure_ascii=False, separators=(",", ":")),
    )
    Path(args.out).write_text(payload, encoding="utf-8")
    print(f"wrote {args.out}: {len(rows)} rows, {Path(args.out).stat().st_size:,} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
