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

1. Pulls **every published collection** in the store.
2. For collections that have all three tier metafields populated
   (`custom.collection_1st_tier/2nd/3rd`) — the "3rd-tier" collections — it also reads
   their product tags and turns each **non-excluded** tag into a 4th-tier URL
   `https://{STOREFRONT_DOMAIN}/collections/{handle}/{handleized-tag}`.
3. Writes the sitemap **grouped**: each collection's own URL, with its 4th-tier URLs
   listed directly beneath it, preceded by a comment showing the tier breadcrumb.
4. Deduplicates, shards (≤45k URLs/file, groups kept intact), writes a sitemap index.
5. Validates the output, then commits `dist/` back to the repo.

Deriving 4th-tier URLs from real product tags means every one resolves to a non-empty
grid (no soft-404s). The exclusion list keeps colour/size/price filter tags out.

"Published" is checked against the **Online Store** publication when the token can read
it; otherwise the build falls back to the app's current-publication flag and logs a
warning (see scopes below).

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

## Get Shopify credentials (current method)

Shopify no longer lets you create admin custom apps from **Settings → Apps → Develop apps**
(existing ones still work). New apps are made in the **Dev Dashboard** and authenticate with
the **client_credentials** grant — the app has a Client ID + Client secret, which the build
exchanges for a short-lived Admin API token on each run. The app and the store must be in the
**same Shopify organization**.

1. In the **Dev Dashboard** (dev.shopify.com), create an app in your organization.
2. Configure Admin API **access scopes**: `read_products` (required — covers collections,
   their metafields, and product tags) and `read_publications` (recommended — for the
   accurate Online Store "published" check).
3. **Install** the app on the PEP store.
4. In the app's **Settings**, copy the **Client ID** and **Client secret**.

(If you already have a legacy admin-created custom app, its static `shpat_...` token still
works — set `SHOPIFY_ADMIN_TOKEN` instead of the client id/secret and the exchange is skipped.)

## Configure on GitHub

**Settings → Secrets and variables → Actions**

Repository **secrets**:
- `SHOPIFY_STORE_DOMAIN` — admin host, e.g. `your-store.myshopify.com`
- `SHOPIFY_CLIENT_ID` — Dev Dashboard app Client ID
- `SHOPIFY_CLIENT_SECRET` — Dev Dashboard app Client secret
- *(or, legacy)* `SHOPIFY_ADMIN_TOKEN` — static `shpat_...` token, used instead of the id/secret

Repository **variables**:
- `STOREFRONT_DOMAIN` — host for `<loc>`, e.g. `www.pepstores.com` (must match your live canonical host exactly, incl. `www`)
- `SHOPIFY_API_VERSION` — e.g. `2025-07`

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
