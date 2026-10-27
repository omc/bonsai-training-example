#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.10"
# dependencies = ["pillow"]
# ///
"""Harvest Wikimedia Commons "Quality images" with every useful bit of metadata
(captions, descriptions, depicts, location, camera, licence, Wikipedia usage...)
and download each image as a WebP that fits in 384x384.

    uv run multimodal/commons-qi.py --contact you@example.com            # both, pipelined
    uv run multimodal/commons-qi.py --contact you@example.com meta       # metadata only
    uv run multimodal/commons-qi.py --contact you@example.com images     # images for existing metadata
    uv run multimodal/commons-qi.py --contact you@example.com --limit 200 --out /tmp/qi-test

Everything resumes where it left off: just rerun after a crash or Ctrl-C.

Politeness, per https://wikitech.wikimedia.org/wiki/Robot_policy:
  - identifying User-Agent with a contact address (required)
  - Action API (Commons + Wikidata): one request at a time, <= 4 req/s,
    5s pause after any request slower than 1s; maxlag=5 on Commons (Wikidata's
    maxlag is dominated by query-service lag, irrelevant to cached label reads)
  - Media: 2 concurrent downloads, <= 20 Mbps, <= --per-hour requests (halved
    on every 429, recovering slowly), standard thumbnail sizes only
    (the API picks the bucket; we downscale to 384 locally)
  - 429/5xx and Retry-After pause every worker, with exponential backoff

Authentication (OAuth 2, read from the environment or the repo's .env):
  WIKIMEDIA_ACCESS_TOKEN                 owner-only consumer access token, or
  WIKIMEDIA_CLIENT_APPLICATION_KEY/SECRET  to mint one via client_credentials
Authenticated runs start at a higher --per-hour and API rate; anonymous runs
stay at the anonymous limits.

Output (default multimodal/commons-qi/):
  meta.ndjson        one record per file (see to_record for fields)
  meta.state.json    API continuation token
  labels.ndjson      cache of Wikidata item labels (depicts, places, items)
  images/NNN/<pageid>.webp   NNN = pageid % 1000
  failures.ndjson    downloads that gave up; retried on the next run
"""

import argparse
import gzip
import html
import io
import json
import os
import queue
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter

from PIL import Image

COMMONS_API = "https://commons.wikimedia.org/w/api.php"
WIKIDATA_API = "https://www.wikidata.org/w/api.php"
CATEGORY = "Category:Quality_images"
MAX_SIDE = 384
OAUTH_TOKEN_URL = "https://meta.wikimedia.org/w/rest.php/oauth2/access_token"
API_MIN_INTERVAL = {False: 0.25, True: 0.11}  # robot policy: 5 req/s anon, 10 authenticated
PER_HOUR = {False: 10000, True: 36000}
MEDIA_WORKERS = 2  # robot policy caps media concurrency at 2 even when authenticated

EXTMETA = [
    "LicenseShortName", "LicenseUrl", "UsageTerms", "AttributionRequired",
    "Artist", "Credit", "Attribution", "ImageDescription", "ObjectName",
    "Restrictions", "Assessments", "DateTimeOriginal",
]
EXIF = [
    "Make", "Model", "LensModel", "FocalLength", "FNumber", "ExposureTime",
    "ISOSpeedRatings", "Flash",
]
# Structured-data (MediaInfo) statements resolved to Wikidata labels.
ITEM_PROPS = {
    "P180": "depicts",
    "P1071": "location_of_creation",
    "P4082": "captured_with",
}

QUERY = {
    "action": "query",
    "generator": "categorymembers",
    "gcmtitle": CATEGORY,
    "gcmtype": "file",
    "gcmlimit": "50",  # thumbnail URLs are capped at 50 per request
    "prop": "imageinfo|categories|globalusage|coordinates",
    "iiprop": "url|size|mime|extmetadata|commonmetadata",
    "iiurlwidth": str(MAX_SIDE),
    "iiurlheight": str(MAX_SIDE),
    "iiextmetadatafilter": "|".join(EXTMETA),
    "iiextmetadatalanguage": "en",
    "clshow": "!hidden",
    "cllimit": "max",
    "gunamespace": "0",
    "gulimit": "max",
    "coprop": "type|name|dim|country|region|globe",
    "coprimary": "all",
    "colimit": "max",
}


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, file=sys.stderr, flush=True)


