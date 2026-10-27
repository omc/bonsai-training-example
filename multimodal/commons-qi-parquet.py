#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pyarrow", "pillow"]
# ///
"""Package the commons-qi.py harvest as a Hugging Face dataset: Parquet shards
of at most 500 MB, every metadata field as a column, and each image inlined as
a base64 data URI ("data:image/webp;base64,...").

    uv run multimodal/commons-qi-parquet.py
    uv run multimodal/commons-qi-parquet.py --src multimodal/commons-qi --out multimodal/commons-qi-hf

Only records with a downloaded image are included; licence- and
rights-restricted files were never downloaded, so they're left out too.

Output:
  data/train-NNNNN-of-NNNNN.parquet
  README.md            dataset card with licence breakdown and column docs
"""

import argparse
import base64
import json
import os
import shutil
import sys
import time
from collections import Counter

import pyarrow as pa
import pyarrow.parquet as pq
from PIL import Image

MAX_SHARD_BYTES = 500 * 1000 * 1000
ROWS_PER_GROUP = 500  # ~20 MB row groups keep the HF viewer happy

LOCATION = pa.struct([
    ("lat", pa.float64()), ("lon", pa.float64()),
    ("country", pa.string()), ("region", pa.string()),
])
ITEM = pa.struct([("id", pa.string()), ("label", pa.string())])

SCHEMA = pa.schema([
    ("pageid", pa.int64()),
    ("title", pa.string()),
    ("file_page", pa.string()),
    ("caption", pa.string()),
    ("captions", pa.list_(pa.struct([("lang", pa.string()), ("text", pa.string())]))),
    ("description", pa.string()),
    ("categories", pa.list_(pa.string())),
    ("depicts", pa.list_(ITEM)),
    ("location_of_creation", pa.list_(ITEM)),
    ("captured_with", pa.list_(ITEM)),
    ("wikidata_items", pa.list_(ITEM)),
    ("wikipedia", pa.list_(pa.struct([("wiki", pa.string()), ("title", pa.string()), ("url", pa.string())]))),
    ("assessments", pa.list_(pa.string())),
    ("date_taken", pa.string()),
    ("location", pa.struct([("lat", pa.float64()), ("lon", pa.float64())])),
    ("camera_location", LOCATION),
    ("object_location", LOCATION),
    ("exif", pa.struct([
        ("make", pa.string()), ("model", pa.string()), ("lens_model", pa.string()),
        ("focal_length", pa.string()), ("f_number", pa.string()), ("exposure_time", pa.string()),
        ("iso", pa.int64()), ("flash", pa.int64()),
    ])),
    ("author", pa.string()),
    ("author_url", pa.string()),
    ("attribution", pa.string()),
    ("license", pa.string()),
    ("license_url", pa.string()),
    ("usage_terms", pa.string()),
    ("attribution_required", pa.bool_()),
    ("restrictions", pa.list_(pa.string())),
    ("mime", pa.string()),
    ("width", pa.int64()),
    ("height", pa.int64()),
    ("original_url", pa.string()),
    ("thumb_url", pa.string()),
    ("image", pa.string()),
    ("image_width", pa.int32()),
    ("image_height", pa.int32()),
])


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, file=sys.stderr, flush=True)


def image_path(src, pageid):
    return os.path.join(src, "images", f"{pageid % 1000:03d}", f"{pageid}.webp")


def scalar(v):
    """EXIF values are occasionally lists (multi-valued tags); keep the first."""
    if isinstance(v, list):
        v = v[0] if v else None
    return v


def as_str(v):
    v = scalar(v)
    return None if v is None else str(v)


def as_int(v):
    v = scalar(v)
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def place(c):
    if not c:
        return None
    return {"lat": float(c["lat"]), "lon": float(c["lon"]),
            "country": c.get("country"), "region": c.get("region")}


