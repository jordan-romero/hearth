// Ask the memory. Identical pipeline to the bot's /ask — the same retrieval, the same
// permission filter, the same prompts — just with room to actually read the answer.
//
// The question lives in the query string rather than component state: the page stays a server
// component (no client JS), and an answer is linkable. Asks are logged the same way too, so
// the web and the bot feed one history.

import { requireMember } from "@/lib/campaign";
import { ask } from "@hearth/agents";

export default async function AskPage({
  params,
  searchParams,
}: {
  params: Promise<{ campaignId: string }>;
  searchParams: Promise<{ q?: string }>;
}) {
  const { campaignId } = await params;
  const { q } = await searchParams;
  const { viewer } = await requireMember(campaignId);

  const question = q?.trim();
  const result = question
    ? await ask(viewer, question, { askedByMembershipId: viewer.membershipId })
    : null;

  const suggestions =
    viewer.role === "DM"
      ? [
          "What threads are still unresolved?",
          "Who has the party wronged?",
          "What does the party not know yet?",
        ]
      : [
          "What do I know about the party's enemies?",
          "Who did we meet recently?",
          "What are we supposed to be doing?",
        ];

  return (
    <section className="section">
      <form className="ask-form" method="get">
        <input
          type="text"
          name="q"
          defaultValue={question ?? ""}
          placeholder="Ask the memory anything…"
          aria-label="Your question"
          autoComplete="off"
        />
        <button className="btn" type="submit">
          Ask
        </button>
      </form>

      <p className="hint">
        {viewer.role === "DM"
          ? "You see everything, including your own private notes."
          : `Answers are limited to what ${viewer.characterName ?? "your character"} knows.`}
      </p>

      {!result && (
        <div className="suggestions">
          {suggestions.map((s) => (
            <a key={s} className="chip" href={`?q=${encodeURIComponent(s)}`}>
              {s}
            </a>
          ))}
        </div>
      )}

      {result && (
        <article className="answer">
          <h2 className="answer-q">{question}</h2>
          <p className="answer-body">{result.answer}</p>
          {result.sources.length > 0 && (
            <footer className="sources">
              <span className="sources-label">Drawn from</span>
              {[...new Set(result.sources.map((s) => s.title))].map((t) => (
                <span key={t} className="source">
                  {t}
                </span>
              ))}
            </footer>
          )}
        </article>
      )}
    </section>
  );
}