def load_dotenv(path):
    """Minimal KEY=value reader; never overrides variables already set."""
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.removeprefix("export ").split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip("'\""))


class Http:
    def __init__(self, contact):
        self.headers = {
            "User-Agent": f"BonsaiDemoHarvester/1.0 (https://bonsai.io; {contact}) python-urllib",
            "Accept-Encoding": "gzip",
        }
        self.client_id = os.environ.get("WIKIMEDIA_CLIENT_APPLICATION_KEY")
        self.client_secret = os.environ.get("WIKIMEDIA_CLIENT_APPLICATION_SECRET")
        self.token = os.environ.get("WIKIMEDIA_ACCESS_TOKEN") or os.environ.get("WIKIMEDIA_TOKEN")
        self.lock = threading.Lock()
        self.user = None
        if not self.token and self.client_id and self.client_secret:
            self.refresh_token(None)

    @property
    def authenticated(self):
        return self.user is not None

    def refresh_token(self, stale):
        """Mint a token with the client credentials grant. Only one thread
        refreshes; the others pick up its result."""
        if not (self.client_id and self.client_secret):
            return False
        with self.lock:
            if self.token != stale:
                return True
            body = urllib.parse.urlencode({
                "grant_type": "client_credentials",
                "client_id": self.client_id,
                "client_secret": self.client_secret,
            }).encode()
            req = urllib.request.Request(OAUTH_TOKEN_URL, data=body, headers={"User-Agent": self.headers["User-Agent"]})
            with urllib.request.urlopen(req, timeout=60) as r:
                self.token = json.loads(r.read())["access_token"]
            log("oauth: minted a new access token from the client credentials")
            return True

    def login(self):
        """Confirm the token works; returns the account name, or None if anonymous."""
        if not self.token:
            log("oauth: no credentials; running anonymously at anonymous limits")
            return None
        url = COMMONS_API + "?action=query&meta=userinfo&format=json&formatversion=2"
        info = json.loads(self.get(url))["query"]["userinfo"]
        if info.get("anon"):
            sys.exit("oauth: token was not accepted (Commons sees an anonymous user)")
        self.user = info["name"]
        log(f"oauth: logged in as {self.user}")
        return self.user

    def get(self, url, timeout=60):
        for attempt in range(2):
            token = self.token
            headers = dict(self.headers)
            if token:
                headers["Authorization"] = "Bearer " + token
            req = urllib.request.Request(url, headers=headers)
            try:
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    body = r.read()
                    if r.headers.get("Content-Encoding") == "gzip":
                        body = gzip.decompress(body)
                    return body
            except urllib.error.HTTPError as e:
                if e.code == 401 and token and attempt == 0 and self.refresh_token(token):
                    continue
                raise


def retry_after(err, default):
    try:
        return max(float(err.headers.get("Retry-After")), 1.0)
    except (TypeError, ValueError, AttributeError):
        return default


# ---------------------------------------------------------------- metadata --

class Api:
    """Serial Action API client shared by Commons and Wikidata calls."""

    def __init__(self, http):
        self.http = http
        self.last = 0.0
        self.interval = API_MIN_INTERVAL[http.authenticated]

    def query(self, base, params, maxlag=True):
        params = {"format": "json", "formatversion": "2", **params}
        if maxlag:
            params["maxlag"] = "5"
        url = base + "?" + urllib.parse.urlencode(params)
        for attempt in range(12):
            wait = self.last + self.interval - time.monotonic()
            if wait > 0:
                time.sleep(wait)
            start = time.monotonic()
            self.last = start
            try:
                data = json.loads(self.http.get(url))
            except urllib.error.HTTPError as e:
                if e.code == 429 or e.code >= 500:
                    delay = retry_after(e, min(30 * 2 ** attempt, 900))
                    log(f"API HTTP {e.code}; sleeping {delay:.0f}s")
                    time.sleep(delay)
                    continue
                raise
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                delay = min(10 * 2 ** attempt, 600)
                log(f"API {e!r}; sleeping {delay}s")
                time.sleep(delay)
                continue
            if "error" in data:
                if data["error"].get("code") == "maxlag":
                    delay = min(max(float(data["error"].get("lag") or 0), 10) * (attempt + 1), 300)
                    log(f"API maxlag; sleeping {delay:.0f}s")
                    time.sleep(delay)
                    continue
                code = data["error"].get("code", "")
                if code.startswith("internal_api_error") or code in ("readonly", "ratelimited"):
                    # Transient server-side trouble (DB failover, read-only maintenance).
                    delay = min(30 * 2 ** attempt, 900)
                    log(f"API {code}; sleeping {delay}s")
                    time.sleep(delay)
                    continue
                raise RuntimeError(data["error"])
            if time.monotonic() - start > 1.0:
                time.sleep(5)  # robot policy: slow request -> back off
            return data
        raise RuntimeError("API: too many retries")


