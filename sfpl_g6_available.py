#!/usr/bin/env python3
"""
Build a CSV of physical books currently available at SFPL's Golden Gate Valley
branch, using only public, read-only catalog pages.

Why two catalogs?
  * The new BiblioCommons catalog can enumerate every bib held at the branch
    (searchType "bl", query "*:*", f_STATUS=G6), but its search API has no
    "available now at this branch" facet.  Copy-level status is only exposed
    one bib at a time via /bibs/item_groups/{id}.
  * The classic III catalog exposes a branch-scoped call-number browse with
    "Limit to available" (searchscope=12, availlim=1).  That is the practical
    public way to get the on-shelf subset.  It gives call number + title, but
    not structured author metadata.
  * This script therefore harvests the available-at-G6 shelf rows from the
    classic catalog, then enriches them in batches with BiblioCommons
    call-number queries (title, author, format).  Unmatched rows fall back to
    the classic title statement for author.

Polite defaults: one request at a time, 0.5 s delay, retries with backoff,
no authentication, no account access.

Examples:
  # small test: only call numbers beginning with 0
  python3 sfpl_g6_available.py --prefixes 0 --out g6_0.csv

  # a multi-character prefix (one prefix, not the characters "j" and "0")
  python3 sfpl_g6_available.py --prefixes j0 --out g6_j0.csv

  # full available-at-G6 sweep (about 1,000 classic pages + metadata batches)
  python3 sfpl_g6_available.py --out sfpl_g6_available.csv

  # report the held-at-branch count from the new catalog
  python3 sfpl_g6_available.py --held-count
"""

from __future__ import annotations

import argparse
import csv
import html
import http.cookiejar
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from difflib import SequenceMatcher

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
)
LEGACY = "https://sflib1.sfpl.org"
GATEWAY = "https://gateway.bibliocommons.com/v2"
LIBRARY = "sfpl"
BRANCH_CODE = "G6"
BRANCH_NAME = "GOLDEN GATE VALLEY BRANCH"
LEGACY_SCOPE = "12"  # III searchscope for Golden Gate Valley

FORMAT_LABELS = {
    "BK": "Book",
    "LPRINT": "Large Print",
    "BOOK_CD": "Book on CD",
    "AB": "Audiobook",
    "EBOOK": "eBook",
    "DVD": "DVD",
    "BLURAY": "Blu-ray",
}


class Client:
    def __init__(self, delay: float = 0.5, timeout: int = 60):
        self.delay = delay
        self.timeout = timeout
        self.jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.jar)
        )
        self._last = 0.0

    def _wait(self) -> None:
        elapsed = time.time() - self._last
        if elapsed < self.delay:
            time.sleep(self.delay - elapsed)
        self._last = time.time()

    def _open(self, req: urllib.request.Request, tries: int = 5) -> bytes:
        last = None
        for attempt in range(tries):
            self._wait()
            try:
                with self.opener.open(req, timeout=self.timeout) as resp:
                    return resp.read()
            except urllib.error.HTTPError as exc:
                last = exc
                if exc.code in (403, 429, 500, 502, 503, 504):
                    time.sleep(min(30, 2 ** attempt))
                    continue
                raise
            except (urllib.error.URLError, TimeoutError) as exc:
                last = exc
                time.sleep(min(30, 2 ** attempt))
        raise RuntimeError(f"request failed after {tries} tries: {last}")

    def get(self, url: str, referer: str | None = None) -> str:
        headers = {
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml,application/json",
            "Accept-Language": "en-US,en;q=0.9",
        }
        if referer:
            headers["Referer"] = referer
        data = self._open(urllib.request.Request(url, headers=headers))
        return data.decode("utf-8", "replace")

    def post_json(self, url: str, payload: dict) -> dict:
        body = json.dumps(payload).encode("utf-8")
        headers = {
            "User-Agent": UA,
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Origin": "https://sfpl.bibliocommons.com",
            "Referer": "https://sfpl.bibliocommons.com/",
        }
        data = self._open(urllib.request.Request(url, data=body, headers=headers))
        return json.loads(data.decode("utf-8", "replace"))