def to_row(r, path):
    exif = r.get("exif") or {}
    coords = r.get("coordinates") or {}
    loc = r.get("location")
    with open(path, "rb") as f:
        data = f.read()
    with Image.open(path) as img:
        w, h = img.size
    return {
        "pageid": r["pageid"],
        "title": r["title"],
        "file_page": r["file_page"],
        "caption": r.get("caption"),
        "captions": [{"lang": k, "text": v} for k, v in (r.get("captions") or {}).items()],
        "description": r.get("description"),
        "categories": r.get("categories") or [],
        "depicts": r.get("depicts") or [],
        "location_of_creation": r.get("location_of_creation") or [],
        "captured_with": r.get("captured_with") or [],
        "wikidata_items": r.get("wikidata_items") or [],
        "wikipedia": r.get("wikipedia") or [],
        "assessments": r.get("assessments") or [],
        "date_taken": r.get("date_taken"),
        "location": {"lat": float(loc["lat"]), "lon": float(loc["lon"])} if loc else None,
        "camera_location": place(coords.get("camera")),
        "object_location": place(coords.get("object")),
        "exif": {
            "make": as_str(exif.get("Make")),
            "model": as_str(exif.get("Model")),
            "lens_model": as_str(exif.get("LensModel")),
            "focal_length": as_str(exif.get("FocalLength")),
            "f_number": as_str(exif.get("FNumber")),
            "exposure_time": as_str(exif.get("ExposureTime")),
            "iso": as_int(exif.get("ISOSpeedRatings")),
            "flash": as_int(exif.get("Flash")),
        },
        "author": r.get("author"),
        "author_url": r.get("author_url"),
        "attribution": r.get("attribution"),
        "license": r.get("license"),
        "license_url": r.get("license_url"),
        "usage_terms": r.get("usage_terms"),
        "attribution_required": r.get("attribution_required"),
        "restrictions": r.get("restrictions") or [],
        "mime": r.get("mime"),
        "width": r.get("width"),
        "height": r.get("height"),
        "original_url": r.get("original_url"),
        "thumb_url": r.get("thumb_url"),
        "image": "data:image/webp;base64," + base64.b64encode(data).decode("ascii"),
        "image_width": w,
        "image_height": h,
    }


class ShardWriter:
    """Rolls to a new file before a row group could push the current one past
    MAX_SHARD_BYTES, judged from the largest row group written so far."""

    def __init__(self, tmp_dir, max_bytes):
        self.tmp_dir = tmp_dir
        self.max_bytes = max_bytes
        self.paths = []
        self.sink = None
        self.writer = None
        self.largest_group = 0

    def open(self):
        path = os.path.join(self.tmp_dir, f"shard-{len(self.paths):05d}.parquet")
        self.paths.append(path)
        self.sink = pa.OSFile(path, "wb")
        self.writer = pq.ParquetWriter(self.sink, SCHEMA, compression="zstd")

    def close(self):
        if self.writer:
            self.writer.close()
            self.sink.close()
            self.writer = None

    def write(self, rows):
        table = pa.Table.from_pylist(rows, schema=SCHEMA)
        # 1.5x headroom on the group estimate plus 1 MB for the footer.
        if self.writer and self.sink.tell() + self.largest_group * 1.5 + 1_000_000 > self.max_bytes:
            self.close()
        if not self.writer:
            self.open()
        before = self.sink.tell()
        self.writer.write_table(table)
        self.largest_group = max(self.largest_group, self.sink.tell() - before)


LICENSE = """Each image in this dataset is licensed individually by its author, as
recorded in the row's `license`, `license_url` and `usage_terms` columns.
Every image is under one of: CC0, public domain, CC BY (any version), or
CC BY-SA (any version). Reuse must follow that image's licence, including
attribution to `author` and a link to `file_page`.

The metadata is derived from Wikimedia Commons and Wikidata. Wikidata content
is CC0; Commons file description text is CC BY-SA 4.0.
"""