class Labels:
    """Wikidata Q-id -> English label, cached in an append-only file."""

    def __init__(self, api, path):
        self.api = api
        self.path = path
        self.cache = {}
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                for line in f:
                    row = json.loads(line)
                    self.cache[row["id"]] = row["label"]

    def resolve(self, qids):
        missing = sorted({q for q in qids if q not in self.cache})
        with open(self.path, "a", encoding="utf-8") as out:
            for i in range(0, len(missing), 50):
                chunk = missing[i:i + 50]
                data = self.api.query(WIKIDATA_API, {
                    "action": "wbgetentities", "ids": "|".join(chunk),
                    "props": "labels", "languages": "en|mul", "languagefallback": "1",
                }, maxlag=False)  # Wikidata's maxlag tracks query-service lag, which only matters to editors
                entities = data.get("entities", {})
                for q in chunk:
                    labels = entities.get(q, {}).get("labels", {})
                    label = (labels.get("en") or labels.get("mul") or {}).get("value")
                    self.cache[q] = label
                    out.write(json.dumps({"id": q, "label": label}, ensure_ascii=False) + "\n")

    def items(self, qids):
        return [{"id": q, "label": self.cache.get(q)} for q in qids]


def text(fragment):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", fragment or ""))).strip()


def first_href(fragment):
    m = re.search(r'href="([^"]+)"', fragment or "")
    if not m:
        return None
    href = html.unescape(m.group(1))
    return "https:" + href if href.startswith("//") else href


def strip_query(url):
    return url.split("?", 1)[0] if url else None


def statement_values(statements, prop):
    return [
        s["mainsnak"]["datavalue"]["value"]
        for s in statements.get(prop, [])
        if s.get("mainsnak", {}).get("datavalue")
    ]


def statement_items(statements, prop):
    return [v["id"] for v in statement_values(statements, prop) if isinstance(v, dict) and "id" in v]


def merge(pages, page):
    have = pages.setdefault(page["pageid"], {"pageid": page["pageid"], "title": page["title"]})
    if "imageinfo" in page:
        have["imageinfo"] = page["imageinfo"]
    for key in ("categories", "globalusage", "coordinates"):
        if key in page:
            have.setdefault(key, []).extend(page[key])


def to_record(page, mediainfo, labels):
    ii = (page.get("imageinfo") or [{}])[0]
    em = ii.get("extmetadata", {})
    statements = mediainfo.get("statements") or {}
    captions = {lang: c["value"] for lang, c in (mediainfo.get("labels") or {}).items()}

    def val(key):
        return str(em.get(key, {}).get("value", ""))

    coords = {}
    for c in page.get("coordinates", []):
        if c.get("globe", "earth") != "earth":
            continue
        kind = "camera" if c.get("type") == "camera" else "object"
        if c.get("lat") is None or c.get("lon") is None:
            continue
        # lat/lon of 0 are real places; only drop empty labels.
        coords.setdefault(kind, {k: c[k] for k in ("lat", "lon", "country", "region", "name")
                                 if k in ("lat", "lon") or c.get(k)})
    location = coords.get("camera") or coords.get("object")

    inception = [v["time"] for v in statement_values(statements, "P571") if isinstance(v, dict) and "time" in v]
    exif = {m["name"]: m["value"] for m in ii.get("commonmetadata", []) if m.get("name") in EXIF}
    usage = page.get("globalusage", [])

    record = {
        "pageid": page["pageid"],
        "title": page["title"].removeprefix("File:"),
        "file_page": ii.get("descriptionurl"),
        "caption": captions.get("en") or next(iter(captions.values()), None),
        "captions": captions,
        "description": text(val("ImageDescription")) or text(val("ObjectName")),
        "categories": [c["title"].removeprefix("Category:") for c in page.get("categories", [])],
        "assessments": [a for a in val("Assessments").split("|") if a],
        "date_taken": (inception[0].lstrip("+")[:10] if inception else None)
                      or text(val("DateTimeOriginal"))[:10] or None,
        "location": {"lat": location["lat"], "lon": location["lon"]} if location else None,
        "coordinates": coords,
        "exif": exif,
        "author": text(val("Artist")) or text(val("Credit")),
        "author_url": first_href(val("Artist")),
        "attribution": text(val("Attribution")) or None,
        "license": val("LicenseShortName"),
        "license_url": val("LicenseUrl") or None,
        "usage_terms": val("UsageTerms") or None,
        "attribution_required": val("AttributionRequired") == "true",
        "restrictions": [r for r in val("Restrictions").split("|") if r],
        "wikipedia": [
            {"wiki": g["wiki"], "title": g["title"], "url": g["url"]}
            for g in usage if g.get("wiki", "").endswith(".wikipedia.org")
        ],
        # Wikidata items that use this file (usually as their P18 image).
        "wikidata_items": labels.items(sorted({
            g["title"] for g in usage if g.get("wiki") == "www.wikidata.org" and re.fullmatch(r"Q\d+", g["title"])
        })),
        "mime": ii.get("mime"),
        "width": ii.get("width"),
        "height": ii.get("height"),
        "original_url": strip_query(ii.get("url")),
        "thumb_url": strip_query(ii.get("thumburl")),
    }
    for prop, field in ITEM_PROPS.items():
        record[field] = labels.items(statement_items(statements, prop))
    return record


