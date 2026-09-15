// Data layer: pulls collections (+ product tags for qualifying ones) out of Shopify.
//
// Modes (env SITEMAP_FETCH_MODE):
//   bulk       (default) - one async Bulk Operation, download JSONL. Best at scale.
//   paginated            - loop collections + products via GraphQL. Reliable, more calls.
//   mock                 - read test/mock-data.json. No network, for local testing.
//
// Returns a normalized array of ALL published collections:
//   [{ handle, updatedAt, published, qualifies, breadcrumb:[t1,t2,t3], productTags:Set }]
// Only qualifying collections (all three tier metafields set) carry productTags.

import { readFile } from "node:fs/promises";

const API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-07";

function adminEndpoint() {
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  if (!domain) throw new Error("SHOPIFY_STORE_DOMAIN is required (e.g. your-store.myshopify.com).");
  return `https://${domain}/admin/api/${API_VERSION}/graphql.json`;
}

// Auth. Two supported credential styles:
//   1. Dev Dashboard app (current): SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET are
//      exchanged for a short-lived Admin API token via the client_credentials grant
//      each run. Requires the app and store to be in the same Shopify organization.
//   2. Legacy static token: SHOPIFY_ADMIN_TOKEN (shpat_...) used as-is, if you still
//      have an existing admin-created custom app (Shopify no longer lets you make new ones).
let ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN || null;

async function ensureAccessToken(log = () => {}) {
  if (ACCESS_TOKEN) return ACCESS_TOKEN;
  const id = process.env.SHOPIFY_CLIENT_ID;
  const secret = process.env.SHOPIFY_CLIENT_SECRET;
  const domain = process.env.SHOPIFY_STORE_DOMAIN;
  if (!id || !secret) {
    throw new Error("Provide SHOPIFY_ADMIN_TOKEN, or SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (client_credentials).");
  }
  if (!domain) throw new Error("SHOPIFY_STORE_DOMAIN is required.");
  const res = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: id, client_secret: secret, grant_type: "client_credentials" }),
  });
  if (!res.ok) throw new Error(`Token exchange failed (HTTP ${res.status}): ${await res.text()}`);
  const json = await res.json();
  ACCESS_TOKEN = json.access_token;
  if (!ACCESS_TOKEN) throw new Error(`Token exchange returned no access_token: ${JSON.stringify(json)}`);
  log(`Obtained Admin API token via client_credentials (expires in ~${Math.round((json.expires_in || 0) / 3600)}h).`);
  return ACCESS_TOKEN;
}

function authHeaders() {
  if (!ACCESS_TOKEN) throw new Error("Access token not initialized — call ensureAccessToken() first.");
  return { "X-Shopify-Access-Token": ACCESS_TOKEN, "Content-Type": "application/json" };
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

// ---- shared normalization ----------------------------------------------------

function tierValues(node, settings) {
  return settings.tierMetafields.keys.map((_, i) => node[`tier${i + 1}`]?.value?.trim() || "");
}

function qualifies(node, settings) {
  const populated = tierValues(node, settings).map((v) => !!v);
  return settings.requireAllTiers ? populated.every(Boolean) : populated.some(Boolean);
}

// Prefer the explicit Online Store publication check when we requested it (`pub`);
// otherwise fall back to the app's current publication.
function isPublished(node) {
  return node.pub !== undefined && node.pub !== null ? node.pub : node.publishedOnCurrentPublication;
}

function productCounts(product, settings) {
  if (settings.onlyActiveProducts && product.status && product.status !== "ACTIVE") return false;
  if (settings.onlyPublishedCollections && isPublished(product) === false) return false;
  return true;
}

function normalizeCollection(node, settings) {
  return {
    handle: node.handle,
    updatedAt: node.updatedAt,
    published: isPublished(node) !== false, // treat unknown as published
    qualifies: qualifies(node, settings),
    breadcrumb: tierValues(node, settings),
    productTags: new Set(),
  };
}

// ---- Online Store publication id (optional, best-effort) ---------------------

async function getOnlineStorePublicationId(settings, log) {
  const wantName = settings.publicationName || "Online Store";
  try {
    const r = await gql(`{ publications(first: 50) { edges { node { id name } } } }`);
    const hit = r.data.publications.edges.find((e) => e.node.name === wantName);
    if (hit) { log(`Online Store publication: ${hit.node.id}`); return hit.node.id; }
    log(`Publication "${wantName}" not found; falling back to current-publication check.`);
  } catch (e) {
    log(`Could not read publications (${e.message.split("\n")[0]}); ` +
        `falling back to current-publication check. Add read_publications scope for accuracy.`);
  }
  return null;
}

// ---- BULK mode ---------------------------------------------------------------

function buildBulkQuery(settings, pubId) {
  const ns = settings.tierMetafields.namespace;
  const [k1, k2, k3] = settings.tierMetafields.keys;
  const pubField = pubId ? `pub: publishedOnPublication(publicationId: "${pubId}")` : "";
  return `
{
  collections {
    edges { node {
      id
      handle
      updatedAt
      publishedOnCurrentPublication
      ${pubField}
      tier1: metafield(namespace: "${ns}", key: "${k1}") { value }
      tier2: metafield(namespace: "${ns}", key: "${k2}") { value }
      tier3: metafield(namespace: "${ns}", key: "${k3}") { value }
      products {
        edges { node {
          id
          status
          publishedOnCurrentPublication
          ${pubField}
          tags
        } }
      }
    } }
  }
}`;
}

async function runBulk(settings, log) {
  const pubId = await getOnlineStorePublicationId(settings, log);
  const inner = buildBulkQuery(settings, pubId);

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
      `If a field is not allowed in bulk on API ${API_VERSION}, set SITEMAP_FETCH_MODE=paginated.`
    );
  }

  let url = null;
  for (let i = 0; i < 240; i++) {
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
  const collections = new Map();     // id -> normalized collection
  const productsByParent = new Map(); // collectionId -> [productNode]

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    const obj = JSON.parse(line);
    if (typeof obj.id === "string" && obj.id.includes("/Collection/")) {
      collections.set(obj.id, { node: obj, norm: normalizeCollection(obj, settings) });
    } else if (obj.__parentId) {
      if (!productsByParent.has(obj.__parentId)) productsByParent.set(obj.__parentId, []);
      productsByParent.get(obj.__parentId).push(obj);
    }
  }

  const out = [];
  for (const [id, { norm }] of collections) {
    if (settings.onlyPublishedCollections && norm.published === false) continue;
    if (norm.qualifies) {
      for (const p of productsByParent.get(id) || []) {
        if (!productCounts(p, settings)) continue;
        for (const t of p.tags || []) norm.productTags.add(t);
      }
    }
    out.push(norm);
  }
  return out;
}

