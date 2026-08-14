/**
 * Local preselect for session search.
 *
 * This is deliberately not trying to be the final answer. It narrows ~200
 * sessions to a candidate set that a model then reads in full (lib/search/pick.ts),
 * so its job is recall, not precision: missing the right session here is fatal,
 * while ranking it third is harmless. That is why the candidate default is
 * generous and the scoring stays simple enough to reason about.
 */
import { coverage, queryTerms, truncate } from "./text.ts";

export interface ScorableSession {
  id: string;
  /** Sidebar name, when the session has been named. */
  name?: string;
  firstMessage?: string;
  cwd?: string;
  /** Epoch ms of last modification, for the recency nudge. */
  modifiedMs?: number;
  messages: { role: "user" | "assistant"; text: string }[];
}

export interface ScoredSession {
  id: string;
  score: number;
  /** "name" when the query matched metadata, "context" when only the body did. */
  matchSource: "name" | "context";
  snippets: string[];
}

/** Weights chosen so a clear name match outranks a body-only match. */
const NAME_WEIGHT = 3;
const BODY_WEIGHT = 1;
const DENSITY_WEIGHT = 0.3;

/**
 * A small nudge, not a ranking factor: two weeks of age costs less than a
 * single extra matched term, so recency only breaks ties.
 */
export function recencyBoost(modifiedMs: number | undefined, nowMs: number): number {
  if (!modifiedMs) return 0;
  const ageDays = Math.max(0, nowMs - modifiedMs) / 86_400_000;
  return 0.15 * Math.exp(-ageDays / 45);
}

/** Text around the first occurrence of a term, for showing why a session matched. */
export function extractSnippet(text: string, term: string, radius = 90): string | null {
  const at = text.toLowerCase().indexOf(term);
  if (at === -1) return null;
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + term.length + radius);
  const lead = start > 0 ? "…" : "";
  const tail = end < text.length ? "…" : "";
  return `${lead}${text.slice(start, end).trim()}${tail}`;
}

export function scoreSessions(
  sessions: ScorableSession[],
  query: string,
  { limit = 25, nowMs = Date.now() }: { limit?: number; nowMs?: number } = {},
): ScoredSession[] {
  const terms = queryTerms(query);
  if (!terms.length) {
    return sessions
      .slice()
      .sort((a, b) => (b.modifiedMs ?? 0) - (a.modifiedMs ?? 0))
      .slice(0, limit)
      .map((session) => ({ id: session.id, score: 0, matchSource: "context", snippets: [] }));
  }

  const scored: ScoredSession[] = [];

  for (const session of sessions) {
    const metadata = [session.name ?? "", session.firstMessage ?? "", session.cwd ?? ""].join("\n");
    const body = session.messages.map((message) => message.text).join("\n");

    const nameCoverage = coverage(metadata, terms);
    const bodyCoverage = coverage(body, terms);
    if (nameCoverage === 0 && bodyCoverage === 0) continue;

    // Density rewards a session that mentions a term repeatedly over one that
    // mentions it once in passing, but saturates so a huge session cannot win
    // on length alone.
    const loweredBody = body.toLowerCase();
    let occurrences = 0;
    for (const term of terms) {
      let from = 0;
      // Cap per term: past ten hits the signal has already saturated.
      for (let seen = 0; seen < 10; seen += 1) {
        const at = loweredBody.indexOf(term, from);
        if (at === -1) break;
        occurrences += 1;
        from = at + term.length;
      }
    }
    const density = Math.min(1, occurrences / (terms.length * 10));

    const score = NAME_WEIGHT * nameCoverage
      + BODY_WEIGHT * bodyCoverage
      + DENSITY_WEIGHT * density
      + recencyBoost(session.modifiedMs, nowMs);

    const snippets: string[] = [];
    for (const term of terms) {
      if (snippets.length >= 3) break;
      for (const message of session.messages) {
        const snippet = extractSnippet(message.text, term);
        if (snippet) {
          snippets.push(truncate(snippet, 240));
          break;
        }
      }
    }

    scored.push({
      id: session.id,
      score,
      matchSource: nameCoverage >= 0.5 ? "name" : "context",
      snippets: [...new Set(snippets)],
    });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