def wanted_qids(page, mediainfo):
    statements = mediainfo.get("statements") or {}
    qids = [q for prop in ITEM_PROPS for q in statement_items(statements, prop)]
    qids += [
        g["title"] for g in page.get("globalusage", [])
        if g.get("wiki") == "www.wikidata.org" and re.fullmatch(r"Q\d+", g["title"])
    ]
    return qids


def harvest_meta(args, http, on_record=None):
    meta_path = os.path.join(args.out, "meta.ndjson")
    state_path = os.path.join(args.out, "meta.state.json")
    state = {"continue": {}, "done": False, "records": 0}
    if os.path.exists(state_path):
        with open(state_path) as f:
            state = json.load(f)
    if state["done"]:
        log(f"meta: already complete ({state['records']} records)")
        return

    api = Api(http)
    labels = Labels(api, os.path.join(args.out, "labels.ndjson"))
    cont = state["continue"]
    with open(meta_path, "a", encoding="utf-8") as out:
        while True:
            # One generator batch. Prop continuations (clcontinue, gucontinue...)
            # re-request the same 50 files until batchcomplete.
            pages = {}
            while True:
                data = api.query(COMMONS_API, {**QUERY, **cont})
                for page in data.get("query", {}).get("pages", []):
                    merge(pages, page)
                cont = data.get("continue", {})
                if data.get("batchcomplete") or not cont:
                    break

            # Structured data: captions and depicts/location/camera statements.
            entities = {}
            if pages:
                data = api.query(COMMONS_API, {
                    "action": "wbgetentities",
                    "ids": "|".join(f"M{pid}" for pid in pages),
                    "props": "labels|claims",
                })
                entities = data.get("entities", {})
            mediainfo = {pid: entities.get(f"M{pid}", {}) for pid in pages}
            labels.resolve(q for pid, page in pages.items() for q in wanted_qids(page, mediainfo[pid]))

            records = [to_record(page, mediainfo[pid], labels) for pid, page in pages.items()]
            for record in records:
                out.write(json.dumps(record, ensure_ascii=False) + "\n")
            out.flush()
            os.fsync(out.fileno())

            state = {"continue": cont, "done": not cont, "records": state["records"] + len(records)}
            with open(state_path + ".tmp", "w") as f:
                json.dump(state, f)
            os.replace(state_path + ".tmp", state_path)
            if state["records"] % 5000 < 50:
                log(f"meta: {state['records']} records")

            if on_record:
                for record in records:
                    on_record(record)
            if not cont:
                break
            if args.limit and state["records"] >= args.limit:
                log(f"meta: stopping at --limit, {state['records']} records")
                return
    log(f"meta: done, {state['records']} records")


# ------------------------------------------------------------------ images --

FREE = re.compile(r"^(cc0|cc[- ]by|public domain|pd\b|pd-)", re.I)
NONFREE = re.compile(r"\b(nc|nd)\b|non-?commercial|no-?deriv", re.I)


