"""Content flags for the Commons Quality Images dataset.

Rule-based screening of each image's text: title, captions (every language),
description, Commons categories and depicts labels. Flags:

    profanity  swearing, slurs and obscene gestures in the text
    hate       hate speech and hate symbols
    sexual     explicit or erotic subject matter
    nudity     nude or topless people in photos and drawings; nude statues,
               paintings and frescoes are not flagged

An image may carry several flags. The rules match whole words and drop known
false positives (place names, species, words in other languages), so they're
a starting point for human review, not a verdict: they miss images whose text
is clean but whose picture isn't.

`classify(row)` takes a row shaped like the Parquet schema in
commons-qi-parquet.py (captions as [{lang, text}], depicts as [{id, label}])
and returns (flags, reasons), each a sorted list of strings.

Review decisions go in content-flags-overrides.json next to this file:
    {"<pageid>": ["profanity"], "<pageid>": []}
An entry replaces the rule result for that image; [] clears it.
"""

import json
import os
import re

FLAGS = ("profanity", "hate", "sexual", "nudity")

PROFANITY_TEXT = re.compile(
    r"(?<![\w-])(fuck|fucking|fucked|fucker|motherfucker|shit|shitty|bullshit|cunts?|twat|"
    r"wanker|asshole|faggots?|nigger\w*|bastard|bitch|ass|pussy|damn)(?!\w)", re.I)
# Context around a match that makes it innocent.
PROFANITY_DENY = re.compile(
    r"Fucking,? Austria|Duspatalin|bastard grunt|Bastard-Schwarz|De Bastard|bastard son|"
    r"bastard poon|Bastard of Hyacinth|bastard of the german|bitch is dead|Labrador bitch|"
    r"pussy willow|Pussy toes", re.I)
# "ass" is nearly always a donkey or Luxembourgish "is"; these two are not.
ASS_ALLOW = {115230251, 25784126}
PROFANITY_LABEL = re.compile(
    r"^(Profanity|English-language slang|French-language (profanity|slang)|Shit \(text\)|"
    r"Fuck .*\(text\)|Graffiti of the word fuck|The finger \(gesture\).*|"
    r"\"Grab them by the pussy\".*)$")

HATE_TEXT = re.compile(r"homophobic graffiti|anti LGBT", re.I)
HATE_LABEL = re.compile(r"^(Nazi symbols|Neo-Nazi.*|Graffiti of swastikas|Homophob.*)$", re.I)

SEXUAL_TEXT = re.compile(
    r"(?<!\w)(sex ?tape|sextape|sexy|boobie|sex sells|vaginal lubrication|corkscrew penis|"
    r"pornoproduzentin|Der Porno)(?!\w)", re.I)
SEXUAL_LABEL = re.compile(
    r"genital|\bpenis|\bvulva|\bvagina\b|vaginal|intercourse|creampie|\berotic|pornograph|"
    r"\bporn|BDSM|dildo|cock ring|orgasm|sex toy|masturbat|^Sex in|Outdoor sex|Sexuality on|"
    r"Sex business|Red-light district", re.I)
SEXUAL_LABEL_DENY = re.compile(
    r"Elephant|Primate|Hemipenis|Intercourse, Pennsylvania|Thetys vagina|Coronilla vaginalis|"
    r"(Mecoptera|Geometridae|Lepidoptera|Insect) genital", re.I)

NUDITY_LABEL = re.compile(r"\b(nude|naked|nudity|topless|toplessness|nipples?|breasts?)\b", re.I)
NUDITY_DENY = re.compile(
    r"painting|fresco|engraving|coins|in art|ideal form|by Amedeo|Naked Neck|Naked Creek|"
    r"Naked Now|chicken|Breast-patterned|Nudity in|Naked woman E\d|^nude$|nude with Cat|"
    r"Nude on a Blue|sitting$|Nude archers|Nude people with blue|"
    r"Nude or partially nude people with tambourines|Madonna|sculpture|statue|relief|mosaic|"
    r"bronze|fountain|breast cancer|breaststroke|breast pocket|Breast-shaped|breastfeed|"
    r"breastwork|breast badge|naked choke|Naked Bike|"
    r"Topless (men|male|adolescent|recumbent men|standing men)|topless man|"
    r"Male (human )?nipples|Bather by", re.I)


