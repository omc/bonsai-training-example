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
  package.json            Dependencies: express 5.1, opensearch 3.5, ejs 5.0
  Procfile                Heroku start command
  app.json                Heroku deployment manifest
books/
  books-index.json        OpenSearch index mapping and analyzer config
  index.sh                Bash script to create index and bulk-load data
  bulk/                   32 sharded NDJSON files (books-00..books-31)
  books.ndjson            Combined bulk data (gitignored, download separately)
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

### Index the Data

```bash
cd books
source ../.env
bash index.sh
```

This deletes any existing `books` index, creates a new one from `books-index.json`, then bulk-loads all 32 shard files from `bulk/`.

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

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Landing page with search form |
| GET | `/search?q=...` | Search results with filters and pagination |
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
