# Bonsai Search

A "10 blue links" book search demo built with Express, OpenSearch, and EJS. Indexes ~70,000 Project Gutenberg books and provides full-text search with faceted filtering, relevance tuning, and pagination.

## Project Structure

```
app/
  server.js              Express server, routes, OpenSearch client
  search.js              Query builder with relevance tuning and filter logic
  templates/
    index.ejs             Landing page (search box)
    results.ejs           Results page (hits, sidebar filters, pagination)
    _result-tile.ejs      Picture grid tile (image, score, metadata)
    compare.ejs           Blind A/B similarity eval page
    _compare-card.ejs     Card partial for the compare columns
  public/
    css/
      index.css           Landing page styles (light/dark/forest themes)
      results.css         Results page styles (two-column layout, responsive)
      fonts.css            @font-face declarations (Fraunces, Inter)
      fonts/              Self-hosted woff2 font files
    img/
      logo.svg            Bonsai brand logo
      book.svg            Fallback cover image
  datasets/
    books.js              Books dataset config (full-text + relevance tuning)
    music.js              Music dataset config (Chinook data, permissions)
    pictures.js           Pictures dataset config (multimodal kNN, grid layout)
  package.json            Dependencies: express 5.1, opensearch 3.5, ejs 5.0
  Procfile                Heroku start command
  app.json                Heroku deployment manifest
books/
  books-index.json        OpenSearch index mapping and analyzer config
  index.sh                Bash script to create index and bulk-load data
  bulk/                   32 sharded NDJSON files (books-00..books-31)
  books.ndjson            Combined bulk data (gitignored, download separately)
pictures/
  pictures-index.json      OpenSearch index mapping (kNN vector field)
  index-lg.sh              Build the `pictures` index (1152-dim embeddings)
  index.sh                 Build the `pictures-sm` index (768-dim embeddings)
  pictures.ndjson          Bulk data: base64 images + embedding vectors
  compare-results.ndjson   Blind A/B eval log (created at runtime, gitignored)
render.yaml               Render.com deployment config
flake.nix                 Nix dev shell (Node 24, eslint_d, prettierd)
.envrc                    direnv: `use flake`
```

## Setup

### Prerequisites

