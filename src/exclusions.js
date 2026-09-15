// Builds a fast matcher from config/tag-exclusions.json.
// Matching is done on the RAW tag string, case-insensitive, before handleizing.

export function buildExcluder(config = {}) {
  const exact = new Set((config.exact || []).map((s) => s.toLowerCase()));
  const prefixes = (config.prefix || []).map((s) => s.toLowerCase());
  const regexes = (config.regex || []).map((src) => new RegExp(src, "i"));

  return function isExcluded(rawTag) {
    const t = String(rawTag).trim();
    if (t === "") return true;
    const lower = t.toLowerCase();
    if (exact.has(lower)) return true;
    for (const p of prefixes) if (lower.startsWith(p)) return true;
    for (const re of regexes) if (re.test(t)) return true;
    return false;
  };
}

export default buildExcluder;
