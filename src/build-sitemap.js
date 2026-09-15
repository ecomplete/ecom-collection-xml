// Orchestrates: fetch collections -> build grouped URLs -> shard -> write sitemap + index + report.
//
// Output layout: every published collection URL, grouped. For a qualifying (3rd-tier)
// collection, its 4th-tier tag URLs are listed directly beneath it. Each group is
// preceded by an XML comment (the tier breadcrumb, or the handle) for readability.
//
// Required env:
//   STOREFRONT_DOMAIN      host used in <loc>, e.g. www.pepstores.com
// For live modes also: SHOPIFY_STORE_DOMAIN, SHOPIFY_ADMIN_TOKEN
// Optional: SHOPIFY_API_VERSION, SITEMAP_FETCH_MODE (bulk|paginated|mock), OUTPUT_DIR

import { readFile, mkdir, writeFile, rm } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { fetchCollections, fetchSeoOverrides, overrideKey } from "./shopify.js";
import { buildExcluder } from "./exclusions.js";
import { handleize } from "./handleize.js";

const log = (...a) => console.log(...a);

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

async function loadJson(rel) {
  return JSON.parse(await readFile(new URL(rel, import.meta.url), "utf8"));
}

function urlBlock(loc, lastmod) {
  return `  <url>\n    <loc>${xmlEscape(loc)}</loc>\n    <lastmod>${xmlEscape(lastmod)}</lastmod>\n  </url>`;
}

async function main() {
  const settings = await loadJson("../config/settings.json");
  const exclusionsCfg = await loadJson("../config/tag-exclusions.json");
  const isExcluded = buildExcluder(exclusionsCfg);

  const storefront = (process.env.STOREFRONT_DOMAIN || "").replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!storefront) throw new Error("STOREFRONT_DOMAIN is required (e.g. www.pepstores.com).");
  const base = `https://${storefront}`;
  const outDir = process.env.OUTPUT_DIR || "dist";

  log(`Building sitemap for ${base}`);
  const collections = await fetchCollections(settings, log);
  log(`Published collections: ${collections.length}`);
  const overrides = await fetchSeoOverrides(settings, log);

  // Build one group per collection: [comment, ...urlBlocks].
  collections.sort((a, b) => (a.handle < b.handle ? -1 : a.handle > b.handle ? 1 : 0));

  const seen = new Set();
  const groups = []; // { comment, blocks:[string], count:number }
  let collectionUrls = 0, tagUrls = 0, excludedCount = 0, qualifying = 0;
  let noindexSkipped = 0, canonicalSkipped = 0;
  const excludedSample = new Set();

  for (const col of collections) {
    const lastmod = col.updatedAt || new Date().toISOString();
    const blocks = [];

    // 3rd-tier (or any) collection's own URL.
    const colLoc = `${base}/collections/${col.handle}`;
    if (!seen.has(colLoc)) {
      seen.add(colLoc);
      blocks.push(urlBlock(colLoc, lastmod));
      collectionUrls++;
    }

    // 4th-tier tag URLs, only for qualifying collections.
    if (col.qualifies) {
      qualifying++;
      const tagLocs = [];
      for (const rawTag of col.productTags) {
        if (isExcluded(rawTag)) {
          excludedCount++;
          if (excludedSample.size < 100) excludedSample.add(rawTag);
          continue;
        }
        const h = handleize(rawTag);
        if (!h) continue;

        // Respect the SEO Tag Overrides metaobject: never list a page that
        // de-indexes itself or canonicals elsewhere. Default (no entry) = index.
        const ov = overrides.get(overrideKey(col.handle, rawTag));
        if (ov) {
          if (ov.noindex) { noindexSkipped++; continue; }
          if (ov.canonicalOverride) { canonicalSkipped++; continue; }
        }

        const loc = `${base}/collections/${col.handle}/${h}`;
        if (seen.has(loc)) continue;
        seen.add(loc);
        tagLocs.push(loc);
      }
      tagLocs.sort();
      for (const loc of tagLocs) { blocks.push(urlBlock(loc, lastmod)); tagUrls++; }
    }

    if (blocks.length === 0) continue;
    const label = col.qualifies && col.breadcrumb.some(Boolean)
      ? col.breadcrumb.filter(Boolean).join(" > ")
      : col.handle;
    groups.push({ comment: `  <!-- ${xmlEscape(label)} -->`, blocks, count: blocks.length });
  }

  const totalUrls = collectionUrls + tagUrls;
  log(`URLs: ${totalUrls} (${collectionUrls} collections + ${tagUrls} 4th-tier). ` +
      `Qualifying: ${qualifying}. Excluded tags: ${excludedCount}. ` +
      `Skipped noindex: ${noindexSkipped}, canonical-override: ${canonicalSkipped}.`);

  // Pack groups into shards without splitting a group (unless a single group exceeds the cap).
  const perFile = settings.sitemap.urlsPerFile || 45000;
  const shards = [];
  let cur = [], curCount = 0;
  for (const g of groups) {
    if (curCount > 0 && curCount + g.count > perFile) { shards.push(cur); cur = []; curCount = 0; }
    cur.push(g); curCount += g.count;
  }
  if (cur.length || shards.length === 0) shards.push(cur);

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const shardFiles = [];
  for (let i = 0; i < shards.length; i++) {
    const name = `${settings.sitemap.shardPrefix}-${i + 1}.xml`;
    const inner = shards[i].map((g) => `${g.comment}\n${g.blocks.join("\n")}`).join("\n\n");
    const body =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
      inner +
      `\n</urlset>\n`;
    await writeFile(path.join(outDir, name), body, "utf8");
    if (settings.sitemap.gzip) await writeFile(path.join(outDir, name + ".gz"), gzipSync(body));
    shardFiles.push(name);
  }

  const now = new Date().toISOString();
  const indexBody =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    shardFiles.map((f) =>
      `  <sitemap>\n    <loc>${xmlEscape(`${base}/${f}`)}</loc>\n    <lastmod>${now}</lastmod>\n  </sitemap>`
    ).join("\n") +
    `\n</sitemapindex>\n`;
  await writeFile(path.join(outDir, settings.sitemap.indexFileName), indexBody, "utf8");

  const report = {
    generatedAt: now,
    storefront: base,
    publishedCollections: collections.length,
    qualifyingCollections: qualifying,
    collectionUrls,
    fourthTierUrls: tagUrls,
    totalUrls,
    shards: shardFiles.length,
    seoOverridesLoaded: overrides.size,
    skippedNoindex: noindexSkipped,
    skippedCanonicalOverride: canonicalSkipped,
    excludedTagOccurrences: excludedCount,
    excludedSample: [...excludedSample].sort(),
  };
  await writeFile(path.join(outDir, "report.json"), JSON.stringify(report, null, 2), "utf8");

  log(`Wrote ${shardFiles.length} shard(s) + ${settings.sitemap.indexFileName} to ${outDir}/`);
  log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error("BUILD FAILED:", e.message);
  process.exit(1);
});
