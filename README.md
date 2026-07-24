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
  templates/
    _result-tile.ejs      Picture grid tile (image, similarity score, metadata)
  package.json            Dependencies: express 5.1, opensearch 3.5, ejs 5.0
  Procfile                Heroku start command
  app.json                Heroku deployment manifest
books/
  books-index.json        OpenSearch index mapping and analyzer config
  index.sh                Bash script to create index and bulk-load data
  bulk/                   32 sharded NDJSON files (books-00..books-31)
  books.ndjson            Combined bulk data (gitignored, download separately)
pictures/
  pictures-index.json     OpenSearch index mapping (kNN vector field)
  index.sh                Bash script to create index and bulk-load images
  pictures.ndjson         Bulk data: base64 images + 1152-dim embeddings
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

The **Pictures** dataset additionally needs an embedding service for multimodal
search. It reads `EMBED_URL` (default `http://127.0.0.1:5100/embed`) — a service
that accepts `POST {"inputs": "<text>"}` and returns a batch of vectors
(`[[0.3, 1.9, ...]]`). See [Multimodal Image Search](#multimodal-image-search-pictures).

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
bash index.sh
```

This recreates the `pictures` index and bulk-loads `pictures.ndjson`, splitting it
into 100-line chunks (the file carries base64 images + 1152-dim vectors, so it is
sent in smaller requests rather than one large payload).

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
| GET | `/:dataset/count` | Document count for the dataset's index (JSON) |
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

The **Pictures** dataset (`/pictures`) does text-to-image search: you type a text
query and get back a grid of visually similar images, ranked by vector similarity.
No facets or filters.

### Pipeline

1. The query string is sent to the embedding service (`EMBED_URL`) as
   `POST {"inputs": "<query>"}`, which returns a dense vector (`[[...]]`).
2. `search.js` builds an OpenSearch `knn` query against the `emb` field
   (1152-dim HNSW vector) with that vector.
3. Hits carry `img` (base64 JPEG), `width`, `height`, and `path`. `emb` is
   excluded from `_source` to keep responses small.
4. `results.ejs` renders a responsive grid (max 4 tiles per row) of
   `_result-tile.ejs` cards showing the image, its similarity score, dimensions,
   and source folder.

The dataset config lives in `app/datasets/pictures.js`
(`query.type: "knn"`, `display.layout: "grid"`, `perPage: 20`). This is the same
config-driven mechanism used by `books`/`music`; only the query type and display
layout differ.

### Pagination caveat

Pagination "works" but is semantically loose for kNN. OpenSearch reports
`hits.total` as the number of candidate docs matched across segments, not the
top-k actually returned — so the displayed result count is a kNN artifact rather
than a true match count. Each "page" is just a lower slice of the same ranked
similarity list. Deep paging also requires `k >= from + size`, so later pages
request larger candidate pools. For a top-k similarity demo, a fixed top-N view is
arguably more honest than pagination.

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
