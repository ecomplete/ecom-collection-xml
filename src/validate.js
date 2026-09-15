// Post-build validation gate. Dependency-free (no xmllint needed).
// Fails (exit 1) on: no output, malformed XML shell, zero URLs, or a URL-count
// swing beyond the drift threshold vs the last committed count.
//
// Usage: node src/validate.js [outputDir]
// Env:
//   DRIFT_MAX_PCT   default 25   (0 disables the drift guard)
//   PREV_COUNT_FILE default .last-count.json  (committed between runs)

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const outDir = process.argv[2] || process.env.OUTPUT_DIR || "dist";
const driftMax = Number(process.env.DRIFT_MAX_PCT ?? 25);
const prevFile = process.env.PREV_COUNT_FILE || ".last-count.json";

function fail(msg) { console.error("VALIDATION FAILED:", msg); process.exit(1); }

async function main() {
  let files;
  try { files = await readdir(outDir); }
  catch { return fail(`output dir '${outDir}' not found — did the build run?`); }

  const shardFiles = files.filter((f) => f.endsWith(".xml") && f.includes("level4"));
  const indexFile = files.find((f) => f === "sitemap-index.xml");
  if (!indexFile) return fail("sitemap-index.xml missing.");
  if (shardFiles.length === 0) return fail("no shard .xml files found.");

  let totalUrls = 0;
  for (const f of shardFiles) {
    const xml = await readFile(path.join(outDir, f), "utf8");
    if (!xml.startsWith("<?xml")) return fail(`${f} does not start with an XML declaration.`);
    if (!xml.includes("<urlset") || !xml.includes("</urlset>")) return fail(`${f} urlset element malformed.`);
    const opens = (xml.match(/<url>/g) || []).length;
    const closes = (xml.match(/<\/url>/g) || []).length;
    const locs = (xml.match(/<loc>/g) || []).length;
    if (opens !== closes || opens !== locs) return fail(`${f} has unbalanced <url>/<loc> tags.`);
    totalUrls += locs;
  }

  const idx = await readFile(path.join(outDir, indexFile), "utf8");
  if (!idx.includes("<sitemapindex") || !idx.includes("</sitemapindex>")) return fail("index element malformed.");

  console.log(`OK: ${shardFiles.length} shard(s), ${totalUrls} URL(s).`);

  if (totalUrls === 0) return fail("zero URLs — refusing to publish an empty sitemap.");

  // Drift guard vs last committed count.
  if (driftMax > 0) {
    let prev = null;
    try { prev = JSON.parse(await readFile(prevFile, "utf8")).totalUrls; } catch { /* first run */ }
    if (prev != null && prev > 0) {
      const pct = Math.abs(totalUrls - prev) / prev * 100;
      console.log(`Drift vs last run (${prev}): ${pct.toFixed(1)}% (max ${driftMax}%).`);
      if (pct > driftMax) {
        return fail(`URL count moved ${pct.toFixed(1)}% (from ${prev} to ${totalUrls}), over the ${driftMax}% threshold. ` +
          `Re-run with DRIFT_MAX_PCT=0 to override once you've confirmed the change is expected.`);
      }
    } else {
      console.log("No previous count on record — skipping drift guard (first run).");
    }
  }

  await writeFile(prevFile, JSON.stringify({ totalUrls, at: new Date().toISOString() }, null, 2), "utf8");
  console.log("Validation passed.");
}

main().catch((e) => fail(e.message));
