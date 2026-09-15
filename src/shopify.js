// Data layer: pulls qualifying collections + their product tags out of Shopify.
//
// Three modes (env SITEMAP_FETCH_MODE):
//   bulk       (default) - one async Bulk Operation, download JSONL. Best at scale.
//   paginated            - loop collections + products via GraphQL. Reliable, more calls.
//   mock                 - read test/mock-data.json. No network, for local testing.
//
// Returns a normalized array:
//   [{ handle, updatedAt, productTags: Set<string> }, ...]
// already filtered to qualifying + published collections.

import { readFile } from "node:fs/promises";

const API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-07";

function adminEndpoint() {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  if (!domain) throw new Error("SHOPIFY_STORE_DOMAIN is required (e.g. your-store.myshopify.com).");
  return `https://${domain}/admin/api/${API_VERSION}/graphql.json`;
}

function authHeaders() {
  const token = process.env.SHOPIFY_ADMIN_TOKEN;
  if (!token) throw new Error("SHOPIFY_ADMIN_TOKEN is required.");
  return { "X-Shopify-Access-Token": token, "Content-Type": "application/json" };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gql(query, variables = {}) {
  const res = await fetch(adminEndpoint(), {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json;
}

// ---- helpers shared across modes ---------------------------------------------

function collectionQualifies(node, settings) {
  const keys = settings.tierMetafields.keys;
  const values = keys.map((_, i) => node[`tier${i + 1}`]?.value?.trim());
  const populated = values.map((v) => !!v);
  const qualifies = settings.requireAllTiers ? populated.every(Boolean) : populated.some(Boolean);
  if (!qualifies) return false;
  if (settings.onlyPublishedCollections && node.publishedOnCurrentPublication === false) return false;
  return true;
}

function productCountsForTags(product, settings) {
  if (settings.onlyActiveProducts && product.status && product.status !== "ACTIVE") return false;
  if (settings.onlyPublishedCollections && product.publishedOnCurrentPublication === false) return false;
  return true;
}

// ---- BULK mode ---------------------------------------------------------------

const BULK_QUERY = `
{
  collections {
    edges { node {
      id
      handle
      updatedAt
      publishedOnCurrentPublication
      tier1: metafield(namespace: "%NS%", key: "%K1%") { value }
      tier2: metafield(namespace: "%NS%", key: "%K2%") { value }
      tier3: metafield(namespace: "%NS%", key: "%K3%") { value }
      products {
        edges { node {
          id
          status
          publishedOnCurrentPublication
          tags
        } }
      }
    } }
  }
}`;

async function runBulk(settings, log) {
  const ns = settings.tierMetafields.namespace;
  const [k1, k2, k3] = settings.tierMetafields.keys;
  const inner = BULK_QUERY.replace(/%NS%/g, ns).replace("%K1%", k1).replace("%K2%", k2).replace("%K3%", k3);

  const start = await gql(`
    mutation ($q: String!) {
      bulkOperationRunQuery(query: $q) {
        bulkOperation { id status }
        userErrors { field message }
      }
    }`, { q: inner });

  const errs = start.data.bulkOperationRunQuery.userErrors;
  if (errs.length) {
    throw new Error(
      `Bulk operation rejected: ${JSON.stringify(errs)}\n` +
      `If a field (e.g. metafield args or publishedOnCurrentPublication) is not allowed in bulk ` +
      `on API ${API_VERSION}, set SITEMAP_FETCH_MODE=paginated.`
    );
  }

  // poll
  let url = null;
  for (let i = 0; i < 240; i++) { // up to ~40 min at 10s
    await sleep(10000);
    const cur = await gql(`{ currentBulkOperation { id status errorCode objectCount url } }`);
    const op = cur.data.currentBulkOperation;
    log(`  bulk status: ${op.status} (objects: ${op.objectCount || 0})`);
    if (op.status === "COMPLETED") { url = op.url; break; }
    if (["FAILED", "CANCELED", "EXPIRED"].includes(op.status)) {
      throw new Error(`Bulk operation ${op.status} (errorCode: ${op.errorCode}).`);
    }
  }
  if (!url) throw new Error("Bulk operation did not complete in time.");

  const jsonl = await (await fetch(url)).text();
  return parseBulkJsonl(jsonl, settings);
}

function parseBulkJsonl(jsonl, settings) {
  // JSONL: collection lines (id gid://shopify/Collection/...) and product lines
  // (have __parentId pointing at their collection).
  const collections = new Map(); // id -> node
  const productsByParent = new Map(); // parentId -> [product,...]

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line);
    if (typeof obj.id === "string" && obj.id.includes("/Collection/")) {
      collections.set(obj.id, obj);
    } else if (obj.__parentId) {
      if (!productsByParent.has(obj.__parentId)) productsByParent.set(obj.__parentId, []);
      productsByParent.get(obj.__parentId).push(obj);
    }
  }

  const out = [];
  for (const [id, node] of collections) {
    if (!collectionQualifies(node, settings)) continue;
    const tags = new Set();
    for (const p of productsByParent.get(id) || []) {
      if (!productCountsForTags(p, settings)) continue;
      for (const t of p.tags || []) tags.add(t);
    }
    out.push({ handle: node.handle, updatedAt: node.updatedAt, productTags: tags });
  }
  return out;
}

// ---- PAGINATED mode ----------------------------------------------------------

async function runPaginated(settings, log) {
  const ns = settings.tierMetafields.namespace;
  const [k1, k2, k3] = settings.tierMetafields.keys;
  const out = [];
  let after = null;

  for (;;) {
    const q = `
      query ($after: String) {
        collections(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          edges { node {
            id handle updatedAt publishedOnCurrentPublication
            tier1: metafield(namespace: "${ns}", key: "${k1}") { value }
            tier2: metafield(namespace: "${ns}", key: "${k2}") { value }
            tier3: metafield(namespace: "${ns}", key: "${k3}") { value }
          } }
        }
      }`;
    const page = await gql(q, { after });
    const conn = page.data.collections;
    for (const { node } of conn.edges) {
      if (!collectionQualifies(node, settings)) continue;
      const tags = await collectTagsForCollection(node.id, settings);
      out.push({ handle: node.handle, updatedAt: node.updatedAt, productTags: tags });
      log(`  ${node.handle}: ${tags.size} tag(s)`);
    }
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}

async function collectTagsForCollection(collectionId, settings) {
  const tags = new Set();
  let after = null;
  for (;;) {
    const q = `
      query ($id: ID!, $after: String) {
        collection(id: $id) {
          products(first: 250, after: $after) {
            pageInfo { hasNextPage endCursor }
            edges { node { status publishedOnCurrentPublication tags } }
          }
        }
      }`;
    const page = await gql(q, { id: collectionId, after });
    const conn = page.data.collection.products;
    for (const { node } of conn.edges) {
      if (!productCountsForTags(node, settings)) continue;
      for (const t of node.tags || []) tags.add(t);
    }
    // cost-based backoff
    const cost = page.extensions?.cost?.throttleStatus;
    if (cost && cost.currentlyAvailable < 200) await sleep(1500);
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return tags;
}

// ---- MOCK mode ---------------------------------------------------------------

async function runMock(settings) {
  const raw = JSON.parse(await readFile(new URL("../test/mock-data.json", import.meta.url), "utf8"));
  // mock-data mirrors the bulk node shape
  return raw.collections
    .filter((c) => collectionQualifies(c, settings))
    .map((c) => {
      const tags = new Set();
      for (const p of c.products || []) {
        if (!productCountsForTags(p, settings)) continue;
        for (const t of p.tags || []) tags.add(t);
      }
      return { handle: c.handle, updatedAt: c.updatedAt, productTags: tags };
    });
}

// ---- entry -------------------------------------------------------------------

export async function fetchQualifyingCollections(settings, log = () => {}) {
  const mode = process.env.SITEMAP_FETCH_MODE || "bulk";
  log(`Fetch mode: ${mode}`);
  if (mode === "mock") return runMock(settings);
  if (mode === "paginated") return runPaginated(settings, log);
  return runBulk(settings, log);
}

export default fetchQualifyingCollections;
