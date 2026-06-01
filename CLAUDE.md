# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Bonsai Search — a "10 blue links" book search demo. Indexes ~70k Project Gutenberg books via OpenSearch with full-text search, faceted filtering, relevance tuning, and pagination. Built with Express 5, OpenSearch 3.5, and EJS templates.

## Commands

All app commands run from `app/`:

```bash
npm install                              # install deps
npm run dev                              # dev server with --watch and .env loading
npm start                                # production start
```

Re-index data (from `books/`):

```bash
source ../.env
bash index.sh                            # drops + recreates index, bulk-loads 32 shard files
```

No test framework, linter config, or build step exists. `flake.nix` provides eslint_d and prettierd via Nix but they aren't configured with project rules.

## Environment

- Requires `BONSAI_URL` env var (OpenSearch cluster URL with credentials)
- `PORT` defaults to 4444
- `.env` at repo root (gitignored); `app/.env.example` is the template
- Nix users: `direnv allow` loads the dev shell

## Architecture

### Multi-Dataset, Config-Driven Design

The server dynamically loads every `app/datasets/*.js` file at startup. Each config defines the full search behavior for a dataset: query clauses, score functions, aggregations, and display rendering. Routes are parameterized as `/:dataset` and `/:dataset/search`. Adding a new dataset = adding a new config file.

### Query Pipeline (`app/search.js`)

`search.js` is a generic query builder — it reads a dataset config and produces an OpenSearch `function_score` query:

1. Builds `bool.should` clauses from `config.query.clauses` (supports `match_phrase` and `multi_match`)
2. Wraps in `function_score` with `field_value_factor` if `config.query.scoreFunction` exists
3. Builds aggregations from `config.aggregations` (terms, range, histogram types)
4. Applies sidebar filter selections as `bool.filter` clauses (no score impact)

The query builder has its own OpenSearch `Client` instance separate from the one in `server.js`.

### Index Schema (`books/books-index.json`)

Two custom analyzers:
- `analyze_english` — full English stemming for recall
- `analyze_english_precise` — possessive-only stemming for phrase matching

Fields use `copy_to` to populate `*_precise` variants. Phrase queries target precise fields; cross-field queries target both. A 768-dim `summaries_embedding` vector field exists but is unused in queries.

### Display Config

Each dataset config has a `display` object with functions for title, link URL, image, subtitles, snippets, and tags. EJS templates (`app/templates/`) call these functions to render results.

### Aggregation/Filter Symmetry

Each entry in `config.aggregations` drives both the OpenSearch aggregation request and the sidebar filter logic. Filter types (terms with boolean coercion, range with named buckets, histogram with interval math) are handled generically in `search.js`.
