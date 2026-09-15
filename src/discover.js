// Prints the store's metaobject definitions (types + field keys) so you can confirm
// config/settings.json seoOverrides.type and .fields. Needs read_metaobject_definitions.
//
// Usage: npm run discover   (requires SHOPIFY_STORE_DOMAIN + credentials)

import { discoverMetaobjects } from "./shopify.js";

discoverMetaobjects(console.log).catch((e) => {
  console.error("DISCOVER FAILED:", e.message);
  process.exit(1);
});