def norm_call(value: str | None) -> str:
    """Case/punctuation-insensitive key for call-number matching."""
    value = html.unescape(value or "").upper()
    return re.sub(r"[^A-Z0-9]", "", value)


def norm_title(value: str | None) -> str:
    value = html.unescape(value or "").lower()
    value = re.sub(r"^\s*(the|a|an)\s+", "", value)
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def clean_title(value: str | None) -> str:
    """Drop the statement of responsibility (" / author") from a title."""
    text = html.unescape(value or "").strip()
    text = re.split(r"\s+/\s+", text, maxsplit=1)[0]
    return text.rstrip(" :;,").strip()


def call_sort_key(value: str):
    """Natural/alphanumeric sort key. Not a full LC shelf-order key."""
    value = (value or "").upper()
    parts = re.split(r"(\d+(?:\.\d+)?)", value)
    key = []
    for part in parts:
        if not part:
            continue
        if re.fullmatch(r"\d+(?:\.\d+)?", part):
            key.append((0, float(part), part))
        else:
            key.append((1, part))
    return key


def parse_browse_page(page: str):
    """Return (groups, total_from_header).  Groups preserve subentry order."""
    text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", page))
    m = re.search(r"Call Nos \((\d+)-(\d+) of (\d+)\)", text)
    total = int(m.group(3)) if m else None

    rows = re.findall(
        r'<tr\s+class="(browseEntry|browseSubEntry)">(.*?)</tr>', page, re.S
    )
    groups: list[dict] = []
    for kind, row in rows:
        if kind == "browseEntry":
            cell_m = re.search(r'class="browseEntryData">(.*?)</td>', row, re.S)
            cell = cell_m.group(1) if cell_m else ""
            link_m = re.search(r'<a[^>]*href="([^"]+)"[^>]*>(.*?)</a>', cell, re.S)
            if link_m:
                call = html.unescape(re.sub(r"<[^>]+>", "", link_m.group(2)))
                link = html.unescape(link_m.group(1))
            else:
                call = html.unescape(re.sub(r"<[^>]+>", "", cell))
                link = None
            # Some rows put "CALL : title" in the same cell and have no subrow.
            call = re.split(r"\s+:\s+", call)[0]
            call = re.sub(r"\s+", " ", call).strip()

            media_m = re.search(r'<img[^>]*alt="([^"]*)"', row)
            inline_title = re.split(
                r"\s+:\s+", html.unescape(re.sub(r"<[^>]+>", " ", cell))
            )
            inline_title = inline_title[1].strip() if len(inline_title) > 1 else ""
            year_m = re.search(r'class="browseEntryYear">(.*?)</td>', row, re.S)

            group = {
                "call": call,
                "link": link,
                "subs": [],
                "inline_title": inline_title,
                "inline_media": media_m.group(1) if media_m else None,
            }
            groups.append(group)
        else:
            data_m = re.search(r'class="browseSubEntryData">(.*?)</td>', row, re.S)
            title = (
                re.sub(
                    r"\s+",
                    " ",
                    html.unescape(re.sub(r"<[^>]+>", " ", data_m.group(1))),
                ).strip()
                if data_m
                else ""
            )
            media_m = re.search(r'<img[^>]*alt="([^"]*)"', row)
            year_m = re.search(r'class="browseSubEntryYear">(.*?)</td>', row, re.S)
            if groups:
                groups[-1]["subs"].append(
                    {
                        "title": title,
                        "media": media_m.group(1) if media_m else None,
                        "year": re.sub(r"<[^>]+>", "", year_m.group(1)).strip()
                        if year_m
                        else "",
                    }
                )
    return groups, total


def next_link(page: str) -> str | None:
    m = re.search(r'<a href="([^"]+)"><span[^>]*>\s*Next\s*</span>', page)
    if not m:
        return None
    url = html.unescape(m.group(1))
    if url.startswith("/"):
        url = LEGACY + url
    return url


