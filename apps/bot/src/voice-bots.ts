// Who in the voice channel is a bot. Music and ambience bots (Kenku FM, and the like) stream audio
// into the channel constantly; recorded as a "speaker", a track never falls silent long enough to end
// a burst, so it's held in memory, streamed to live transcription, and billed, and it buries the
// table's actual voices. Bots are never recorded.

interface MemberLike {
  user: { bot: boolean };
}

export interface GuildMembersLike {
  members: {
    cache: { get(id: string): MemberLike | undefined };
    fetch(id: string): Promise<MemberLike>;
  };
}

/** Whether a voice speaker is a bot. Someone we can't look up is treated as a person: dropping a
 * player's voice is worse than recording a bot. */
export async function isBotUser(
  guild: GuildMembersLike,
  userId: string,
): Promise<boolean> {
  const member =
    guild.members.cache.get(userId) ??
    (await guild.members.fetch(userId).catch(() => undefined));
  return member?.user.bot ?? false;
}
