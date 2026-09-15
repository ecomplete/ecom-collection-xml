// Orchestrates: fetch data -> build URLs -> shard -> write sitemap + index + report.
//
// Required env:
//   STOREFRONT_DOMAIN      host used in <loc>, e.g. www.pepstores.com  (no scheme, no trailing slash)
// For live modes also:
//   SHOPIFY_STORE_DOMAIN   admin host, e.g. your-store.myshopify.com
//   SHOPIFY_ADMIN_TOKEN    Admin API access token (scope: read_products)
// Optional:
//   SHOPIFY_API_VERSION    default 2025-07
//   SITEMAP_FETCH_MODE     bulk (default) | paginated | mock
//   OUTPUT_DIR             default dist

import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fetchQualifyingCollections } from "./shopify.js";
import { buildExcluder } from "./exclusions.js";
import { handleize } from "./handleize.js";

const log = (...a) => console.log(...a);

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function loadJson(rel) {
  return JSON.parse(await readFile(new URL(rel, import.meta.url), "utf8"));
}

async function main() {
  const settings = await loadJson("../config/settings.json");
  const exclusionsCfg = await loadJson("../config/tag-exclusions.json");
  const isExcluded = buildExcluder(exclusionsCfg);

  const storefront = (process.env.STOREFRONT_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!storefront) throw new Error("STOREFRONT_DOMAIN is required (e.g. www.pepstores.com).");

  const outDir = process.env.OUTPUT_DIR || "dist";
  const base = `https://${storefront}`;

  log(`Building level-4 sitemap for ${base}`);
  const collections = await fetchQualifyingCollections(settings, log);
  log(`Qualifying collections: ${collections.length}`);

  // Build URL records: one per (collection, non-excluded tag), deduped.
  const seen = new Set();
  const records = [];
  let excludedCount = 0;
  const excludedSample = new Set();

  for (const col of collections) {
    const lastmod = col.updatedAt || new Date().toISOString();
    for (const rawTag of col.productTags) {
      if (isExcluded(rawTag)) {
        excludedCount++;
        if (excludedSample.size < 100) excludedSample.add(rawTag);
        continue;
      }
      const tagHandle = handleize(rawTag);
      if (!tagHandle) continue;
      const loc = `${base}/collections/${col.handle}/${tagHandle}`;
      if (seen.has(loc)) continue;
      seen.add(loc);
      records.push({ loc, lastmod });
    }
  }

  // Deterministic order -> stable diffs.
  records.sort((a, b) => (a.loc < b.loc ? -1 : a.loc > b.loc ? 1 : 0));
  log(`Level-4 URLs: ${records.length}  (excluded tag-occurrences: ${excludedCount})`);

  // Fresh output dir.
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const perFile = settings.sitemap.urlsPerFile || 45000;
  const shards = records.length ? chunk(records, perFile) : [[]];
  const shardFiles = [];

  for (let i = 0; i < shards.length; i++) {
    const name = `${settings.sitemap.shardPrefix}-${i + 1}.xml`;
    const body =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      shards[i].map((r) =>
        `  <url>\n    <loc>${xmlEscape(r.loc)}</loc>\n    <lastmod>${xmlEscape(r.lastmod)}</lastmod>\n  </url>`
      ).join("\n") +
      `\n</urlset>\n`;
    await writeFile(path.join(outDir, name), body, "utf8");
    if (settings.sitemap.gzip) await writeFile(path.join(outDir, name + ".gz"), gzipSync(body));
    shardFiles.push(name);
  }

  // Sitemap index.
  const now = new Date().toISOString();
  const indexBody =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    shardFiles.map((f) =>
      `  <sitemap>\n    <loc>${xmlEscape(`${base}/${f}`)}</loc>\n    <lastmod>${now}</lastmod>\n  </sitemap>`
    ).join("\n") +
    `\n</sitemapindex>\n`;
  await writeFile(path.join(outDir, settings.sitemap.indexFileName), indexBody, "utf8");

  // Machine-readable report (used by validate.js drift guard + for humans).
  const report = {
    generatedAt: now,
    storefront: base,
    qualifyingCollections: collections.length,
    totalUrls: records.length,
    shards: shardFiles.length,
    excludedTagOccurrences: excludedCount,
    excludedSample: [...excludedSample].sort(),
  };
  await writeFile(path.join(outDir, "report.json"), JSON.stringify(report, null, 2), "utf8");

  log(`Wrote ${shardFiles.length} shard(s) + ${settings.sitemap.indexFileName} to ${outDir}/`);
  log(`Report: ${JSON.stringify(report, null, 2)}`);
}

main().catch((e) => {
  console.error("BUILD FAILED:", e.message);
  process.exit(1);
});
