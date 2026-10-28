#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pyarrow"]
# ///
"""Add or refresh the content_flags / content_flag_reasons columns in an
existing commons-qi-hf dataset, in place, without rebuilding it from the
harvest. Re-run after changing content_flags.py or the review overrides.

    uv run multimodal/commons-qi-flags.py
    uv run multimodal/commons-qi-flags.py --update-index    # also the live index

--update-index adds `content_flags` to the wikimedia index mapping and sets
it on every flagged document (and clears it on any no longer flagged) with
partial updates, so nothing is re-embedded. Needs BONSAI_MULTIMODAL_URL.
"""

import argparse
import base64
import glob
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter

import pyarrow as pa
import pyarrow.parquet as pq

import content_flags

ROWS_PER_GROUP = 500
INDEX = "wikimedia"
TEXT_COLUMNS = ["pageid", "title", "caption", "captions", "description", "categories", "depicts"]
MAPPING = {
    "properties": {
        "content_flags": {"type": "keyword"},
        "content_flag_reasons": {"type": "keyword", "index": False, "doc_values": False},
    }
}


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, file=sys.stderr, flush=True)


def flag_shard(path, overrides, counts, flagged):
    text = pq.read_table(path, columns=TEXT_COLUMNS).to_pylist()
    flags, reasons = [], []
    for row in text:
        f, r = content_flags.apply(row, overrides)
        flags.append(f)
        reasons.append(r)
        counts.update(f)
        if f:
            counts["_any"] += 1
            flagged[row["pageid"]] = (f, r)
    table = pq.read_table(path)
    for name in ("content_flags", "content_flag_reasons"):
        if name in table.column_names:
            table = table.drop_columns([name])
    table = table.append_column("content_flags", pa.array(flags, pa.list_(pa.string())))
    table = table.append_column("content_flag_reasons", pa.array(reasons, pa.list_(pa.string())))
    tmp = path + ".tmp"
    pq.write_table(table, tmp, compression="zstd", row_group_size=ROWS_PER_GROUP)
    os.replace(tmp, path)
    return len(text)


def update_card(out, counts, rows):
    path = os.path.join(out, "README.md")
    with open(path, encoding="utf-8") as f:
        card = f.read()
    card = re.sub(r"\|\s*`content_flags?[a-z_]*`\s*\|.*\n", "", card)
    card = re.sub(r"## Content flags\n.*?(?=## Loading)", "", card, flags=re.S)
    anchor = re.search(r"\|\s*`image_width`, `image_height`\s*\|.*\n", card)
    card = card[:anchor.end()] + content_flags.CARD_COLUMNS + card[anchor.end():]
    card = card.replace("## Loading", content_flags.card_section(counts, rows) + "## Loading", 1)
    with open(path, "w", encoding="utf-8") as f:
        f.write(card)


class Cluster:
    def __init__(self, url):
        u = urllib.parse.urlsplit(url)
        self.base = f"{u.scheme}://{u.hostname}" + (f":{u.port}" if u.port else "")
        cred = f"{urllib.parse.unquote(u.username or '')}:{urllib.parse.unquote(u.password or '')}"
        self.auth = "Basic " + base64.b64encode(cred.encode()).decode()

    def call(self, method, path, body=None, ndjson=False):
        data = None
        if body is not None:
            data = body.encode() if ndjson else json.dumps(body).encode()
        req = urllib.request.Request(self.base + path, data=data, method=method, headers={
            "Authorization": self.auth,
            "Content-Type": "application/x-ndjson" if ndjson else "application/json",
        })
        with urllib.request.urlopen(req) as resp:
            return json.load(resp)


def update_index(flagged):
    url = os.environ.get("BONSAI_MULTIMODAL_URL")
    if not url:
        sys.exit("BONSAI_MULTIMODAL_URL is not set")
    es = Cluster(url)
    es.call("PUT", f"/{INDEX}/_mapping", MAPPING)
    log("mapping updated")

    # Docs flagged by an earlier run but not this one get their flags cleared.
    previous = set()
    resp = es.call("POST", f"/{INDEX}/_search?scroll=1m", {
        "size": 1000, "_source": False, "query": {"exists": {"field": "content_flags"}}})
    while resp["hits"]["hits"]:
        previous.update(int(h["_id"]) for h in resp["hits"]["hits"])
        resp = es.call("POST", "/_search/scroll", {"scroll": "1m", "scroll_id": resp["_scroll_id"]})
    es.call("DELETE", "/_search/scroll", {"scroll_id": resp["_scroll_id"]})

    updates = dict(flagged)
    for pageid in previous - set(flagged):
        updates[pageid] = ([], [])
    ids = sorted(updates)
    stats = Counter()
    for i in range(0, len(ids), 200):
        lines = []
        for pageid in ids[i:i + 200]:
            f, r = updates[pageid]
            lines.append(json.dumps({"update": {"_index": INDEX, "_id": str(pageid)}}))
            lines.append(json.dumps({"doc": {"content_flags": f, "content_flag_reasons": r}}))
        resp = es.call("POST", "/_bulk", "\n".join(lines) + "\n", ndjson=True)
        for item in resp["items"]:
            u = item["update"]
            stats["missing" if u.get("status") == 404 else
                  "error" if u.get("error") else u.get("result", "?")] += 1
            if u.get("error") and u.get("status") != 404:
                log(f"error {u['_id']}: {u['error']}")
    es.call("POST", f"/{INDEX}/_refresh")
    log(f"index: {len(flagged):,} flagged, {len(previous - set(flagged)):,} cleared, {dict(stats)}"
        " (missing = not in the index)")


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--out", default=os.path.join(here, "commons-qi-hf"), help="dataset directory")
    p.add_argument("--update-index", action="store_true", help="also update the live wikimedia index")
    args = p.parse_args()

    shards = sorted(glob.glob(os.path.join(args.out, "data", "train-*.parquet")))
    if not shards:
        sys.exit(f"no shards under {args.out}/data")
    overrides = content_flags.load_overrides()
    counts, flagged, rows = Counter(), {}, 0
    for i, path in enumerate(shards, 1):
        rows += flag_shard(path, overrides, counts, flagged)
        log(f"{i}/{len(shards)} {os.path.basename(path)}: {counts['_any']:,} flagged so far")
    update_card(args.out, counts, rows)
    log(f"done: {counts['_any']:,} of {rows:,} rows flagged "
        f"({', '.join(f'{f} {counts[f]:,}' for f in content_flags.FLAGS)}), "
        f"{len(overrides):,} review overrides")
    if args.update_index:
        update_index(flagged)


if __name__ == "__main__":
    main()
