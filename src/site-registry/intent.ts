// The resolver emits a bounded field set. Page text and free-form task text stay local.
export const taskFields = ["title", "by", "score", "descendants", "karma"] as const;
export type TaskField = (typeof taskFields)[number];
const readVocabulary = new Set(
  (
    "a an the this that its their his her s of on in for to with and plus is are does do has have what how who get find read show tell give retrieve fetch check view see me current latest " +
    "story stories article post submission submitted posted wrote title headline name by author writer submitter poster karma reputation points score votes popularity descendants discussion comments comment count many number total size replies responses response"
  ).split(" "),
);

export function fieldsForTask(hint: string, item?: number): TaskField[] {
  if (hint.length > 120) return [];
  // Resolve the explicit record before normalizing prose. Otherwise two different
  // story numbers become the same lookup and the current tab silently wins.
  const reference = /\b(story|article|post|submission|item)\s+#?([1-9]\d{0,9})(?=$|[\s,.?!])/gi;
  const references = Array.from(hint.matchAll(reference));
  if (references.length && item !== undefined && references.some(match => Number(match[2]) !== item))
    throw Object.assign(new Error("SITE_RESOURCE_MISMATCH"), { code: "SITE_RESOURCE_MISMATCH", retryable: false });
  if (references.length > 1 || (references.length && item === undefined)) return [];
  const boundHint = hint.replace(reference, "story");
  if (/[^a-z\s'’.,?!-]/i.test(boundHint)) return [];
  const text = boundHint
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim();
  if (!text || text.split(" ").some((word) => !readVocabulary.has(word))) return [];
  // Reject mixed or unsupported goals instead of answering one fragment.
  if (
    /\b(?:not|don t|never|without|except|exclude|buy|send|write|upvote|downvote|vote for|remove|change|delete|edit|rename|create|submit|publish|post a|add|update|reply to|list|email|password|url|link|summari[sz]e|summary|date|time|when)\b/.test(
      text,
    )
  )
    return [];
  // A superlative can select a different record. This adapter only reads the bound story.
  if (/\blatest\b/.test(text) && !/^(?:get |read |show |what is )?(?:the )?latest (?:score|points|comment count) (?:of|for|on) this (?:story|article|post)$/.test(text)) return [];
  const hasKarma = /\b(?:karma|reputation)\b|\b(?:author|writer|submitter|poster)(?: s)? points\b/.test(text);
  const hasAuthor =
    hasKarma || /\b(?:author|writer|submitter|poster|by)\b|\bwho (?:wrote|posted|submitted)\b/.test(text);
  const hasComments =
    /\b(?:descendants|discussion size)\b/.test(text) ||
    (/\b(?:comments?|replies|responses?)\b/.test(text) && /\b(?:count|many|number|total|size)\b/.test(text));
  if (/\b(?:comments?|replies|responses?)\b/.test(text) && !hasComments) return [];
  const hasScore =
    /\b(?:score|votes|popularity)\b/.test(text) ||
    /\bpoints\b/.test(text.replace(/\b(?:author|writer|submitter|poster)(?: s)? points\b/g, ""));
  const hasTitle = /\b(?:title|headline)\b|\b(?:article|post|story) name\b/.test(text);
  return taskFields.filter(
    (key) =>
      ({ title: hasTitle, by: hasAuthor, score: hasScore, descendants: hasComments, karma: hasKarma })[key],
  );
}
