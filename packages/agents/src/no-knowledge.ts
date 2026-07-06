// Canned "nothing to answer" replies. When retrieval comes back empty there is nothing to
// ground an answer on, so we skip the model entirely — cheaper, faster, and it removes the
// one spot where the LLM could hint that hidden information exists. The player lines are
// deliberately in-world and NEVER imply something is being withheld (see the trust-the-filter
// rule): from the asker's perspective, if it isn't known, it simply isn't there.

const PLAYER_LINES = [
  "You search your memory, but nothing of that surfaces.",
  "That lies beyond anything your character has come to know.",
  "Try as you might, no memory of that stirs.",
  "Nothing you've seen or heard speaks to that.",
  "That's a blank page in your memory — nothing comes to mind.",
  "You reach for it, but there's nothing there to recall.",
  "No recollection of that rises to meet the question.",
  "That hasn't crossed your character's path.",
  "Whatever that is, it's unknown to you.",
  "Your character holds no knowledge of that.",
];

const DM_LINES = [
  "Nothing in the campaign memory covers that yet.",
  "The memory holds nothing on that — you may not have added it.",
  "No entries or documents touch on that so far.",
  "There's nothing recorded about that yet.",
];

/** A random in-world "you don't know that" line, role-appropriate. */
export function noKnowledgeReply(role: string): string {
  const bank = role === "DM" ? DM_LINES : PLAYER_LINES;
  return bank[Math.floor(Math.random() * bank.length)]!;
}