def _texts(row):
    yield "title", row.get("title") or ""
    yield "caption", row.get("caption") or ""
    for c in row.get("captions") or []:
        if c.get("lang") != "en":
            yield f"caption ({c.get('lang')})", c.get("text") or ""
    yield "description", row.get("description") or ""


def _labels(row):
    for c in row.get("categories") or []:
        yield "category", c
    for d in row.get("depicts") or []:
        yield "depicts", d.get("label") or ""


def _snippet(text, m, width=40):
    a, b = max(0, m.start() - width), min(len(text), m.end() + width)
    return ("…" if a else "") + text[a:b].strip() + ("…" if b < len(text) else "")


def classify(row):
    found = {}

    def add(flag, reason):
        found.setdefault(flag, set()).add(reason)

    pageid = row.get("pageid")
    for field, text in _texts(row):
        for m in PROFANITY_TEXT.finditer(text):
            if m.group(1).lower() == "ass" and pageid not in ASS_ALLOW:
                continue
            if PROFANITY_DENY.search(text[max(0, m.start() - 60):m.end() + 60]):
                continue
            add("profanity", f"{field}: {_snippet(text, m)}")
        for m in SEXUAL_TEXT.finditer(text):
            add("sexual", f"{field}: {_snippet(text, m)}")
        for m in HATE_TEXT.finditer(text):
            add("hate", f"{field}: {_snippet(text, m)}")
    for field, label in _labels(row):
        if PROFANITY_LABEL.search(label):
            add("profanity", f"{field}: {label}")
        if HATE_LABEL.search(label):
            add("hate", f"{field}: {label}")
        if SEXUAL_LABEL.search(label) and not SEXUAL_LABEL_DENY.search(label):
            add("sexual", f"{field}: {label}")
        if NUDITY_LABEL.search(label) and not NUDITY_DENY.search(label):
            add("nudity", f"{field}: {label}")

    flags = [f for f in FLAGS if f in found]
    reasons = sorted(f"{flag}: {r}" for flag in flags for r in found[flag])
    return flags, reasons


def load_overrides(path=None):
    path = path or os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "content-flags-overrides.json")
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        raw = json.load(f)
    bad = {k: v for k, v in raw.items() if not set(v) <= set(FLAGS)}
    if bad:
        raise ValueError(f"unknown flags in {path}: {bad}")
    return {int(k): list(v) for k, v in raw.items()}


def apply(row, overrides):
    """(flags, reasons) for a row, with any review override taking precedence."""
    flags, reasons = classify(row)
    if row["pageid"] in overrides:
        flags = [f for f in FLAGS if f in overrides[row["pageid"]]]
        reasons = [r for r in reasons if r.split(":", 1)[0] in flags] + ["reviewed"]
    return flags, reasons


# Dataset card text, shared by commons-qi-parquet.py and the backfill.
CARD_COLUMNS = """| `content_flags` | list[string] | `profanity`, `hate`, `sexual`, `nudity`; empty for most rows (see below) |
| `content_flag_reasons` | list[string] | `flag: field: matched text` for each flag |
"""


def card_section(counts, rows):
    lines = "\n".join(f"| `{f}` | {counts.get(f, 0):,} |" for f in FLAGS)
    flagged = counts.get("_any", 0)
    return f"""## Content flags

Commons is a general-purpose archive, so a small share of images have
profanity, slurs or sexual content in their text or subject. `content_flags`
marks them ({flagged:,} of {rows:,} rows) so they can be filtered out:

| Flag | Images |
|---|---|
{lines}

The flags come from rules over each row's title, captions, description,
categories and depicts labels, with known false positives removed (place
names, species, words in other languages) and per-image review decisions
applied. They screen text only, so an image whose text is clean but whose picture
isn't will not be flagged. Nude statues, paintings and frescoes are not
flagged as `nudity`.

"""