def license_ok(lic):
    return bool(FREE.search(lic or "")) and not NONFREE.search(lic or "")


def image_path(out, pageid):
    return os.path.join(out, "images", f"{pageid % 1000:03d}", f"{pageid}.webp")


class Gate:
    """Shared backoff: a 429 on one worker pauses them all."""

    def __init__(self):
        self.lock = threading.Lock()
        self.resume_at = 0.0

    def pause(self, seconds):
        with self.lock:
            self.resume_at = max(self.resume_at, time.monotonic() + seconds)

    def wait(self):
        while True:
            with self.lock:
                delay = self.resume_at - time.monotonic()
            if delay <= 0:
                return
            time.sleep(delay)


class ByteRate:
    """Spaces downloads so the average stays under bytes_per_sec."""

    def __init__(self, bytes_per_sec):
        self.rate = bytes_per_sec
        self.lock = threading.Lock()
        self.next_free = time.monotonic()

    def consume(self, n):
        with self.lock:
            now = time.monotonic()
            start = max(now, self.next_free)
            self.next_free = start + n / self.rate
        if start > now:
            time.sleep(start - now)


class RequestRate:
    """Adaptive request-rate cap shared by the media workers: halves on every
    429, then creeps back up 10% per 500 clean downloads, never above the start."""

    def __init__(self, per_hour):
        self.ceiling = per_hour / 3600
        self.rate = self.ceiling
        self.lock = threading.Lock()
        self.next_free = time.monotonic()
        self.clean = 0

    def wait(self):
        with self.lock:
            now = time.monotonic()
            start = max(now, self.next_free)
            self.next_free = start + 1 / self.rate
        if start > now:
            time.sleep(start - now)

    def throttled(self):
        with self.lock:
            self.rate = max(self.rate / 2, 600 / 3600)
            self.clean = 0
            rate = self.rate
        log(f"media: slowing to {rate * 3600:.0f} req/h")

    def succeeded(self):
        with self.lock:
            self.clean += 1
            if self.clean < 500 or self.rate >= self.ceiling:
                return
            self.clean = 0
            self.rate = min(self.rate * 1.1, self.ceiling)
            rate = self.rate
        log(f"media: speeding up to {rate * 3600:.0f} req/h")


def describe_429(err):
    """The headers and body say which limit tripped; worth seeing once."""
    headers = {k: v for k, v in err.headers.items() if k.lower().startswith(("x-ratelimit", "retry-after"))}
    try:
        body = text(err.read(2000).decode("utf-8", "replace"))[:300]
    except Exception:
        body = ""
    return f"{headers} {body}"


class Missing(Exception):
    pass


def save_webp(body, path, quality):
    img = Image.open(io.BytesIO(body))
    img.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGBA" if "A" in img.getbands() or "transparency" in img.info else "RGB")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    img.save(tmp, "WEBP", quality=quality, method=4)
    os.replace(tmp, path)