// ---- PAGINATED mode ----------------------------------------------------------

async function runPaginated(settings, log) {
  const pubId = await getOnlineStorePublicationId(settings, log);
  const ns = settings.tierMetafields.namespace;
  const [k1, k2, k3] = settings.tierMetafields.keys;
  const pubField = pubId ? `pub: publishedOnPublication(publicationId: "${pubId}")` : "";
  const out = [];
  let after = null;

  for (;;) {
    const q = `
      query ($after: String) {
        collections(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          edges { node {
            id handle updatedAt publishedOnCurrentPublication ${pubField}
            tier1: metafield(namespace: "${ns}", key: "${k1}") { value }
            tier2: metafield(namespace: "${ns}", key: "${k2}") { value }
            tier3: metafield(namespace: "${ns}", key: "${k3}") { value }
          } }
        }
      }`;
    const page = await gql(q, { after });
    const conn = page.data.collections;
    for (const { node } of conn.edges) {
      const norm = normalizeCollection(node, settings);
      if (settings.onlyPublishedCollections && norm.published === false) continue;
      if (norm.qualifies) norm.productTags = await collectTags(node.id, settings, pubField);
      out.push(norm);
      log(`  ${norm.handle}${norm.qualifies ? ` (${norm.productTags.size} tag[s])` : ""}`);
    }
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}

async function collectTags(collectionId, settings, pubField) {
  const tags = new Set();
  let after = null;
  for (;;) {
    const q = `
      query ($id: ID!, $after: String) {
        collection(id: $id) {
          products(first: 250, after: $after) {
            pageInfo { hasNextPage endCursor }
            edges { node { status publishedOnCurrentPublication ${pubField} tags } }
          }
        }
      }`;
    const page = await gql(q, { id: collectionId, after });
    const conn = page.data.collection.products;
    for (const { node } of conn.edges) {
      if (!productCounts(node, settings)) continue;
      for (const t of node.tags || []) tags.add(t);
    }
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
  const out = [];
  for (const c of raw.collections) {
    const norm = normalizeCollection(c, settings);
    if (settings.onlyPublishedCollections && norm.published === false) continue;
    if (norm.qualifies) {
      for (const p of c.products || []) {
        if (!productCounts(p, settings)) continue;
        for (const t of p.tags || []) norm.productTags.add(t);
      }
    }
    out.push(norm);
  }
  return out;
}

// ---- entry -------------------------------------------------------------------

export async function fetchCollections(settings, log = () => {}) {
  const mode = process.env.SITEMAP_FETCH_MODE || "bulk";
  log(`Fetch mode: ${mode}`);
  if (mode === "mock") return runMock(settings);
  await ensureAccessToken(log);
  if (mode === "paginated") return runPaginated(settings, log);
  return runBulk(settings, log);
}

export default fetchCollections;
