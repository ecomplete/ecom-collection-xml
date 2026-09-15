# PEP level-4 sitemap generator

Generates an XML sitemap of **level-4** URLs — the tag-filtered collection pages
(`/collections/{handle}/{tag}`) that Shopify's native `/sitemap.xml` never lists.
Runs daily on GitHub Actions, commits the generated files back into the repo
(`dist/`), and also uploads them as a workflow artifact.

> **Hosting is deliberately out of scope for now.** This phase just *generates* the
> XML on GitHub so we can inspect it. Serving it to search engines (a subdomain →
> GitHub/Cloudflare Pages, the `robots.txt.liquid` `Sitemap:` directive) and the
> theme canonical audit are the planned next step — see the design doc and
> "Next step" below.

## How it works

1. Pulls every collection with the three tier metafields populated
   (`custom.collection_1st_tier/2nd/3rd`), plus the product tags in each.
2. Turns each **non-excluded** product tag into
   `https://{STOREFRONT_DOMAIN}/collections/{handle}/{handleized-tag}`.
3. Deduplicates, sorts, shards (≤45k URLs/file), and writes a sitemap index.
4. Validates the output, then commits `dist/` back to the repo.

Deriving URLs from real product tags means every URL resolves to a non-empty grid
(no soft-404s). The exclusion list keeps colour/size/price filter tags out.

## Repo layout

```
config/
  settings.json        tier metafield keys, qualifying rules, shard size, gzip toggle
  tag-exclusions.json  exact / prefix / regex exclusions (edit this to tune noise)
src/
  build-sitemap.js     orchestrator (fetch -> URLs -> shard -> write)
  shopify.js           data layer: bulk (default) | paginated | mock
  handleize.js         Shopify-style tag -> URL slug
  exclusions.js        exclusion matcher
  validate.js          post-build gate (well-formed, non-empty, drift guard)
test/
  mock-data.json       offline sample data
  handleize.test.js    handleize unit tests
.github/workflows/
  build-sitemap.yml    daily cron + manual trigger
dist/                  generated output (committed by the Action)
```

## Configure on GitHub

**Settings → Secrets and variables → Actions**

Repository **secrets**:
- `SHOPIFY_STORE_DOMAIN` — admin host, e.g. `your-store.myshopify.com`
- `SHOPIFY_ADMIN_TOKEN` — Admin API access token (custom app, scope **`read_products`**)

Repository **variables**:
- `STOREFRONT_DOMAIN` — host for `<loc>`, e.g. `www.pepstores.com` (must match your live canonical host exactly, incl. `www`)
- `SHOPIFY_API_VERSION` — e.g. `2025-07`

Create the token via **Settings → Apps and sales channels → Develop apps → Create an app**,
grant Admin API scope `read_products`, install, and copy the Admin API access token.

## Run it

- **Manually:** Actions tab → *Build level-4 sitemap* → *Run workflow* (pick `mock` first to smoke-test with no token, then `bulk`).
- **Daily:** already scheduled at 01:00 UTC (03:00 SAST).

## Run locally

```bash
# offline, no Shopify needed:
npm run build:mock && npm run validate

# against the real store:
cp .env.example .env   # fill in values
set -a; . ./.env; set +a
npm run build && npm run validate

# unit tests:
npm test
```

## Fetch modes (`SITEMAP_FETCH_MODE`)

- `bulk` *(default)* — one async Bulk Operation, best at PEP scale.
- `paginated` — plain GraphQL paging; use if a field is rejected inside a bulk query on your API version.
- `mock` — reads `test/mock-data.json`; no network.

## Tuning the noise

Edit `config/tag-exclusions.json`. Matching is on the **raw** tag, case-insensitive:
- `exact` — whole-tag matches
- `prefix` — namespaced facets like `colour:`, `size:`, `price:`
- `regex` — e.g. pure numbers, `R199` price tags

Each run prints how many tag-occurrences were excluded and a sample, so new filter-tag
families are easy to spot. `dist/report.json` records the same.

## Validation gate

`src/validate.js` fails the run (nothing gets committed) if output is missing,
malformed, empty, or the URL count swings more than `DRIFT_MAX_PCT` (default 25%)
vs the last run. Override once with `DRIFT_MAX_PCT=0` when a big change is expected.

## Next step (not done here)

1. Theme audit: self-referencing canonical + indexable robots on the tier pages
   (otherwise Google crawls but won't index them).
2. Host `dist/` on a `sitemaps.` subdomain (GitHub/Cloudflare Pages).
3. Add `Sitemap:` to `robots.txt.liquid` and submit in Search Console.

See `level4-sitemap-design.md` for the full rationale.