class Downloader:
    def __init__(self, args, http):
        self.args = args
        self.http = http
        self.gate = Gate()
        self.rate = ByteRate(args.mbps * 1e6 / 8)
        per_hour = args.per_hour or PER_HOUR[http.authenticated]
        log(f"media: starting at {per_hour:.0f} req/h")
        self.requests = RequestRate(per_hour)
        self.logged_429 = 0
        self.jobs = queue.Queue(maxsize=MEDIA_WORKERS * 50)
        self.lock = threading.Lock()
        self.seen = set()
        self.skipped = Counter()
        self.stats = Counter()
        self.queued = 0
        self.failures = open(os.path.join(args.out, "failures.ndjson"), "a", encoding="utf-8")
        self.started = time.monotonic()
        self.threads = [threading.Thread(target=self.worker, daemon=True) for _ in range(MEDIA_WORKERS)]
        for t in self.threads:
            t.start()

    def submit(self, r):
        """Queue one metadata record; blocks while the workers catch up."""
        if r["pageid"] in self.seen:
            return
        self.seen.add(r["pageid"])
        if not license_ok(r["license"]):
            self.skipped["licence: " + (r["license"] or "(none)")] += 1
        elif r["restrictions"] and not self.args.allow_restricted:
            self.skipped["restricted: " + "|".join(r["restrictions"])] += 1
        elif not r["thumb_url"] or not (r["mime"] or "").startswith("image/"):
            self.skipped["no image: " + str(r["mime"])] += 1
        elif os.path.exists(image_path(self.args.out, r["pageid"])):
            self.stats["existing"] += 1
        elif not self.args.limit or self.queued < self.args.limit:
            self.queued += 1
            self.jobs.put((r["pageid"], r["thumb_url"]))

    def fetch(self, url):
        for attempt in range(8):
            self.gate.wait()
            self.requests.wait()
            try:
                body = self.http.get(url)
                self.rate.consume(len(body))
                self.requests.succeeded()
                return body
            except urllib.error.HTTPError as e:
                if e.code in (404, 410):
                    raise Missing(f"HTTP {e.code}")
                if e.code == 429 or e.code >= 500:
                    delay = retry_after(e, min(60 * 2 ** attempt, 1800))
                    detail = ""
                    if e.code == 429:
                        self.requests.throttled()
                        if self.logged_429 < 3:
                            self.logged_429 += 1
                            detail = " " + describe_429(e)
                    log(f"media HTTP {e.code}; all workers pausing {delay:.0f}s{detail}")
                    self.gate.pause(delay)
                    continue
                raise
            except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
                delay = min(10 * 2 ** attempt, 600)
                log(f"media {e!r}; retrying in {delay}s")
                time.sleep(delay)
        raise RuntimeError("too many retries")

    def worker(self):
        while True:
            job = self.jobs.get()
            if job is None:
                return
            pageid, url = job
            try:
                save_webp(self.fetch(url), image_path(self.args.out, pageid), self.args.quality)
                outcome = "saved"
            except Exception as e:  # keep going; failures are retried next run
                outcome = "failed"
                with self.lock:
                    self.failures.write(json.dumps({"pageid": pageid, "url": url, "error": repr(e)}) + "\n")
                    self.failures.flush()
            with self.lock:
                self.stats[outcome] += 1
                done = self.stats["saved"] + self.stats["failed"]
                if done % 1000 == 0:
                    per_sec = done / (time.monotonic() - self.started)
                    log(f"images: {done} fetched ({self.stats['failed']} failed), {per_sec:.1f}/s")

    def finish(self):
        for _ in self.threads:
            self.jobs.put(None)
        for t in self.threads:
            t.join()
        self.failures.close()
        log(f"images: {self.stats['saved']} saved, {self.stats['existing']} already present, "
            f"{self.stats['failed']} failed, {sum(self.skipped.values())} skipped")
        for reason, n in self.skipped.most_common(10):
            log(f"  skipped {n:>7}  {reason}")


def existing_records(args):
    path = os.path.join(args.out, "meta.ndjson")
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            for line in f:
                yield json.loads(line)


def main():
    load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("phase", nargs="?", choices=["all", "meta", "images"], default="all")
    p.add_argument("--contact", default=os.environ.get("WIKIMEDIA_CONTACT"),
                   help="email or URL for the User-Agent (required by Wikimedia policy)")
    p.add_argument("--out", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "commons-qi"))
    p.add_argument("--mbps", type=float, default=20.0, help="media bandwidth cap (policy max 25)")
    p.add_argument("--per-hour", type=float, default=0,
                   help="starting media request rate; halves on each 429 and recovers slowly "
                        f"(default {PER_HOUR[True]} logged in, {PER_HOUR[False]} anonymous)")
    p.add_argument("--quality", type=int, default=82, help="WebP quality")
    p.add_argument("--limit", type=int, default=0,
                   help="stop after about this many records/images, for a trial run (0 = all)")
    p.add_argument("--allow-restricted", action="store_true",
                   help="keep files tagged with personality-rights/trademark/etc. restrictions")
    args = p.parse_args()
    if not args.contact:
        p.error("--contact (or WIKIMEDIA_CONTACT) is required")
    if args.mbps > 25:
        p.error("--mbps over 25 breaks Wikimedia's robot policy")

    os.makedirs(args.out, exist_ok=True)
    http = Http(args.contact)
    http.login()
    try:
        if args.phase == "meta":
            harvest_meta(args, http)
            return
        # Images download while metadata is still being harvested.
        downloader = Downloader(args, http)
        for record in existing_records(args):
            downloader.submit(record)
        if args.phase == "all":
            harvest_meta(args, http, on_record=downloader.submit)
        downloader.finish()
    except KeyboardInterrupt:
        log("interrupted; rerun to resume")
        sys.exit(130)


if __name__ == "__main__":
    main()