def harvest_prefix(client: Client, prefix: str, max_pages: int | None = None):
    """Harvest one call-number prefix from the classic catalog."""
    url = (
        f"{LEGACY}/search/c?SEARCH={urllib.parse.quote(prefix)}"
        f"&searchscope={LEGACY_SCOPE}&availlim=1"
    )
    groups: list[dict] = []
    seen_urls = set()
    pages = 0
    header_total = None
    while url:
        page = client.get(url, referer=f"{LEGACY}/search/c")
        pages += 1
        gs, total = parse_browse_page(page)
        if total is not None:
            header_total = total
        groups.extend(gs)
        if pages % 25 == 0:
            print(f"  prefix {prefix!r}: page {pages}, groups so far {len(groups)}", flush=True)
        nxt = next_link(page)
        if not nxt or nxt in seen_urls:
            break
        if max_pages and pages >= max_pages:
            break
        seen_urls.add(nxt)
        url = nxt
    return groups, header_total, pages


def dedupe_book_rows(groups: list[dict]) -> list[dict]:
    """Collapse repeated copy subrows into one row per call number/title/year."""
    rows: dict[tuple, dict] = {}
    for group in groups:
        call = group.get("call") or ""
        subs = group.get("subs") or []
        if not subs and group.get("inline_title"):
            subs = [
                {
                    "title": group["inline_title"],
                    "media": group.get("inline_media") or "BOOK",
                    "year": "",
                }
            ]
        for sub in subs:
            if sub.get("media") != "BOOK":
                continue
            raw_title = sub.get("title") or ""
            if not raw_title:
                continue
            title = clean_title(raw_title)
            year = sub.get("year") or ""
            key = (norm_call(call), norm_title(title), year)
            if key in rows:
                rows[key]["copies_listed"] += 1
            else:
                rows[key] = {
                    "call": call,
                    "title": title,
                    "raw_title": raw_title,
                    "year": year,
                    "copies_listed": 1,
                    "link": group.get("link"),
                }
    return list(rows.values())


def legacy_author_from_title(title: str) -> str:
    """Best-effort fallback when a title is absent from the new catalog."""
    text = html.unescape(title or "")
    if " / " not in text:
        return ""
    statement = text.split(" / ", 1)[1]
    statement = statement.split(" ; ", 1)[0]
    statement = re.sub(
        r"^(by|written by|edited by|compiled by|illustrated by)\s+",
        "",
        statement,
        flags=re.I,
    )
    statement = re.sub(
        r",?\s*(author|editor|compiler|illustrator|translator).*$",
        "",
        statement,
        flags=re.I,
    )
    statement = statement.rstrip(".").strip()
    return statement if 1 < len(statement) < 90 else ""


def fetch_metadata(client: Client, calls: list[str], batch: int = 40) -> dict:
    """Query BiblioCommons by exact call number in OR batches."""
    meta: dict[str, list[dict]] = {}
    batches = [calls[i : i + batch] for i in range(0, len(calls), batch)]
    for num, chunk in enumerate(batches, 1):
        q = " OR ".join('callnumber:"%s"' % c.replace('"', '\\"') for c in chunk)
        page = 1
        while True:
            payload = {
                "query": q,
                "searchType": "bl",
                "f_STATUS": BRANCH_CODE,
                "page": page,
                "limit": 100,
            }
            data = client.post_json(
                f"{GATEWAY}/libraries/{LIBRARY}/bibs/search", payload
            )
            cs = data.get("catalogSearch")
            if not cs:
                raise RuntimeError(f"metadata search failed: {data}")
            for bib_id, bib in data.get("entities", {}).get("bibs", {}).items():
                info = bib.get("briefInfo", {})
                call = info.get("callNumber") or ""
                rec = {
                    "id": bib_id,
                    "title": info.get("title") or "",
                    "subtitle": info.get("subtitle") or "",
                    "authors": info.get("authors") or [],
                    "call": call,
                    "format": info.get("format") or "",
                    "isbn": info.get("isbns") or [],
                    "date": info.get("publicationDate") or "",
                }
                meta.setdefault(norm_call(call), []).append(rec)
            pagination = cs.get("pagination", {})
            if page >= int(pagination.get("pages") or 1):
                break
            page += 1
        if num % 10 == 0 or num == len(batches):
            print(f"  metadata batch {num}/{len(batches)}", flush=True)
    return meta