- Node.js 24.x
- An OpenSearch cluster (or a [Bonsai](https://bonsai.io) managed cluster)

### Environment

Copy the example env file and set your cluster URL:

```bash
cp app/.env.example .env
# edit .env: BONSAI_URL=https://user:pass@your-cluster:443
```

The app reads `BONSAI_URL` for the OpenSearch connection. `PORT` defaults to 4444.

The **Pictures** and **Multimodal** datasets live on a separate cluster read from
`BONSAI_MULTIMODAL_URL`, which embeds query text server-side. See
[Multimodal Image Search](#multimodal-image-search-pictures).

### Index the Data

```bash
cd books
source ../.env
bash index.sh
```

This deletes any existing `books` index, creates a new one from `books-index.json`, then bulk-loads all 32 shard files from `bulk/`.

To index the **Pictures** dataset:

```bash
cd pictures
source ../.env
bash index-lg.sh    # pictures    — 1152-dim embeddings
bash index.sh       # pictures-sm — 768-dim embeddings (for /compare)
```

Each script recreates its index and bulk-loads `pictures.ndjson`, split into
chunks (the file carries base64 images plus embedding vectors, so it is sent in
smaller requests rather than one large payload). `pictures` alone is enough to run
the app; `pictures-sm` is only needed for the [blind A/B eval](#blind-similarity-comparison-ab-eval).

### Run the App

```bash
cd app
npm install
npm run dev    # uses --env-file=../.env --watch
```

Or with Nix:

```bash
direnv allow   # loads flake.nix dev shell
cd app && npm install && npm run dev
```

## Routes

Routes are parameterized by dataset (`books`, `music`, `pictures`). Each is driven
by a config file in `app/datasets/`; adding a dataset means adding a config.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Redirects to `/books` |
| GET | `/:dataset` | Landing page with search form (e.g. `/pictures`) |
| GET | `/:dataset/search?q=...` | Search results (e.g. `/pictures/search?q=eiffel+tower`) |
| GET | `/:dataset/similar?id=...` | Image-to-image similarity (kNN datasets only, e.g. `/pictures/similar?id=clipart_309_000002.jpg`) |
| GET | `/:dataset/count` | Document count for the dataset's index (JSON) |
| GET | `/:dataset/autocomplete?q=...` | Suggestions and matching images as you type (JSON; datasets with an `autocomplete` config, i.e. Multimodal) |
| GET | `/compare` | Blind A/B similarity eval of two picture indices (see below) |
| POST | `/compare/choose` | Records a preference and loads the next comparison |
| GET | `/health` | OpenSearch cluster health (JSON) |

### Search Parameters

| Param | Type | Description |
|-------|------|-------------|
| `q` | string | Search query (required) |
| `page` | integer | Page number, default 1 (10 results per page) |
| `subjects` | string[] | Filter by subject |
| `authors` | string[] | Filter by author name |
| `bookshelves` | string[] | Filter by bookshelf/category |
| `languages` | string[] | Filter by language code |
| `media_type` | string[] | Filter by media type |
| `copyright` | string[] | `"true"` or `"false"` |
| `popularity` | string[] | `low`, `moderate`, `popular`, `very_popular` |
| `author_era` | string[] | Century start year (e.g. `1800`) |

## Search Architecture

### Query Structure

`search.js` builds a `function_score` query that combines text relevance with popularity:

```
function_score
  query: bool.should (OR)
    match_phrase on title_precise        (boost 2.0)
    match_phrase on summaries_precise     (boost 1.4)
    match_phrase on author_names          (boost 1.4, slop 1)
    cross_fields on all precise fields    (boost 1.2)
    cross_fields on title + summaries     (boost 1.0)
    cross_fields on page                  (boost 1.0)
  field_value_factor: log1p(download_count)
  boost_mode: sum
```

Filters (subjects, authors, etc.) are applied as `bool.filter` clauses so they narrow results without affecting relevance scores.

### Text Analysis

Two custom analyzers defined in `books-index.json`:

- **`analyze_english`** -- standard tokenizer, HTML strip, lowercase, English stop words, English stemmer. Used by `title` and `summaries` fields.
- **`analyze_english_precise`** -- same pipeline but with possessive-English stemmer only (lighter). Used by `title_precise` and `summaries_precise` (populated via `copy_to`).

Phrase queries target the precise fields for exact matching; cross-field queries hit both for recall.

### Aggregations

Every search request computes these facets (returned as sidebar filter counts):

| Aggregation | Field | Type |
|-------------|-------|------|
| subjects | subjects.keyword | terms (top 20) |
| authors | author_names.keyword | terms (top 20) |
| bookshelves | bookshelves.keyword | terms (top 20) |
| languages | languages | terms (top 20) |
| media_type | media_type | terms (top 10) |
| copyright | copyright | terms |
| popularity | download_count | range (4 buckets) |
| author_era | author_birth_years | histogram (100-year intervals) |

### Pagination

The server parses `?page=N`, computes `from = (page - 1) * 10`, and passes it to OpenSearch as `body.from`. The template renders a sliding window of up to 7 page numbers with prev/next arrows and ellipsis.

## Multimodal Image Search (Pictures)

The **Pictures** dataset (`/pictures`) does vector image search: type a text query
to get a grid of matching images (text-to-image), or click any result to find
visually similar images (image-to-image). Results are ranked by vector similarity.
No facets or filters.

### Text-to-image pipeline

1. `search.js` builds an OpenSearch `knn` query against the
   `img__bonsai_multimodal_01` field, passing the raw query string as `vector`.
2. The `BONSAI_MULTIMODAL_URL` cluster embeds the text server-side and runs the
   vector search.
3. Hits carry `img` (base64 JPEG), `width`, `height`, and `path`. The vector
   field is excluded from `_source` to keep responses small.
4. `results.ejs` renders a responsive grid (max 4 tiles per row) of
   `_result-tile.ejs` cards showing the image, its similarity score, dimensions,
   and source folder. Each tile links to that image's similarity search.

The dataset config lives in `app/datasets/pictures.js`
(`query.type: "knn"`, `display.layout: "grid"`, `perPage: 20`). This is the same
config-driven mechanism used by `books`/`music`; only the query type and display
layout differ.

### Image-to-image similarity

Clicking a tile navigates to `/:dataset/similar?id=<doc id>`, which finds images
similar to an existing one — no embedding service call needed, since the query
vector comes from the index:

1. `searchSimilar()` in `search.js` fetches the clicked document by id and reads
   its stored `img__bonsai_multimodal_01` vector.
2. It runs the same `knn` query with that vector.
3. The document's own self-match is filtered out, then re-inserted at the front of
   the first page with score `1.0`. So the clicked image **always appears first**
   at similarity `1.0`, even if approximate-nearest-neighbor recall would have
   dropped it. (In practice the L2 self-match already scores exactly `1.0` and
   sorts first; the explicit prepend just guarantees it.)

The same grid renders the results, with the source image marked by a "Source
image" badge. Clicking any neighbor pivots the similarity search onto it.

### Embeddable search (iframe)

`/embed/pictures` and `/embed/multimodal` are chrome-less versions of those
searches for embedding in a marketing page: search box, example-query chips, a
12-image grid and Prev/Next paging, all kept inside the frame. With no `?q=` it
opens on results for the first example query, so the frame is never blank. `?q=`
sets the initial query. A `layout: "grid"` dataset opts in with an
`embed: { examples: [...] }` block in its config; other datasets 404.

What a click does depends on the dataset:

- **Multimodal** (has an `asset` config): facet filters beside the results, and
  tiles open `/embed/multimodal/asset?id=`, the in-frame asset page with the
  photo, metadata and similar-images pane. Its back link returns to the exact
  filtered results page. `embed.facets` picks and orders the facets shown,
  `embed.facetSize` trims rows per facet, and `embed.openFacets` sets how many
  start expanded, so the sidebar stays about as tall as the results.
- **Pictures**: tiles run image-to-image similarity in the frame.

```html
<iframe id="bonsai-search" src="https://<app-host>/embed/pictures"
        title="Image search demo" loading="lazy"
        style="width:100%;height:1260px;border:0"></iframe>
<script>
  // Optional: resize the iframe to its content (no inner scrollbar).
  var frame = document.getElementById("bonsai-search");
  window.addEventListener("message", function (e) {
    if (e.origin !== "https://<app-host>" || !e.data) return;
    if (e.data.type === "bonsai-embed:height") {
      frame.style.height = e.data.height + "px";
    }
    // Optional: after a click inside the frame, bring its top back into view.
    if (e.data.type === "bonsai-embed:navigate" && frame.getBoundingClientRect().top < 0) {
      frame.scrollIntoView({ behavior: "smooth" });
    }
  });
</script>
```

Each page posts `{type: "bonsai-embed:height", height}` to its parent whenever its
height changes, and `{type: "bonsai-embed:navigate", path}` once per load. Without
the navigate handler, clicking a tile far down the grid opens the asset page with
the host still scrolled to that spot. Inside the frame, `vh` units and sticky
positioning are swapped for fixed values (`embed.css`), since the frame's height
tracks its content. The body is transparent so the host background shows through.
Page size is `EMBED_PER_PAGE` in `server.js`.

Framing is allowed from any origin by default (`Content-Security-Policy:
frame-ancestors *`). Set `EMBED_FRAME_ANCESTORS` to restrict it, e.g.
`EMBED_FRAME_ANCESTORS="https://bonsai.io https://*.bonsai.io"`.

### Pagination caveat

OpenSearch reports kNN `hits.total` as candidates matched across segments (up to
`k` per segment), not the top-k actually reachable. To keep paging honest:

- Every page requests the same fixed candidate pool, `k = query.paginationDepth`
  (200 for Pictures), so the ranking doesn't shift as you page.
- `hits.total` is clamped to `paginationDepth`, and the last page is trimmed to fit.
- Each request sets `preference` derived from the query text (or the clicked doc
  id for similarity). ANN results can differ between replicas, so without this,
  consecutive pages could hit different copies and duplicate or skip items.
  Hybrid (Multimodal) searches use the same preference routing.

### Autocomplete

Multimodal's search boxes (home, results, asset page and the embed) suggest
completions as you type, following
[How to *really* scale autocomplete](https://bonsai.io/blog/how-to-really-scale-autocomplete/).
`caption` and `depicts.label` are copied at index time into three suggest
fields (`multimodal/wikimedia-index.json`):

- `completions`: `search_as_you_type`, queried with `match_phrase_prefix` to
  pick the matching images (top 4, shown with thumbnails).
- `suggest_phrase`: 2–4 word shingles; a `terms` agg with an `include` regex
  on the typed prefix proposes phrase completions.
- `suggest_word`: single words; `significant_terms` completes a lone word.

Both aggregations run only over the documents the prefix matched, which keeps
them cheap. The suggest analyzers drop stopwords and leave a `_` filler in
shingles that span one; typed stopwords are matched against the filler and
shown as typed. The client (`app/public/js/autocomplete.js`) waits for a 50 ms
pause in typing, cancels stale requests, caches each prefix, and supports
arrow keys, Enter and Escape. Responses are sent with `Cache-Control: max-age=300`.

Caveats:

- The aggregations use `fielddata` on text fields, about 100 MB of heap per
  node for this index. It loads on the first request after a restart or
  eviction, which can then take around 3 s.
- The post recommends a separate autocomplete index. These fields live in
  `wikimedia` alongside the vectors, so autocomplete shares the hybrid
  search's shards.
- There is no popularity signal (the post ranks by `views`), so image matches
  are ordered by match score alone.

### Content flags

`multimodal/content_flags.py` flags images whose text has profanity, hate
speech, sexual content or nudity, as a `content_flags` column in the Parquet
dataset and a keyword field in the index. Multimodal's `query.exclude`
(`exists: content_flags`) keeps every flagged image out of search results,
facet counts, similar images and autocomplete. A flagged asset page still opens
by direct URL. After changing the rules or `content-flags-overrides.json`, refresh
the dataset and the live index (partial updates, no re-embedding):

```bash
uv run multimodal/commons-qi-flags.py --update-index
```

## Blind Similarity Comparison (A/B Eval)

`/compare` is a blind A/B harness for judging two image-embedding models against
each other on image-to-image similarity. It compares two indices with identical
document ids but different embeddings — by default `pictures` (1152-dim) vs
`pictures-sm` (768-dim, a smaller model). The pair is hardcoded at the top of the
route in `server.js` (`COMPARE_A` / `COMPARE_B`).

### Flow

1. `GET /compare` picks a random document id (uniform, via `random_score`).
2. For **each** index it loads that doc's stored `emb` and fetches the top-5
   nearest neighbors (self-match excluded).
3. If the two neighbor id lists are identical (same ids, same order), the round is
   auto-logged as `"identical"` and a new id is drawn — the user is never shown a
   tie (capped at 25 redraws, after which a "try again" page renders).
4. A coin toss decides which index's results go in the **left** vs **right**
   column, so the layout reveals nothing about which model is which.
5. Each column shows the source image (badged `Source`) followed by its 5 nearest
   neighbors, ranked `#1`–`#5`. Similarity **scores are intentionally hidden** —
   the two models have different score scales, so showing them would bias a blind
   visual preference. Rank position is shown instead.
6. The user clicks **Prefer Left**, **Prefer Right**, or **Neutral** (no
   preference — either result set is fine). `POST /compare/choose` resolves the
   choice to its index (or records neutrality), appends a record, and redirects to
   `/compare` for the next round.

### Result log

Preferences are appended as NDJSON (one JSON object per line) to
`pictures/compare-results.ndjson`:

```json
{
  "timestamp": "2026-07-29T12:23:52.077Z",
  "source_id": "clipart_278_000145.jpg",
  "left_index": "pictures-sm",
  "left_ids": ["clipart_125_000189.jpg", "..."],
  "right_index": "pictures",
  "right_ids": ["clipart_125_000130.jpg", "..."],
  "choice": "left",
  "preferred": "pictures-sm"
}
```

`choice` is what the user clicked — `left`, `right`, `neutral` (saw a difference
but had no preference), or `null` for an auto-logged tie. `preferred` is the
resolved value:

| `choice` | `preferred` | Meaning |
|----------|-------------|---------|
| `left` / `right` | the chosen index name | User preferred that index's results |
| `neutral` | `"neutral"` | Results differed, but user was happy with either |
| `null` | `"identical"` | Both indices returned the same top-5 (auto-logged, not shown) |

### Blindness caveat

Blindness is enforced at the UI level only: the left/right → index mapping is
carried in hidden form fields, so it is visible to anyone who opens browser
devtools. That is fine for self-evaluation; for tamper-resistant blinding the
mapping would need to live server-side behind an opaque token.

### Setup

Both indices share the same schema and bulk file; they differ only in the
embedding model. Build them from `pictures/`:

```bash
cd pictures
source ../.env
bash index-lg.sh     # creates and loads pictures    (1152-dim)
bash index.sh        # creates and loads pictures-sm  (768-dim)
```

## Index Schema

The `books` index maps each Project Gutenberg book with:

- **Text fields**: `title`, `summaries` (English-analyzed), `title_precise`, `summaries_precise` (light stemming)
- **People**: `author_names`, `editor_names`, `translator_names` (text + keyword sub-field), `*_birth_years`, `*_death_years` (short)
- **Categories**: `subjects`, `bookshelves` (text + keyword), `languages`, `media_type` (keyword)
- **Metadata**: `gutenberg_id` (keyword), `copyright` (boolean), `download_count` (integer), `formats` (disabled object)
- **Vector**: `summaries_embedding` (768-dim KNN vector, FAISS HNSW, not used in current search queries)

## Deployment

### Heroku

```bash
cd app
heroku create
heroku config:set BONSAI_URL=https://...
git push heroku main
```

Uses `Procfile` (`web: npm start`) and `app.json`.

### Render

Push the repo; Render auto-detects `render.yaml`. Set `OPENSEARCH_URL` in the dashboard. Health checks hit `/health`.

## CSS Themes

`index.css` defines three color themes via CSS custom properties:

- **Light** (default): `--bg: #fbfdfa`, green accents
- **Dark**: `--bg: #0b1a1c`, inverted palette
- **Forest**: `--bg: #0e2a20`, deep green tint

`results.css` uses the light theme. Responsive breakpoint at 880px collapses the sidebar into a toggleable panel.
