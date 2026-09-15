// Replicates Shopify's handleize() for tag -> URL path segment.
// "High Heels" -> "high-heels", "Men's" -> "men-s"? NO -> "mens"? See note below.
//
// Shopify's rule: lowercase, transliterate accents to ASCII, replace every run of
// non-alphanumeric characters with a single hyphen, trim leading/trailing hyphens.
// Apostrophes are non-alphanumeric, so "Men's" -> "men-s". Shopify handleizes the
// SAME way for tag URLs, so we match its behaviour rather than "guessing prettier".
//
// IMPORTANT: validate this against ~20 known-good live level-4 URLs before trusting it
// at scale (see test/handleize.test.js). If a real URL disagrees, fix it here + add a case.

export function handleize(input) {
  return String(input)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // any run of non-alphanumerics -> single hyphen
    .replace(/^-+|-+$/g, ""); // trim hyphens
}

export default handleize;