def fetch_metadata_single(client: Client, calls: list[str]) -> dict:
    """Fallback: query each call number alone and key results by the query.

    Useful when the catalog's stored call number differs from the shelf label
    (for example legacy "F BARNES J" vs catalog "TEEN F BARN").
    """
    meta: dict[str, list[dict]] = {}
    for num, call in enumerate(calls, 1):
        q = 'callnumber:"%s"' % call.replace('"', '\\"')
        payload = {
            "query": q,
            "searchType": "bl",
            "f_STATUS": BRANCH_CODE,
            "page": 1,
            "limit": 100,
        }
        data = client.post_json(f"{GATEWAY}/libraries/{LIBRARY}/bibs/search", payload)
        cs = data.get("catalogSearch")
        if not cs:
            continue
        recs = []
        for bib_id, bib in data.get("entities", {}).get("bibs", {}).items():
            info = bib.get("briefInfo", {})
            recs.append(
                {
                    "id": bib_id,
                    "title": info.get("title") or "",
                    "subtitle": info.get("subtitle") or "",
                    "authors": info.get("authors") or [],
                    "call": info.get("callNumber") or "",
                    "format": info.get("format") or "",
                    "isbn": info.get("isbns") or [],
                    "date": info.get("publicationDate") or "",
                }
            )
        meta[norm_call(call)] = recs
        if num % 10 == 0 or num == len(calls):
            print(f"  single-call fallback {num}/{len(calls)}", flush=True)
    return meta


def title_match_score(legacy_title: str, candidate_title: str) -> float:
    """Compare full titles, and also the main title before a subtitle."""
    want = norm_title(legacy_title)
    candidate = norm_title(candidate_title)
    score = SequenceMatcher(None, want, candidate).ratio()
    base_raw = re.split(r"\s+:\s+|\s+;\s+", legacy_title or "", maxsplit=1)[0]
    base = norm_title(base_raw)
    if base and len(base) >= 2 and base not in {"the", "a", "an"} and base != want:
        score = max(score, SequenceMatcher(None, base, candidate).ratio())
    return score


def pick_metadata(candidates: list[dict] | None, legacy_title: str):
    if not candidates:
        return None
    if len(candidates) == 1:
        return candidates[0]
    best = max(
        candidates,
        key=lambda rec: title_match_score(legacy_title, rec["title"]),
    )
    score = title_match_score(legacy_title, best["title"])
    return best if score >= 0.45 else None