def write_card(out, stats, licences, shards):
    rows = stats["rows"]
    licence_lines = "\n".join(f"| {lic} | {n:,} |" for lic, n in licences.most_common())
    card = f"""---
license: other
license_name: mixed-cc0-cc-by-cc-by-sa
license_link: LICENSE
pretty_name: Wikimedia Commons Quality Images (384px)
size_categories:
- 100K<n<1M
task_categories:
- image-to-text
- zero-shot-image-classification
- image-feature-extraction
tags:
- wikimedia-commons
- quality-images
- multimodal
- image-search
configs:
- config_name: default
  data_files:
  - split: train
    path: data/train-*.parquet
---

# Wikimedia Commons Quality Images (384px)

{rows:,} photographs from Wikimedia Commons'
[Quality images](https://commons.wikimedia.org/wiki/Commons:Quality_images)
category, each downscaled to fit 384x384 and stored inline as a WebP data URI,
with the file's full Commons metadata: captions, descriptions, categories,
structured-data "depicts" statements, location, camera EXIF, licence and
author, and the Wikipedia articles and Wikidata items that use it.

Harvested {time.strftime('%Y-%m')} through the Commons API. {shards} Parquet
shards, each under 500 MB.

## Licensing and attribution

**Every row carries its own licence.** There is no single licence for the
dataset. Only files under CC0, public domain, CC BY or CC BY-SA are included;
GFDL-only, Free Art License and other licences were excluded, as were files
tagged with personality-rights, trademark, insignia or cultural-heritage
restrictions.

When you display or redistribute an image you must follow its licence: credit
`author` (linking `author_url` where possible), name `license` and link
`license_url`, and link the source `file_page`. CC BY-SA images require
derivatives to be shared under the same licence.

| Licence | Images |
|---|---|
{licence_lines}

## Columns

| Column | Type | Notes |
|---|---|---|
| `pageid` | int | Commons page id; unique |
| `title` | string | file name without `File:` |
| `file_page` | string | Commons description page (attribution link) |
| `caption` / `captions` | string / list | structured-data caption, English first; all languages |
| `description` | string | file description, HTML stripped |
| `categories` | list[string] | non-hidden Commons categories |
| `depicts` | list[{{id, label}}] | Wikidata items from P180 |
| `location_of_creation` | list[{{id, label}}] | P1071 |
| `captured_with` | list[{{id, label}}] | camera, P4082 |
| `wikidata_items` | list[{{id, label}}] | items using this file as their image |
| `wikipedia` | list[{{wiki, title, url}}] | articles using this file |
| `assessments` | list[string] | e.g. `quality`, `featured`, `valued` |
| `date_taken` | string | ISO date when known |
| `location` | {{lat, lon}} | camera position, else subject position |
| `camera_location` / `object_location` | {{lat, lon, country, region}} | |
| `exif` | struct | make, model, lens, focal length, f-number, exposure, ISO, flash |
| `author`, `author_url`, `attribution` | string | |
| `license`, `license_url`, `usage_terms`, `attribution_required` | | |
| `restrictions` | list[string] | always empty here (restricted files excluded) |
| `mime`, `width`, `height` | | original file |
| `original_url`, `thumb_url` | string | upload.wikimedia.org URLs |
| `image` | string | `data:image/webp;base64,...`, max 384px side |
| `image_width`, `image_height` | int | size of the inlined WebP |

## Loading

```python
import base64, io
from datasets import load_dataset
from PIL import Image

ds = load_dataset("parquet", data_files="data/train-*.parquet", split="train")
row = ds[0]
img = Image.open(io.BytesIO(base64.b64decode(row["image"].split(",", 1)[1])))
```
"""
    with open(os.path.join(out, "README.md"), "w", encoding="utf-8") as f:
        f.write(card)
    with open(os.path.join(out, "LICENSE"), "w", encoding="utf-8") as f:
        f.write(LICENSE)


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--src", default=os.path.join(here, "commons-qi"), help="commons-qi.py output directory")
    p.add_argument("--out", default=os.path.join(here, "commons-qi-hf"), help="dataset directory to create")
    p.add_argument("--max-mb", type=float, default=MAX_SHARD_BYTES / 1e6, help="shard size cap")
    p.add_argument("--limit", type=int, default=0, help="stop after this many rows, for a trial run")
    args = p.parse_args()

    data_dir = os.path.join(args.out, "data")
    if os.path.exists(data_dir) and os.listdir(data_dir):
        sys.exit(f"{data_dir} already has files; move them aside first")
    tmp_dir = os.path.join(args.out, ".tmp")
    shutil.rmtree(tmp_dir, ignore_errors=True)
    os.makedirs(tmp_dir)
    os.makedirs(data_dir, exist_ok=True)

    shards = ShardWriter(tmp_dir, args.max_mb * 1000 * 1000)
    stats, licences, seen, batch = Counter(), Counter(), set(), []
    started = time.monotonic()
    with open(os.path.join(args.src, "meta.ndjson"), encoding="utf-8") as f:
        for line in f:
            r = json.loads(line)
            if r["pageid"] in seen:
                continue
            seen.add(r["pageid"])
            path = image_path(args.src, r["pageid"])
            if not os.path.exists(path):
                stats["no_image"] += 1
                continue
            batch.append(to_row(r, path))
            licences[r["license"]] += 1
            stats["rows"] += 1
            if len(batch) == ROWS_PER_GROUP:
                shards.write(batch)
                batch = []
            if stats["rows"] % 20000 == 0:
                log(f"{stats['rows']:,} rows, {len(shards.paths)} shards, "
                    f"{stats['rows'] / (time.monotonic() - started):.0f} rows/s")
            if args.limit and stats["rows"] >= args.limit:
                break
    if batch:
        shards.write(batch)
    shards.close()

    total = len(shards.paths)
    largest = 0
    for i, path in enumerate(shards.paths):
        largest = max(largest, os.path.getsize(path))
        os.replace(path, os.path.join(data_dir, f"train-{i:05d}-of-{total:05d}.parquet"))
    os.rmdir(tmp_dir)
    write_card(args.out, stats, licences, total)
    log(f"done: {stats['rows']:,} rows in {total} shards (largest {largest / 1e6:.0f} MB), "
        f"{stats['no_image']:,} records without an image skipped -> {args.out}")


if __name__ == "__main__":
    main()