def held_count(client: Client) -> tuple[int, dict]:
    payload = {
        "query": "*:*",
        "searchType": "bl",
        "f_STATUS": BRANCH_CODE,
        "f_FORMAT": "BK",
        "page": 1,
        "limit": 1,
    }
    data = client.post_json(f"{GATEWAY}/libraries/{LIBRARY}/bibs/search", payload)
    cs = data["catalogSearch"]
    return int(cs["pagination"]["count"]), cs["pagination"]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--prefixes",
        default="0,1,2,3,4,5,6,7,8,9,a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,s,t,u,v,w,x,y,z",
        help="comma-separated call-number prefixes to sweep (default: 0-9,a-z)",
    )
    parser.add_argument("--out", default="sfpl_g6_available.csv")
    parser.add_argument(
        "--delay", type=float, default=0.5, help="seconds between requests"
    )
    parser.add_argument(
        "--batch", type=int, default=40, help="call numbers per metadata query"
    )
    parser.add_argument(
        "--max-pages",
        type=int,
        default=None,
        help="limit pages per prefix (for a quick test; makes the result partial)",
    )
    parser.add_argument(
        "--held-count",
        action="store_true",
        help="only report the held-at-branch BK count from BiblioCommons",
    )
    args = parser.parse_args(argv)

    client = Client(delay=args.delay)
    # A session cookie is required by the classic catalog's WAF.
    client.get(f"{LEGACY}/")

    if args.held_count:
        count, pagination = held_count(client)
        print(f"Held BK bibs at {BRANCH_NAME} ({BRANCH_CODE}): {count}")
        print(f"Pagination: {pagination}")
        return 0

    all_groups: list[dict] = []
    prefixes = [p.strip() for p in args.prefixes.split(",") if p.strip()]
    for prefix in prefixes:
        groups, total, pages = harvest_prefix(client, prefix, args.max_pages)
        all_groups.extend(groups)
        print(
            f"prefix {prefix!r}: header={total} groups={len(groups)} pages={pages}",
            flush=True,
        )

    rows = dedupe_book_rows(all_groups)
    calls = []
    seen_calls = set()
    for row in rows:
        key = norm_call(row["call"])
        if key and key not in seen_calls:
            seen_calls.add(key)
            calls.append(row["call"])
    print(
        f"classic sweep: {len(all_groups)} groups -> "
        f"{len(rows)} BOOK rows, {len(calls)} unique call numbers",
        flush=True,
    )

    meta = fetch_metadata(client, calls, batch=args.batch)

    selected_by_row = {}
    missed = []
    for idx, row in enumerate(rows):
        candidates = meta.get(norm_call(row["call"]))
        selected = pick_metadata(candidates, row["title"])
        selected_by_row[idx] = selected
        if selected is None:
            missed.append(row["call"])

    if missed:
        uniq_missed = list(dict.fromkeys(missed))
        print(
            f"retrying {len(uniq_missed)} unmatched call numbers individually",
            flush=True,
        )
        meta2 = fetch_metadata_single(client, uniq_missed)
        for idx, row in enumerate(rows):
            if selected_by_row[idx] is None:
                selected_by_row[idx] = pick_metadata(
                    meta2.get(norm_call(row["call"])), row["title"]
                )

    out_rows = []
    matched = 0
    for idx, row in enumerate(rows):
        selected = selected_by_row[idx]
        if selected:
            matched += 1
            title = selected["title"]
            if selected.get("subtitle"):
                title = f"{title} : {selected['subtitle']}"
            author = (
                "; ".join(selected["authors"])
                if selected["authors"]
                else legacy_author_from_title(row["raw_title"])
            )
            fmt = FORMAT_LABELS.get(selected["format"], selected["format"] or "Book")
            catalog_call = selected["call"]
            source = "bibliocommons"
        else:
            title = row["title"]
            author = legacy_author_from_title(row["raw_title"])
            fmt = "Book"
            catalog_call = ""
            source = "legacy"

        out_rows.append(
            {
                "title": title,
                "author": author,
                "call_number": row["call"],
                "catalog_call_number": catalog_call,
                "format": fmt,
                "availability": "AT_LEAST_ONE_COPY_AVAILABLE_AT_BRANCH",
                "copies_listed_at_branch": row["copies_listed"],
                "branch": BRANCH_NAME,
                "year": row["year"],
                "metadata_source": source,
            }
        )

    out_rows.sort(
        key=lambda r: (call_sort_key(r["call_number"]), norm_title(r["title"]))
    )

    with open(args.out, "w", newline="", encoding="utf-8") as fh:
        writer = csv.DictWriter(
            fh,
            fieldnames=[
                "title",
                "author",
                "call_number",
                "catalog_call_number",
                "format",
                "availability",
                "copies_listed_at_branch",
                "branch",
                "year",
                "metadata_source",
            ],
        )
        writer.writeheader()
        writer.writerows(out_rows)

    print(f"matched new-catalog metadata: {matched}/{len(out_rows)}")
    print(f"wrote {len(out_rows)} rows to {args.out}")
    print(
        "NOTE: availability is title-level: the classic catalog's availlim filter "
        "keeps titles with at least one available G6 copy.  copies_listed_at_branch "
        "counts all copy rows shown for that title (including checked-out copies). "
        "call_number is the branch shelf label; catalog_call_number is what the new "
        "catalog stores (they can differ, e.g. shelving vs teen collection)."
    )
    if args.max_pages:
        print("NOTE: --max-pages was used; this CSV is a partial sample.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        sys.exit(130)
