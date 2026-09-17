// The Hearth bot — a thin adapter (no business logic here, per architecture.md):
// resolve who's asking → call the shared ask() pipeline → reply EPHEMERALLY so
// an answer can never leak to the channel.

import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  type ModalSubmitInteraction,
  REST,
  Routes,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { randomUUID } from "node:crypto";
import { prisma } from "@hearth/db";
import {
  ask,
  buildCorpus,
  chooseFromCorpus,
  getPortrait,
  joinPassages,
  rankRevealCandidates,
  retrieveContext,
  type RevealCandidate,
  type RevealPick,
  revealPassages,
  sectionPassages,
  sectionTitle,
  wordCount,
  revealTo,
  addJournalNote,
  generateNpc,
  matchPortrait,
  portraitQuery,
  saveNpc,
  getActiveSession,
  getLiveTranscript,
  ingestUpload,
  findShareCandidate,
  requestShare,
  approveShare,
  rejectShare,
  getShareForReview,
  proposeCorrection,
  applyCorrection,
  rejectCorrection,
  summarizeRecent,
  chooseRecap,
  resolveCampaignId,
  resolveMember,
  getCampaignDiscord,
  setupCampaign,
  joinCampaign,
  saveCharacterToken,
  recoverInterruptedRecordings,
  tokenImageType,
  TOKEN_MAX_BYTES,
  type TokenImageType,
  type ResolvedMember,
  type NpcDraft,
  type PortraitMatch,
} from "@hearth/agents";
import { startRecording, stopRecording } from "./capture.js";
import {
  answerEmbeds,
  splitForEmbeds,
  revealEmbed,
  journalEmbed,
  npcEmbed,
  npcShareEmbed,
  npcCardMarkdown,
  safeFileName,
  helpEmbed,
  recapEmbed,
  correctionEmbeds,
  shareEmbed,
} from "./embeds.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const TOKEN = requireEnv("DISCORD_BOT_TOKEN");
const CLIENT_ID = requireEnv("DISCORD_CLIENT_ID");
const GUILD_ID = process.env.DISCORD_GUILD_ID; // optional → dev-only instant registration
const GUILD_COMMANDS = process.env.HEARTH_GUILD_COMMANDS === "1";

// Access gate. The bot can be added to any server once it's public, but running commands costs
// real money (Claude, Voyage, Deepgram) on OUR keys — so only approved servers may use it.
// HEARTH_ALLOWED_GUILDS is a comma-separated list of guild ids; when it's empty the bot serves
// every server it's in, which is fine while it's private but must be set before going public.
const ALLOWED_GUILDS = new Set(
  (process.env.HEARTH_ALLOWED_GUILDS ?? "")
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean),
);

function isGuildAllowed(guildId: string | null): boolean {
  if (ALLOWED_GUILDS.size === 0) return true; // no allowlist configured — open
  return guildId !== null && ALLOWED_GUILDS.has(guildId);
}

// DEV ONLY: with HEARTH_DEV_DM_TOGGLE=1, `/dmmode` lets a member view the campaign as the
// DM (to test DM_ONLY content). Gated behind the flag so it can never exist in a real
// multi-tenant deployment, where players must not self-promote.
const DEV_DM_TOGGLE = process.env.HEARTH_DEV_DM_TOGGLE === "1";
// Discord user ids currently viewing the campaign as the OPPOSITE of their real role — a
// player checking DM_ONLY content, or (now that the DM is a real role) a DM checking what a
// player would actually see. Two-way, because both directions are worth testing.
const roleOverride = new Set<string>();

const askCommand = new SlashCommandBuilder()
  .setName("ask")
  .setDescription(
    "Ask the campaign memory — you only get what your character knows.",
  )
  .addStringOption((o) =>
    o
      .setName("question")
      .setDescription("What do you want to know?")
      .setRequired(true),
  );

const recordCommand = new SlashCommandBuilder()
  .setName("record")
  .setDescription("Start recording the session in your voice channel.");

const stopCommand = new SlashCommandBuilder()
  .setName("stop")
  .setDescription("Stop recording and file the session into the memory.");

const uploadCommand = new SlashCommandBuilder()
  .setName("upload")
  .setDescription(
    "Add a document to the campaign memory (DM notes, handouts, lore).",
  )
  .addAttachmentOption((o) =>
    o
      .setName("file")
      .setDescription("A .txt, .md, or .pdf to ingest")
      .setRequired(true),
  )
  .addBooleanOption((o) =>
    o
      .setName("extract")
      .setDescription(
        "Also pull out structured facts (NPCs, places…). Default: yes.",
      ),
  )
  .addBooleanOption((o) =>
    o
      .setName("for_players")
      .setDescription(
        "Players already have this (shared notes, handouts), so everyone can see it. Default: no.",
      ),
  );

const revealCommand = new SlashCommandBuilder()
  .setName("reveal")
  .setDescription(
    "(DM) Reveal something from the memory to a character or party.",
  )
  .addStringOption((o) =>
    o
      .setName("about")
      .setDescription("What to reveal — a name or description to search for")
      .setRequired(true),
  )
  .addStringOption((o) =>
    o
      .setName("to")
      .setDescription("A character name, or 'party' for everyone")
      .setRequired(true),
  )
  .addChannelOption((o) =>
    o
      .setName("in")
      .setDescription(
        "Channel to announce a party reveal in (defaults to the reveals channel)",
      )
      .addChannelTypes(ChannelType.GuildText),
  );

const journalCommand = new SlashCommandBuilder()
  .setName("journal")
  .setDescription(
    "Record a private note only your character (and the DM) can see.",
  )
  .addStringOption((o) =>
    o
      .setName("entry")
      .setDescription("What do you want to remember?")
      .setRequired(true),
  );

const npcCommand = new SlashCommandBuilder()
  .setName("npc")
  .setDescription(
    "(DM) Generate an NPC, grounded in your campaign, with a matched portrait.",
  )
  .addStringOption((o) =>
    o
      .setName("prompt")
      .setDescription(
        "Optional brief — role, race, vibe, where they fit. Leave blank to surprise you.",
      ),
  )
  .addBooleanOption((o) =>
    o
      .setName("live")
      .setDescription(
        "Fit the NPC to what's happening right now (needs an active recording)",
      ),
  )
  .addChannelOption((o) =>
    o
      .setName("in")
      .setDescription(
        "Channel to share the NPC in (defaults to the reveals channel)",
      )
      .addChannelTypes(ChannelType.GuildText),
  );

const setupCommand = new SlashCommandBuilder()
  .setName("setup")
  .setDescription("Set up this server's campaign, or change its settings.")
  .addStringOption((o) =>
    o
      .setName("name")
      .setDescription("What's the campaign called? (required the first time)"),
  )
  .addStringOption((o) =>
    o
      .setName("dm_name")
      .setDescription(
        "What should we call you at the table? (labels your lines in transcripts)",
      ),
  )
  .addStringOption((o) =>
    o
      .setName("dm_pronouns")
      .setDescription("Your pronouns, e.g. she/her, he/him, they/them")
      .setMaxLength(40),
  )
  .addIntegerOption((o) =>
    o
      .setName("starting_session")
      .setDescription(
        "Already mid-campaign? The number your next recorded session should get",
      )
      .setMinValue(1)
      .setMaxValue(10000),
  )
  .addChannelOption((o) =>
    o
      .setName("reveals")
      .setDescription(
        "Where reveals and shared NPCs get posted (run /setup again any time to change it)",
      )
      .addChannelTypes(ChannelType.GuildText),
  );

const joinCommand = new SlashCommandBuilder()
  .setName("join")
  .setDescription("Join this server's campaign with your character.")
  .addStringOption((o) =>
    o
      .setName("character")
      .setDescription("Your character's name")
      .setRequired(true),
  )
  .addStringOption((o) =>
    o
      .setName("pronouns")
      .setDescription(
        "Your character's pronouns, e.g. she/her, he/him, they/them",
      )
      .setMaxLength(40),
  )
  .addAttachmentOption((o) =>
    o
      .setName("token")
      .setDescription(
        "A token image for your character (PNG, JPG, WebP, or GIF, up to 5 MB)",
      ),
  )
  .addStringOption((o) =>
    o
      .setName("class")
      .setDescription("Your character's class, e.g. Ranger or Wizard")
      .setMaxLength(60),
  )
  .addStringOption((o) =>
    o
      .setName("ancestry")
      .setDescription("Your character's ancestry, e.g. Half-elf")
      .setMaxLength(60),
  )
  .addIntegerOption((o) =>
    o
      .setName("level")
      .setDescription("Your character's level")
      .setMinValue(1)
      .setMaxValue(30),
  );

const correctCommand = new SlashCommandBuilder()
  .setName("correct")
  .setDescription(
    "Something in the memory is wrong — tell Hearth what's actually true.",
  )
  .addStringOption((o) =>
    o
      .setName("truth")
      .setDescription(
        "What's actually true, e.g. 'Moira was Morwyn's mother, not his wife'",
      )
      .setRequired(true),
  )
  .addStringOption((o) =>
    o
      .setName("said")
      .setDescription(
        "What the memory said, if you want to point at it directly",
      ),
  );

const shareCommand = new SlashCommandBuilder()
  .setName("share")
  .setDescription(
    "Tell the party something you know — the DM approves it first.",
  )
  .addStringOption((o) =>
    o
      .setName("about")
      .setDescription(
        "What you want to share — a note you wrote, or anything you know",
      )
      .setRequired(true),
  )
  .addStringOption((o) =>
    o
      .setName("note")
      .setDescription("Anything you want the DM to know about why"),
  );

const recapCommand = new SlashCommandBuilder()
  .setName("recap")
  .setDescription("What happened last session?")
  .addBooleanOption((o) =>
    o
      .setName("in_character")
      .setDescription("Hear it as your character remembers it"),
  );

const missedCommand = new SlashCommandBuilder()
  .setName("missed")
  .setDescription("What did I miss? Catch up on what just happened.")
  .addIntegerOption((o) =>
    o
      .setName("minutes")
      .setDescription("How far back to look (default 5)")
      .setMinValue(1)
      .setMaxValue(120),
  )
  .addBooleanOption((o) =>
    o
      .setName("raw")
      .setDescription(
        "Show what was actually said, word for word, instead of a summary",
      ),
  );

const helpCommand = new SlashCommandBuilder()
  .setName("help")
  .setDescription("What can Hearth do? List the commands.");

const dmModeCommand = new SlashCommandBuilder()
  .setName("dmmode")
  .setDescription("(dev) Swap between the DM view and a player view.");

async function registerCommands(): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  const body = [
    askCommand.toJSON(),
    recordCommand.toJSON(),
    stopCommand.toJSON(),
    uploadCommand.toJSON(),
    revealCommand.toJSON(),
    journalCommand.toJSON(),
    npcCommand.toJSON(),
    recapCommand.toJSON(),
    missedCommand.toJSON(),
    correctCommand.toJSON(),
    shareCommand.toJSON(),
    setupCommand.toJSON(),
    joinCommand.toJSON(),
    helpCommand.toJSON(),
  ];
  if (DEV_DM_TOGGLE) body.push(dmModeCommand.toJSON());
  // Global registration is the default now that Hearth serves many servers — guild-scoped
  // commands would only ever appear in ONE server. HEARTH_GUILD_COMMANDS=1 opts local dev into
  // instant guild registration (global propagation takes ~1h), at the cost of that one server
  // briefly showing each command twice.
  if (GUILD_COMMANDS && GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body,
    });
    console.log(`Registered commands to guild ${GUILD_ID} (dev, instant)`);
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body });
    // Clear leftovers from a previous guild-scoped run so they don't duplicate the global set.
    if (GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
        body: [],
      });
    }
    console.log(
      "Registered commands globally — every server gets them (can take ~1h to appear)",
    );
  }
}

/** A resolved viewer plus the display name of their character (for in-world presentation).
 * The core `Viewer` stays pure — the name rides alongside only for the bot's UI. */
type ResolvedViewer = ResolvedMember;

/** Resolve the Discord author to a permission viewer within the campaign bound to `guildId`.
 * Returns null if the server has no campaign yet (`/setup`) or the user hasn't joined it. */
async function resolveViewer(
  guildId: string | null,
  discordUserId: string,
): Promise<ResolvedViewer | null> {
  if (!guildId) return null;
  const campaignId = await resolveCampaignId(guildId);
  if (!campaignId) return null;
  const member = await resolveMember(campaignId, discordUserId);
  if (!member) return null;
  // Dev-only role swap (see /dmmode) — applied on top of the shared resolution, never inside
  // it, so the web app can't inherit a development affordance.
  if (!DEV_DM_TOGGLE || !roleOverride.has(discordUserId)) return member;
  return { ...member, role: member.role === "DM" ? "PLAYER" : "DM" };
}

/** /ask — answer from the memory, filtered to what the asker's character knows. */
async function handleAsk(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const question = interaction.options.getString("question", true);

  // Ephemeral: only the asker sees the answer — nothing leaks to the table.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const viewer = await resolveViewer(
      interaction.guildId,
      interaction.user.id,
    );
    if (!viewer) {
      await interaction.editReply(
        "You're not linked to a character in this campaign yet.",
      );
      return;
    }
    const result = await ask(viewer, question, {
      askedByMembershipId: viewer.membershipId,
    });
    // One embed per message: a long briefing spans several, and Discord caps a message's embeds
    // at 6,000 characters in total.
    const [first, ...rest] = answerEmbeds(
      viewer,
      viewer.characterName,
      question,
      result,
      viewer.theme,
    );
    await interaction.editReply({ embeds: [first!] });
    for (const embed of rest)
      await interaction.followUp({
        embeds: [embed],
        flags: MessageFlags.Ephemeral,
      });
  } catch (err) {
    console.error("/ask failed:", err);
    // Never let the fallback itself throw and leave the interaction hanging.
    await interaction
      .editReply("Something went wrong reaching the memory.")
      .catch(() => {});
  }
}

/** /journal — a player records a private note, visible only to their character (and the DM). */
async function handleJournal(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const viewer = await resolveViewer(
      interaction.guildId,
      interaction.user.id,
    );
    if (!viewer) {
      await interaction.editReply("You're not part of this campaign.");
      return;
    }
    if (!viewer.characterId) {
      await interaction.editReply(
        "Your journal is tied to a character — the DM keeps notes with `/upload`.",
      );
      return;
    }
    const entry = interaction.options.getString("entry", true);
    const note = await addJournalNote(
      viewer.campaignId,
      viewer.membershipId,
      viewer.characterId,
      entry,
    );
    await interaction.editReply({
      embeds: [journalEmbed(viewer.characterName, note.content, viewer.theme)],
    });
  } catch (err) {
    console.error("/journal failed:", err);
    await interaction
      .editReply("Something went wrong saving that to your journal.")
      .catch(() => {});
  }
}

/** /setup — create this server's campaign and make the runner its DM. Gated on Discord's
 * Manage Server permission, so a random member can't claim someone else's table. */
async function handleSetup(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.editReply("Run this in a server, not a DM.");
      return;
    }
    // Two different questions, so two different gates. CLAIMING a server needs Manage Server,
    // so a passing member can't take over someone else's table. ADJUSTING a campaign that
    // already exists is the DM's call — they own it, and they may well not be a server admin.
    const existing = await resolveCampaignId(guildId);
    if (existing) {
      const viewer = await resolveMember(existing, interaction.user.id);
      if (viewer?.role !== "DM") {
        await interaction.editReply(
          "This server already has a campaign — only its DM can change these settings.",
        );
        return;
      }
    } else if (
      !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)
    ) {
      await interaction.editReply(
        "You need the **Manage Server** permission to set up a campaign here.",
      );
      return;
    }
    const name = interaction.options.getString("name");
    if (!existing && !name) {
      await interaction.editReply(
        'What\'s the campaign called? Run `/setup name:"Your campaign"`.',
      );
      return;
    }
    const dmName = interaction.options.getString("dm_name") ?? undefined;
    const dmPronouns =
      interaction.options.getString("dm_pronouns") ?? undefined;
    const startingSession =
      interaction.options.getInteger("starting_session") ?? undefined;
    const reveals = interaction.options.getChannel("reveals");
    const result = await setupCampaign(
      guildId,
      interaction.user.id,
      interaction.user.username,
      name ?? "",
      dmName,
      reveals?.id,
      dmPronouns,
      startingSession,
    );

    // Say NOW whether I can actually post there, rather than at the moment someone tries to
    // share something and it fails.
    const revealWarning = await describeRevealChannel(
      interaction,
      result.revealChannelId,
    );

    if (result.alreadyExisted) {
      const changes = [
        reveals ? revealWarning : null,
        dmPronouns?.trim()
          ? `Your pronouns are set to **${dmPronouns.trim()}**.`
          : null,
        startingSession
          ? `Until a session is recorded, the first one will be session **${startingSession}**.`
          : null,
      ].filter(Boolean);
      await interaction.editReply(
        changes.length > 0
          ? changes.join("\n")
          : `This server already runs **${result.campaignName}** — players can \`/join\`. Use \`/setup reveals:#channel\` to choose where reveals post.`,
      );
      return;
    }
    await interaction.editReply(
      `🔥 **${result.campaignName}** is live and you're the DM.\n` +
        "Players join with `/join character:<name>`. Then `/record` to capture a session, `/upload` your notes, and `/help` for everything else." +
        `\n${revealWarning}`,
    );
  } catch (err) {
    console.error("/setup failed:", err);
    await interaction
      .editReply("Something went wrong setting up the campaign.")
      .catch(() => {});
  }
}

/** Whether I can actually post in the reveals channel, said at setup time.
 *
 * Reveals and shared NPCs are posted to a channel, and a PRIVATE channel needs the bot invited
 * to it explicitly — being in the server isn't enough. Finding that out when a share fails is
 * a bad time to find it out. */
/**
 * What stands between me and posting in `channelId`.
 *
 * An empty list means I can post there. `null` means the channel itself is out of reach, which is
 * a different problem from a missing permission and deserves different words.
 *
 * This is checked at setup AND before a reveal is granted. A reveal is one-way: granting it and
 * then discovering the announcement can't be delivered leaves a player knowing something nobody
 * told them.
 */
async function revealChannelBlockers(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  channelId: string,
): Promise<string[] | null> {
  const channel = await interaction.guild?.channels
    .fetch(channelId)
    .catch(() => null);
  if (!channel || !channel.isTextBased()) return null;
  const me = interaction.guild?.members.me;
  const perms = me ? channel.permissionsFor(me) : null;
  return [
    perms?.has(PermissionFlagsBits.ViewChannel) ? null : "View Channel",
    perms?.has(PermissionFlagsBits.SendMessages) ? null : "Send Messages",
    perms?.has(PermissionFlagsBits.EmbedLinks) ? null : "Embed Links",
  ].filter((p): p is string => p !== null);
}

async function describeRevealChannel(
  interaction: ChatInputCommandInteraction,
  channelId: string | null,
): Promise<string> {
  if (!channelId) {
    return "ℹ️ No reveals channel set — I'll post reveals wherever the command was run. `/setup reveals:#channel` to pin it down.";
  }
  const missing = await revealChannelBlockers(interaction, channelId);
  if (missing === null) {
    return `⚠️ I can't see <#${channelId}> — pick a channel I can read.`;
  }
  if (missing.length > 0) {
    return `⚠️ Reveals will go to <#${channelId}>, but I can't post there yet — grant me **${missing.join(", ")}** (a private channel needs me added to it directly).`;
  }
  return `✅ Reveals will be posted in <#${channelId}>.`;
}

/** /join — a player registers themselves + their character in this server's campaign. */
async function handleJoin(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const guildId = interaction.guildId;
    const campaignId = guildId ? await resolveCampaignId(guildId) : null;
    if (!campaignId) {
      await interaction.editReply(
        "No campaign here yet — the DM needs to run `/setup` first.",
      );
      return;
    }
    const characterName = interaction.options.getString("character", true);
    const pronouns = interaction.options.getString("pronouns") ?? undefined;
    const token = interaction.options.getAttachment("token");

    // Check the token before joining, so a bad file doesn't leave the join half done.
    let tokenData: Buffer | undefined;
    let tokenType: TokenImageType | null = null;
    if (token) {
      if (token.size > TOKEN_MAX_BYTES) {
        await interaction.editReply(
          "That token is over 5 MB — try a smaller image.",
        );
        return;
      }
      const res = await fetch(token.url);
      if (!res.ok) {
        await interaction.editReply(
          "Couldn't download that token — try again.",
        );
        return;
      }
      tokenData = Buffer.from(await res.arrayBuffer());
      tokenType = tokenImageType(token.contentType, tokenData);
      if (!tokenType) {
        await interaction.editReply(
          "Tokens need to be a PNG, JPG, WebP, or GIF image.",
        );
        return;
      }
    }

    const result = await joinCampaign(
      campaignId,
      interaction.user.id,
      interaction.user.username,
      characterName,
      {
        pronouns,
        className: interaction.options.getString("class") ?? undefined,
        ancestry: interaction.options.getString("ancestry") ?? undefined,
        level: interaction.options.getInteger("level") ?? undefined,
      },
    );
    if (result.kind === "dm") {
      await interaction.editReply(
        "You're the DM here, so you don't need a character — players `/join`. Set your pronouns with `/setup dm_pronouns:`.",
      );
      return;
    }
    if (tokenData && tokenType) {
      await saveCharacterToken(
        campaignId,
        result.characterId,
        tokenData,
        tokenType,
      );
    }
    const tokenNote = tokenData ? " Token saved." : "";
    await interaction.editReply(
      result.renamed
        ? `Your character is now **${result.characterName}**.${tokenNote}`
        : `🎲 Welcome — you're playing **${result.characterName}**.${tokenNote} Try \`/ask\` to see what they know, or \`/journal\` to keep private notes.`,
    );
  } catch (err) {
    console.error("/join failed:", err);
    await interaction
      .editReply("Something went wrong joining the campaign.")
      .catch(() => {});
  }
}

/** Keep the most RECENT whole lines that fit — a transcript tail is what you missed, so
 * trimming the end (as a plain truncate would) throws away the newest part. */
function tailWithin(transcript: string, limit: number): string {
  const lines = transcript.split("\n");
  const kept: string[] = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (size + line.length + 1 > limit) break;
    kept.unshift(line);
    size += line.length + 1;
  }
  return kept.length > 0 ? kept.join("\n") : transcript.slice(-limit);
}

/** /missed — you stepped away mid-session; what happened? Five minutes by default, since that's
 * about how long stepping away takes and nobody should have to estimate it. Table-audible
 * speech only, so there's nothing to permission-filter. */
async function handleMissed(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const viewer = await resolveViewer(
      interaction.guildId,
      interaction.user.id,
    );
    if (!viewer) {
      await interaction.editReply(
        "You're not part of a campaign here yet — try `/join`.",
      );
      return;
    }
    const minutes = interaction.options.getInteger("minutes") ?? 5;
    const raw = interaction.options.getBoolean("raw") ?? false;

    const live = await getActiveSession(viewer.campaignId);
    if (!live) {
      await interaction.editReply(
        "No session is being recorded right now — `/recap` covers last time.",
      );
      return;
    }

    const transcript = await getLiveTranscript(live.gameSessionId, minutes);
    if (!transcript) {
      await interaction.editReply(
        `Nothing's been transcribed in the last ${minutes} minutes — it may still be catching up.`,
      );
      return;
    }

    // Raw is the literal transcript: no model call, so it's instant and free, and it shows
    // exactly what was said rather than what a summary made of it.
    const body = raw
      ? tailWithin(transcript, 4000)
      : await summarizeRecent(transcript);

    await interaction.editReply({
      embeds: [
        recapEmbed(
          raw
            ? `🎙 The last ${minutes} minutes, word for word`
            : `⏪ The last ${minutes} minutes`,
          body,
          `Session ${live.number} · in progress`,
          viewer.theme,
        ),
      ],
    });
  } catch (err) {
    console.error("/missed failed:", err);
    await interaction
      .editReply("Something went wrong catching you up.")
      .catch(() => {});
  }
}

/** /recap — what happened LAST session. After the fact, not mid-session: the stored recap the
 * worker wrote when that session finished. */
async function handleRecap(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const viewer = await resolveViewer(
      interaction.guildId,
      interaction.user.id,
    );
    if (!viewer) {
      await interaction.editReply(
        "You're not part of a campaign here yet — try `/join`.",
      );
      return;
    }
    const last = await prisma.gameSession.findFirst({
      where: { campaignId: viewer.campaignId, recap: { not: null } },
      orderBy: { number: "desc" },
      select: { id: true, number: true, title: true, recap: true },
    });
    if (!last?.recap) {
      await interaction.editReply(
        "No sessions have been recorded yet — the DM can start one with `/record`.",
      );
      return;
    }
    // A player reads their character's version: only what they were there for, never what another
    // character learned privately. The DM reads the whole table's recap.
    const voice = interaction.options.getBoolean("in_character") ?? false;
    const own =
      viewer.role !== "DM" && viewer.characterId
        ? await prisma.characterRecap.findUnique({
            where: {
              gameSessionId_characterId: {
                gameSessionId: last.id,
                characterId: viewer.characterId,
              },
            },
            select: { summary: true, inCharacter: true },
          })
        : null;
    const choice = chooseRecap(viewer.role, last.recap, own, voice);
    const sessionTitle = last.title ?? `Session ${last.number}`;
    const title =
      choice.kind === "character" && choice.voice
        ? `${sessionTitle} — as ${viewer.characterName ?? "your character"} remembers it`
        : choice.kind === "character"
          ? `${sessionTitle} — ${viewer.characterName ?? "your character"}`
          : sessionTitle;

    // A long session's recap runs past one embed (4,096 characters); cutting it would end the
    // story mid-sentence. Send it whole, one embed per message.
    const parts = splitForEmbeds(choice.text);
    const embeds = parts.map((part, i) =>
      recapEmbed(
        i === 0 ? title : `${title} (continued ${i + 1}/${parts.length})`,
        part,
        `Session ${last.number} · last time`,
        viewer.theme,
      ),
    );
    await interaction.editReply({ embeds: [embeds[0]!] });
    for (const embed of embeds.slice(1))
      await interaction.followUp({
        embeds: [embed],
        flags: MessageFlags.Ephemeral,
      });
  } catch (err) {
    console.error("/recap failed:", err);
    await interaction
      .editReply("Something went wrong putting that recap together.")
      .catch(() => {});
  }
}

/** /correct — anyone can say the memory got something wrong. A player's correction waits for
 * the DM; a DM's applies immediately, because there's nobody above them to ask. */
async function handleCorrect(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const viewer = await resolveViewer(
      interaction.guildId,
      interaction.user.id,
    );
    if (!viewer) {
      await interaction.editReply(
        "You're not part of a campaign here yet — try `/join`.",
      );
      return;
    }
    const truth = interaction.options.getString("truth", true);
    const said = interaction.options.getString("said") ?? undefined;

    const proposal = await proposeCorrection(
      viewer,
      viewer.membershipId,
      truth,
      said,
    );

    if (proposal.targets.length === 0 && !proposal.newFactTitle) {
      await interaction.editReply(
        "Nothing in the memory contradicts that — it may not have been recorded yet. Nothing changed.",
      );
      return;
    }

    if (proposal.autoApproved) {
      await interaction.editReply({
        embeds: correctionEmbeds(proposal, "applied", viewer.theme),
      });
      return;
    }

    // A player's correction: tell them it's pending, then put it in front of the DM.
    await interaction.editReply({
      embeds: correctionEmbeds(proposal, "pending", viewer.theme),
    });
    await notifyDmOfCorrection(interaction, viewer, proposal);
  } catch (err) {
    console.error("/correct failed:", err);
    await interaction
      .editReply("Something went wrong filing that correction.")
      .catch(() => {});
  }
}

/** Tell the DM a correction is waiting — WITHOUT showing what it touches.
 *
 * The facts a correction changes can be DM_ONLY, or another player's private note that only
 * they and the DM may read. Posting the before/after into a campaign channel would hand all of
 * it to everyone present, so the channel message carries nothing but the proposer's own words;
 * the detail is delivered ephemerally when the DM opens it. */
async function notifyDmOfCorrection(
  interaction: ChatInputCommandInteraction,
  viewer: ResolvedViewer,
  proposal: Awaited<ReturnType<typeof proposeCorrection>>,
): Promise<void> {
  const dm = await prisma.membership.findFirst({
    where: { campaignId: viewer.campaignId, role: "DM" },
    select: { user: { select: { discordUserId: true } } },
  });
  const mention = dm?.user.discordUserId ? `<@${dm.user.discordUserId}> ` : "";
  const who = viewer.characterName ?? "A player";

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`cx:v:${proposal.id}`)
      .setLabel("Review correction")
      .setStyle(ButtonStyle.Primary),
  );

  const channel = interaction.channel;
  const notified =
    channel?.isSendable() &&
    (await channel
      .send({
        content: `${mention}${who} says the memory got something wrong — only you can see the details.`,
        components: [row],
      })
      .then(() => true)
      .catch((err) => {
        console.error("correction notify failed:", err);
        return false;
      }));

  // Don't let the proposer believe the DM was told when they weren't — a correction that
  // silently waits forever is worse than one that never got filed.
  if (!notified) {
    await interaction
      .followUp({
        content:
          "Filed — but I couldn't post it here, so please mention it to your DM directly.",
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
  }
}

/** Load a pending correction and shape it the way the embeds expect. Campaign-scoped, so a
 * button id from another table resolves to nothing. */
async function loadCorrectionForReview(
  correctionId: string,
  campaignId: string,
): Promise<Parameters<typeof correctionEmbeds>[0] | null> {
  const c = await prisma.correction.findFirst({
    where: { id: correctionId, campaignId },
  });
  if (!c) return null;
  const rewrites = (c.rewrites ?? []) as {
    id: string;
    rewrite: string;
    kind?: "FACT" | "PASSAGE";
  }[];
  const [units, chunks] = await Promise.all([
    prisma.knowledgeUnit.findMany({
      where: { id: { in: rewrites.map((r) => r.id) }, campaignId },
      select: { id: true, title: true, content: true },
    }),
    prisma.documentChunk.findMany({
      where: { id: { in: rewrites.map((r) => r.id) }, campaignId },
      select: {
        id: true,
        text: true,
        sourceDocument: { select: { name: true } },
      },
    }),
  ]);
  return {
    statement: c.statement,
    targets: rewrites.map((r) => {
      const unit = units.find((u) => u.id === r.id);
      if (unit) {
        return { title: unit.title, content: unit.content, rewrite: r.rewrite };
      }
      const chunk = chunks.find((ch) => ch.id === r.id);
      if (chunk) {
        return {
          title: `passage from ${chunk.sourceDocument.name}`,
          content: chunk.text,
          rewrite: "",
        };
      }
      return { title: "(already changed)", content: "", rewrite: r.rewrite };
    }),
    newFactTitle: c.resultTitle,
    newFactContent: c.resultContent,
  };
}

/** Review / Approve / Reject on a pending correction. DM only — they own canon. */
async function handleCorrectionButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const [, action, correctionId] = interaction.customId.split(":");
  const viewer = await resolveViewer(interaction.guildId, interaction.user.id);
  if (!viewer || viewer.role !== "DM") {
    await interaction.reply({
      content: "Only the DM can review a correction.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // "Review" opens the detail privately — this is the only place target content is shown.
  if (action === "v") {
    const proposal = await loadCorrectionForReview(
      correctionId!,
      viewer.campaignId,
    );
    if (!proposal) {
      await interaction.reply({
        content: "That correction is no longer available.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const decide = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`cx:a:${correctionId}`)
        .setLabel("Approve")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`cx:r:${correctionId}`)
        .setLabel("Reject")
        .setStyle(ButtonStyle.Secondary),
    );
    await interaction.reply({
      embeds: correctionEmbeds(proposal, "pending", viewer.theme),
      components: [decide],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Ack first: applying rewrites units and re-embeds, well past the 3s button window.
  await interaction.deferUpdate();
  try {
    if (action === "r") {
      await rejectCorrection(
        correctionId!,
        viewer.membershipId,
        viewer.campaignId,
      );
      await interaction.editReply({
        content: "❌ Correction rejected — the memory stands as it was.",
        embeds: [],
        components: [],
      });
      return;
    }
    const { rewritten, retiredFacts, retiredPassages, added } =
      await applyCorrection(
        correctionId!,
        viewer.membershipId,
        viewer.campaignId,
      );
    const parts = [
      rewritten > 0
        ? `${rewritten} fact${rewritten === 1 ? "" : "s"} corrected`
        : null,
      retiredFacts > 0
        ? `${retiredFacts} fact${retiredFacts === 1 ? "" : "s"} retired`
        : null,
      retiredPassages > 0
        ? `${retiredPassages} passage${retiredPassages === 1 ? "" : "s"} retired`
        : null,
      added ? "1 fact added" : null,
    ].filter(Boolean);
    await interaction.editReply({
      // Everything it targeted can have been changed by another correction in the meantime,
      // which is a real outcome and shouldn't render as "Canon updated — .".
      content:
        parts.length > 0
          ? `✅ Canon updated — ${parts.join(", ")}.`
          : "✅ Approved, but the memory had already moved on — nothing was left to change.",
      embeds: [],
      components: [],
    });
  } catch (err) {
    console.error("correction decision failed:", err);
    await interaction
      .editReply({
        // A second click on a stale message is the common case here, not a real failure —
        // say what actually happened rather than implying something broke.
        content:
          err instanceof Error &&
          (err.message.includes("already been applied") ||
            err.message.includes("not awaiting") ||
            err.message.includes("not found"))
            ? "That correction has already been decided."
            : "Something went wrong applying that correction.",
        components: [],
      })
      .catch(() => {});
  }
}

/** /share — a player offers something they know to the party. The DM decides.
 *
 * Deliberately mirrors /correct and /reveal: matching is semantic and can pick the wrong thing,
 * so the player sees what was found and confirms before anything is filed. Nothing is written
 * until they say that's the one. */
async function handleShare(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const viewer = await resolveViewer(
      interaction.guildId,
      interaction.user.id,
    );
    if (!viewer) {
      await interaction.editReply(
        "You're not part of a campaign here yet — try `/join`.",
      );
      return;
    }
    const about = interaction.options.getString("about", true);
    const note = interaction.options.getString("note") ?? undefined;

    const match = await findShareCandidate(viewer, about);
    if (!match) {
      await interaction.editReply(
        "Couldn't find anything you know that matches that — try describing it differently.",
      );
      return;
    }
    if (match.alreadyShared) {
      await interaction.editReply(
        `The party already knows about **${match.unit.title}** — nothing to share.`,
      );
      return;
    }

    // Stash the note against the draft id; Discord custom ids are far too small for prose.
    const draftId = randomUUID().slice(0, 8);
    shareDrafts.set(draftId, {
      unitId: match.unit.id,
      note,
      touchedAt: Date.now(),
    });
    sweepShareDrafts();

    await interaction.editReply({
      content: `Share this with the party?`,
      embeds: [
        shareEmbed(
          viewer.characterName ?? "You",
          match.unit.title,
          match.unit.content,
          note,
          viewer.theme,
        ),
      ],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`sh:c:${draftId}`)
            .setLabel(viewer.role === "DM" ? "Share it" : "Ask the DM")
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId("sh:x")
            .setLabel("Not that")
            .setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
  } catch (err) {
    console.error("/share failed:", err);
    await interaction
      .editReply("Something went wrong looking that up.")
      .catch(() => {});
  }
}

/** Confirmed shares awaiting the button click. In memory because they're seconds-long and
 * carry nothing that matters if the process restarts — the same treatment as NPC drafts. */
const shareDrafts = new Map<
  string,
  { unitId: string; note?: string; touchedAt: number }
>();
const SHARE_DRAFT_TTL_MS = 15 * 60_000;
function sweepShareDrafts(): void {
  const cutoff = Date.now() - SHARE_DRAFT_TTL_MS;
  for (const [id, d] of shareDrafts) {
    if (d.touchedAt < cutoff) shareDrafts.delete(id);
  }
}

/** Tell the DM a share is waiting, without publishing its content — the same reasoning as a
 * correction: until they approve it, it isn't the party's to read. */
async function notifyDmOfShare(
  interaction: ButtonInteraction,
  viewer: ResolvedViewer,
  shareId: string,
): Promise<void> {
  const dm = await prisma.membership.findFirst({
    where: { campaignId: viewer.campaignId, role: "DM" },
    select: { user: { select: { discordUserId: true } } },
  });
  const mention = dm?.user.discordUserId ? `<@${dm.user.discordUserId}> ` : "";
  const who = viewer.characterName ?? "A player";

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`sh:v:${shareId}`)
      .setLabel("Review share")
      .setStyle(ButtonStyle.Primary),
  );

  const channel = interaction.channel;
  const notified =
    channel?.isSendable() &&
    (await channel
      .send({
        content: `${mention}${who} wants to tell the party something — only you can see what.`,
        components: [row],
      })
      .then(() => true)
      .catch((err) => {
        console.error("share notify failed:", err);
        return false;
      }));
  if (!notified) {
    await interaction
      .followUp({
        content:
          "Filed — but I couldn't post it here, so please mention it to your DM directly.",
        flags: MessageFlags.Ephemeral,
      })
      .catch(() => {});
  }
}

/** Review / Approve / Reject a pending share. DM only. */
async function handleShareButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const [, action, shareId] = interaction.customId.split(":");
  const viewer = await resolveViewer(interaction.guildId, interaction.user.id);
  if (!viewer) {
    await interaction.reply({
      content: "You're not part of a campaign here.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // The player's own confirm/cancel — anyone may do this for their own draft.
  if (action === "x") {
    await interaction.update({
      content: "Cancelled — nothing was shared.",
      embeds: [],
      components: [],
    });
    return;
  }
  if (action === "c") {
    const draft = shareDrafts.get(shareId!);
    if (!draft) {
      await interaction.update({
        content: "That's expired — run `/share` again.",
        embeds: [],
        components: [],
      });
      return;
    }
    await interaction.deferUpdate();
    try {
      const { id, alreadyPending } = await requestShare(
        viewer,
        viewer.membershipId,
        draft.unitId,
        draft.note,
      );
      shareDrafts.delete(shareId!);
      if (alreadyPending) {
        await interaction.editReply({
          content: "That's already waiting on the DM.",
          embeds: [],
          components: [],
        });
        return;
      }
      // A DM sharing is the approval — there's nobody above them to ask.
      if (viewer.role === "DM") {
        await approveShare(id, viewer.membershipId, viewer.campaignId);
        await interaction.editReply({
          content: "✅ Shared with the party.",
          embeds: [],
          components: [],
        });
        return;
      }
      await interaction.editReply({
        content:
          "📨 Asked the DM. Nothing is visible to anyone else until they approve.",
        embeds: [],
        components: [],
      });
      await notifyDmOfShare(interaction, viewer, id);
    } catch (err) {
      console.error("share request failed:", err);
      await interaction
        .editReply({
          content:
            err instanceof Error && err.message.includes("can share")
              ? "That isn't something you can share."
              : "Something went wrong filing that.",
          embeds: [],
          components: [],
        })
        .catch(() => {});
    }
    return;
  }

  // Everything below is the DM's decision.
  if (viewer.role !== "DM") {
    await interaction.reply({
      content: "Only the DM can decide on a share.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (action === "v") {
    const req = await getShareForReview(shareId!, viewer.campaignId);
    if (!req) {
      await interaction.reply({
        content: "That share is no longer available.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const decide = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`sh:a:${shareId}`)
        .setLabel("Share with the party")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`sh:r:${shareId}`)
        .setLabel("Keep it private")
        .setStyle(ButtonStyle.Secondary),
    );
    await interaction.reply({
      embeds: [
        shareEmbed(
          req.proposedBy?.characters[0]?.name ?? "A player",
          req.knowledgeUnit.title,
          req.knowledgeUnit.content,
          req.note,
          viewer.theme,
        ),
      ],
      components: [decide],
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferUpdate();
  try {
    if (action === "r") {
      await rejectShare(shareId!, viewer.membershipId, viewer.campaignId);
      await interaction.editReply({
        content: "🤫 Kept private — the party wasn't told.",
        embeds: [],
        components: [],
      });
      return;
    }
    await approveShare(shareId!, viewer.membershipId, viewer.campaignId);
    await interaction.editReply({
      content: "✅ Shared with the party — they can ask about it now.",
      embeds: [],
      components: [],
    });
  } catch (err) {
    console.error("share decision failed:", err);
    await interaction
      .editReply({
        content:
          err instanceof Error && err.message.includes("not awaiting")
            ? "That share has already been decided."
            : "Something went wrong with that share.",
        components: [],
      })
      .catch(() => {});
  }
}

/** /record — resolve this server's campaign, then start capture. Any campaign member may. */
async function handleRecord(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const viewer = await resolveViewer(interaction.guildId, interaction.user.id);
  if (!viewer) {
    await interaction.reply({
      content:
        "This server isn't set up yet — the DM can run `/setup`, or `/join` if the campaign already exists.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  // Anyone in the campaign can start or resume a recording, as anyone can /stop one. The DM is busy
  // running the game; whoever notices capture has stopped should be able to fix it from their seat.
  await startRecording(interaction, viewer.campaignId);
}

/** /help — list Hearth's commands. Works for anyone; membership not required. */
async function handleHelp(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const viewer = await resolveViewer(
    interaction.guildId,
    interaction.user.id,
  ).catch(() => null);
  await interaction.reply({
    embeds: [helpEmbed(viewer?.theme)],
    flags: MessageFlags.Ephemeral,
  });
}

/** /upload — ingest a document into the DM_ADDED corpus (parse → chunk → embed). */
async function handleUpload(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const viewer = await resolveViewer(
      interaction.guildId,
      interaction.user.id,
    );
    if (!viewer) {
      await interaction.editReply("You're not part of this campaign.");
      return;
    }
    // Documents are the DM's campaign material — only the DM curates the memory.
    if (viewer.role !== "DM") {
      await interaction.editReply(
        "Only the DM can add documents to the campaign memory.",
      );
      return;
    }

    const attachment = interaction.options.getAttachment("file", true);
    const res = await fetch(attachment.url);
    if (!res.ok) {
      await interaction.editReply("Couldn't download that file — try again.");
      return;
    }
    const data = Buffer.from(await res.arrayBuffer());

    const extractUnits = interaction.options.getBoolean("extract") ?? true;
    const forPlayers = interaction.options.getBoolean("for_players") ?? false;
    const doc = await ingestUpload(
      viewer.campaignId,
      attachment.name,
      data,
      attachment.contentType ?? undefined,
      extractUnits,
      forPlayers,
    );

    console.log(
      `📄 upload: "${attachment.name}" (${data.length} bytes, ${forPlayers ? "for players" : "DM only"}) → ${doc.documentId} queued`,
    );
    await interaction.editReply(
      forPlayers
        ? `📄 Uploaded **${attachment.name}** — parsing it into the memory. Everyone at the table can see it.`
        : `📄 Uploaded **${attachment.name}** — parsing it into the memory. Only you can see it until you reveal it.`,
    );
  } catch (err) {
    console.error("/upload failed:", err);
    await interaction
      .editReply("Something went wrong ingesting that file.")
      .catch(() => {});
  }
}

/** /dmmode — DEV ONLY: toggle whether you're treated as the DM (see DM_ONLY content). */
async function handleDmMode(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const id = interaction.user.id;
  const on = !roleOverride.has(id);
  if (on) roleOverride.add(id);
  else roleOverride.delete(id);
  const viewer = await resolveViewer(interaction.guildId, id);
  const nowSeeing = on
    ? viewer?.role === "DM"
      ? "everything in the campaign (DM_ONLY included)"
      : `only what ${viewer?.characterName ?? "your character"} knows`
    : "your real role again";
  await interaction.reply({
    content: `🎭 Role swap **${on ? "on" : "off"}** — you now see ${nowSeeing}.`,
    flags: MessageFlags.Ephemeral,
  });
}

function preview(s: string): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > 160 ? `${one.slice(0, 160)}…` : one;
}
function trimLabel(s: string): string {
  return s.length > 60 ? `${s.slice(0, 60)}…` : s;
}

/** Resolve a `/reveal to:` string to a character or the party in this campaign. */
async function resolveRevealTarget(
  campaignId: string,
  to: string,
): Promise<{ characterId?: string; partyId?: string; label: string } | null> {
  const norm = to.trim().toLowerCase();
  if (["party", "the party", "everyone", "all", "everybody"].includes(norm)) {
    const party = await prisma.party.findFirst({
      where: { campaignId },
    });
    return party ? { partyId: party.id, label: "the party" } : null;
  }
  const character = await prisma.character.findFirst({
    where: {
      campaignId,
      name: { contains: to.trim(), mode: "insensitive" },
    },
  });
  return character
    ? { characterId: character.id, label: character.name }
    : null;
}

/** Where a PARTY reveal gets announced: explicit `in:` → the configured default channel
 * (HEARTH_REVEAL_CHANNEL_ID — becomes a per-campaign setting under multi-tenancy) → the
 * channel the command was run in. (Character reveals DM the player, so this is unused there.) */
async function resolveRevealChannelId(
  interaction: ChatInputCommandInteraction,
  campaignId: string,
): Promise<string> {
  const chosen = interaction.options.getChannel("in");
  if (chosen) return chosen.id;
  const settings = await getCampaignDiscord(campaignId);
  return settings?.revealChannelId ?? interaction.channelId ?? "";
}

/**
 * Turn the ids a model named back into things that can actually be offered.
 *
 * This is where an id stops being a claim and becomes a row. The reply parser checked the SHAPE
 * of each reference; nothing has yet checked that it exists, belongs to this campaign, or hasn't
 * been retired by a correction. A reveal is one-way, so anything that fails those checks is
 * dropped silently rather than shown to the DM as something they could release.
 */
async function resolvePicks(
  campaignId: string,
  picks: RevealPick[],
): Promise<RevealCandidate[]> {
  const resolved: RevealCandidate[] = [];
  for (const pick of picks) {
    if (pick.kind === "unit") {
      const unit = await prisma.knowledgeUnit.findFirst({
        where: {
          id: pick.id,
          campaignId,
          supersededByCorrectionId: null,
          // Never offer a fact nobody can trace to its source as something to reveal.
          provenance: { not: "UNSOURCED" },
        },
        select: { id: true, title: true, content: true },
      });
      if (unit) {
        resolved.push({
          kind: "unit",
          id: unit.id,
          title: unit.title,
          body: unit.content,
          ...(pick.why ? { why: pick.why } : {}),
        });
      }
      continue;
    }
    const chunk = await prisma.documentChunk.findFirst({
      where: { id: pick.id, campaignId, supersededByCorrectionId: null },
      select: {
        id: true,
        text: true,
        sourceDocument: { select: { name: true } },
      },
    });
    if (chunk) {
      resolved.push({
        kind: "passage",
        id: chunk.id,
        title: chunk.sourceDocument.name,
        // A fallback only: the preview widens a passage to its whole section, and uses this if
        // that comes back empty.
        body: chunk.text,
        ...(pick.why ? { why: pick.why } : {}),
      });
    }
  }
  return resolved;
}

/** /reveal — DM only. Find what `about` refers to — from the whole library when it fits, from
 * retrieval when it doesn't — then show the DM exactly what they'd release, with Confirm/Cancel
 * buttons. Nothing is granted until they click. (A one-way action, so it must be previewed.) */
async function handleReveal(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const viewer = await resolveViewer(interaction.guildId, interaction.user.id);
  if (!viewer || viewer.role !== "DM") {
    await interaction.editReply(
      "Only the DM can reveal things from the memory.",
    );
    return;
  }
  const about = interaction.options.getString("about", true);
  const to = interaction.options.getString("to", true);

  const target = await resolveRevealTarget(viewer.campaignId, to);
  if (!target) {
    await interaction.editReply(
      `Couldn't find a character or party matching "${to}".`,
    );
    return;
  }
  const isParty = !target.characterId;
  const scope = target.characterId
    ? `c:${target.characterId}`
    : `p:${target.partyId}`;
  // Resolve the announce channel now (for party reveals) and bake it into the button, so the
  // confirm handler posts exactly where the preview promised. Character reveals DM the player.
  const channelId = isParty
    ? await resolveRevealChannelId(interaction, viewer.campaignId)
    : "";
  // Check that the announcement can actually be delivered BEFORE anything is granted. A reveal
  // is one-way: granting first and discovering at announce time that the channel is unreachable
  // leaves a player holding knowledge nobody ever told them, and no way to take it back.
  if (isParty && channelId) {
    const missing = await revealChannelBlockers(interaction, channelId);
    if (missing === null) {
      await interaction.editReply(
        `I can't see <#${channelId}>, so nothing has been revealed. Point me at a channel I can read with \`/setup reveals:#channel\`, or name one here with \`in:\`.`,
      );
      return;
    }
    if (missing.length > 0) {
      await interaction.editReply(
        `I can't post in <#${channelId}>, so nothing has been revealed. Grant me **${missing.join(", ")}** there — a private channel needs me added to it directly — or choose another with \`/setup reveals:#channel\`.`,
      );
      return;
    }
  }
  const suffix = `${scope}:${channelId}`;

  // Choose from the whole library when it fits, and only fall back to retrieval when it doesn't.
  //
  // Ranking a retrieved shortlist can only reorder what similarity already picked, so the wrong
  // Moira can still be the only Moira on the list. Reading everything the DM may see removes that
  // failure at the source — and it sends the same cacheable block /ask does, so a reveal during a
  // session usually reads a cache that is already warm.
  const corpus = await buildCorpus(viewer);
  let candidates: RevealCandidate[] = [];
  if (corpus.manifest.complete && corpus.manifest.tokens > 0) {
    candidates = await resolvePicks(
      viewer.campaignId,
      await chooseFromCorpus(about, corpus),
    );
  }
  if (candidates.length === 0 && !corpus.manifest.complete) {
    const { units, chunks } = await retrieveContext(viewer, about, {
      unitLimit: 12,
      chunkLimit: 6,
    });
    candidates = await rankRevealCandidates(about, units, chunks);
  }
  if (candidates.length === 0) {
    await interaction.editReply(`Nothing in the memory matched "${about}".`);
    return;
  }

  const destination = isParty
    ? channelId
      ? `📣 Will be announced in <#${channelId}>`
      : "📣 (no announce channel available — it'll still be revealed)"
    : `✉️ Will be sent privately to ${target.label}`;
  // Work out what is actually on offer BEFORE writing any of it down. Two passages can sit in
  // the same section and both widen to the same piece, so a model naming both would offer the DM
  // the same recap twice — identical down to the word count, with no way to tell the buttons
  // apart. Dropping those duplicates changes how many offers there are, which decides both the
  // numbering and whether this screen says "pick" or "confirm"; deciding any of that from the
  // candidate list would number the buttons wrongly the moment one was dropped.
  interface Offer {
    label: string;
    line: string;
    customId: string;
    style: ButtonStyle;
  }
  const offers: Offer[] = [];
  const shownSections = new Set<string>();
  for (const candidate of candidates) {
    const why = candidate.why ? ` — _${candidate.why}_` : "";
    if (candidate.kind === "unit") {
      offers.push({
        label: trimLabel(candidate.title),
        line: `📌 **${candidate.title}**${why}\n> ${preview(candidate.body)}`,
        customId: `rv:u:${candidate.id}:${suffix}`,
        style: ButtonStyle.Success,
      });
      continue;
    }
    // Widen the matched passage to the whole section it sits in. A passage is a ~1500-char slice,
    // so revealing one hands over part of a recap; the DM meant the recap. The button carries the
    // anchor and the section is worked out again on click — the boundary rules are deterministic,
    // and a Discord custom id can't hold a list of passage ids.
    const passages = await sectionPassages(candidate.id);
    const body = passages.length ? joinPassages(passages) : candidate.body;
    const title = sectionTitle(passages, candidate.title);
    // A section's identity is its first passage: any anchor inside it widens to the same piece.
    const sectionKey = passages[0]?.id ?? candidate.id;
    if (shownSections.has(sectionKey)) continue;
    shownSections.add(sectionKey);
    // Say how much this releases before they press it.
    const size =
      passages.length > 1
        ? ` · ${passages.length} passages, ~${wordCount(body)} words`
        : ` · ~${wordCount(body)} words`;
    offers.push({
      label: trimLabel(title),
      line: `📄 **${title}** — from ${candidate.title}${size}${why}\n> ${preview(body)}`,
      customId: `rv:s:${candidate.id}:${suffix}`,
      style: ButtonStyle.Primary,
    });
  }

  const lines = [
    offers.length > 1
      ? `**Reveal to ${target.label}** — pick what to release:`
      : `**Reveal to ${target.label}** — confirm what to release:`,
    destination,
  ];
  const buttons: ButtonBuilder[] = [];
  offers.forEach((offer, i) => {
    const n = offers.length > 1 ? `${i + 1}. ` : "";
    lines.push(`\n${n}${offer.line}`);
    buttons.push(
      new ButtonBuilder()
        .setCustomId(offer.customId)
        .setLabel(`${n}${offer.label}`)
        .setStyle(offer.style),
    );
  });
  buttons.push(
    new ButtonBuilder()
      .setCustomId("rv:x")
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.editReply({
    content: lines.join("\n"),
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)],
  });
}

// Discord caps an embed's description at 4096 characters, and revealEmbed truncates to fit. A
// revealed section runs longer than that, and silently cutting it would hand the party a fragment
// while telling the DM the piece was sent — the same failure this change exists to remove. So a
// long body goes out as several embeds (Discord allows ten per message), split on paragraph
// breaks. If it somehow still doesn't fit, the last embed says so rather than ending mid-sentence.
const MAX_EMBEDS = 10;

/** The reveal as one or more embeds — several when the piece is longer than one embed holds. */
function revealEmbeds(
  subjectLabel: string,
  itemTitle: string,
  body: string,
  theme: string,
): EmbedBuilder[] {
  const parts = splitForEmbeds(body);
  const shown = parts.slice(0, MAX_EMBEDS);
  if (parts.length > MAX_EMBEDS) {
    shown[MAX_EMBEDS - 1] +=
      "\n\n*(this piece is longer than one message holds — ask the memory for the rest)*";
  }
  return shown.map((part, i) =>
    revealEmbed(
      subjectLabel,
      i === 0 ? itemTitle : `${itemTitle} (continued)`,
      part,
      theme,
    ),
  );
}

/** After a grant is created, surface it: DM the player (character reveal) or post to the
 * reveals channel (party reveal) with the ✨ discovered embed — the reveal IS the announcement,
 * so the content rides along.
 *
 * Returns whether it actually reached anyone, and a note for the DM's confirmation. The grant
 * stands even when delivery fails (closed DMs, missing channel, …), so the caller has to be able
 * to say so — telling the DM a reveal landed when nobody saw it is worse than saying nothing. */
async function announceReveal(
  kind: string,
  targetId: string,
  scopeType: string,
  scopeId: string,
  chanId: string,
  theme: string,
): Promise<{ delivered: boolean; note: string }> {
  let itemTitle: string;
  let body: string;
  if (kind === "u") {
    // A reveal button can be clicked long after it was posted, by which time a correction may
    // have retired this fact — announcing it would publish a version the table has disowned.
    const u = await prisma.knowledgeUnit.findFirst({
      where: { id: targetId, supersededByCorrectionId: null },
      select: { title: true, content: true },
    });
    itemTitle = u?.title ?? "a memory";
    body = u?.content ?? "";
  } else if (kind === "s") {
    // The whole section, joined and de-overlapped — what the DM was shown the size of.
    const passages = await sectionPassages(targetId);
    itemTitle = passages.length
      ? sectionTitle(passages, "From the DM's notes")
      : "a passage";
    body = joinPassages(passages);
  } else if (kind === "p") {
    // Same reason as above: a correction can retire a passage between the preview and the click.
    const c = await prisma.documentChunk.findFirst({
      where: { id: targetId, supersededByCorrectionId: null },
      select: { text: true, sourceDocument: { select: { name: true } } },
    });
    // Never the document's name: players see this, and a file name can give away what the passage
    // alone doesn't. Sources are for the DM.
    itemTitle = c ? "From the DM's notes" : "a passage";
    body = c?.text ?? "";
  } else {
    // Whole-document grants still exist and are still honoured — /reveal just no longer offers
    // one, so a document can only be released deliberately rather than as a near-miss.
    const d = await prisma.sourceDocument.findUnique({
      where: { id: targetId },
      select: { name: true },
    });
    itemTitle = d?.name ?? "a document";
    body = "The whole dossier is now yours — ask about anything in it.";
  }

  try {
    if (scopeType === "c") {
      const character = await prisma.character.findUnique({
        where: { id: scopeId },
        include: { membership: { include: { user: true } } },
      });
      const discordUserId = character?.membership.user.discordUserId;
      if (!discordUserId)
        return {
          delivered: false,
          note: "— but I couldn't find the player to notify",
        };
      const user = await client.users.fetch(discordUserId);
      await user.send({ embeds: revealEmbeds("You", itemTitle, body, theme) });
      return {
        delivered: true,
        note: `— sent privately to ${character?.name ?? "them"}`,
      };
    }
    if (!chanId)
      return { delivered: false, note: "— but no announce channel was set" };
    const channel = await client.channels.fetch(chanId);
    if (channel && channel.isTextBased() && !channel.isDMBased()) {
      await channel.send({
        embeds: revealEmbeds("The party", itemTitle, body, theme),
      });
      return { delivered: true, note: `— announced in <#${chanId}>` };
    }
    return { delivered: false, note: "— but I couldn't reach that channel" };
  } catch (err) {
    console.error("reveal announce failed:", err);
    const missingAccess = (err as { code?: number }).code === 50001;
    return {
      delivered: false,
      note: missingAccess
        ? "— but I can't post in that channel. Grant me **View Channel, Send Messages, Embed Links** there, then run `/reveal` again to deliver it"
        : "— but the announcement couldn't be delivered",
    };
  }
}

/** Confirm/Cancel button from /reveal — creates the grant only on confirm, then announces it. */
async function handleRevealButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const [, kind, targetId, scopeType, scopeId, chanId] =
    interaction.customId.split(":");
  if (kind === "x") {
    await interaction.update({ content: "Reveal cancelled.", components: [] });
    return;
  }
  const viewer = await resolveViewer(interaction.guildId, interaction.user.id);
  if (!viewer || viewer.role !== "DM") {
    await interaction.update({
      content: "Only the DM can confirm a reveal.",
      components: [],
    });
    return;
  }
  const membership = await prisma.membership.findFirst({
    where: {
      campaignId: viewer.campaignId,
      user: { discordUserId: interaction.user.id },
    },
    select: { id: true },
  });
  if (!membership) {
    await interaction.update({
      content: "Couldn't resolve you.",
      components: [],
    });
    return;
  }
  // Ack now — announcing (DB + Discord sends) can take longer than the 3s button window.
  await interaction.deferUpdate();
  const scope =
    scopeType === "c" ? { characterId: scopeId } : { partyId: scopeId };
  // A section is many passages released together — either the piece went out or it didn't. The
  // button carries only the anchor, so the section is worked out again here; the boundary rules
  // are deterministic, so this is the same section the DM was shown.
  let revealed: boolean;
  if (kind === "s") {
    const passages = await sectionPassages(targetId!);
    const result = await revealPassages(
      passages.map((p) => p.id),
      scope,
      membership.id,
    );
    revealed = result.revealed > 0;
  } else {
    const revealTarget =
      kind === "u"
        ? { unitId: targetId }
        : kind === "p"
          ? { chunkId: targetId }
          : { documentId: targetId };
    revealed = (await revealTo(revealTarget, scope, membership.id)).revealed;
  }
  if (!revealed) {
    await interaction.editReply({
      content: "That was already revealed.",
      components: [],
    });
    return;
  }
  const { delivered, note } = await announceReveal(
    kind!,
    targetId!,
    scopeType!,
    scopeId!,
    chanId ?? "",
    viewer.theme,
  );
  // Lead with what actually happened. The grant stands either way, so a ✅ above a message
  // admitting the announcement failed tells the DM the table knows something it doesn't.
  await interaction.editReply({
    content: delivered
      ? `✅ Revealed ${note}`
      : `⚠️ Revealed, but nobody was told ${note}`,
    components: [],
  });
}

// ─── /npc — generate an NPC, match a portrait, review as a draft ─────────────
// Drafts live in memory (transient — the DM accepts/regenerates within minutes). Keyed by a
// random id carried in the button customIds. Lost on restart, which is fine for a draft.
interface NpcDraftState {
  draft: NpcDraft;
  portrait: PortraitMatch | null;
  prompt?: string;
  liveContext?: string; // the scene this NPC was generated for (keeps regen scene-aware)
  channelId: string; // where "Share" posts the player-facing card
  saved?: boolean; // true once Accepted — Share is only offered after saving
  touchedAt: number; // for the TTL sweep — refreshed on every interaction
}
const npcDrafts = new Map<string, NpcDraftState>();

// Bound the draft map: sweep out drafts untouched for a while so accepted-but-never-shared
// (or abandoned) drafts don't leak. Drafts are transient by nature.
const NPC_DRAFT_TTL_MS = 30 * 60_000;
setInterval(() => {
  const now = Date.now();
  for (const [id, e] of npcDrafts) {
    if (now - e.touchedAt > NPC_DRAFT_TTL_MS) npcDrafts.delete(id);
  }
}, 10 * 60_000).unref();

/** Build the draft reply: the card embed with the matched portrait as a thumbnail (also a
 * downloadable attachment) + Accept / Regenerate buttons. */
async function npcDraftReply(draftId: string, theme: string) {
  const entry = npcDrafts.get(draftId);
  if (!entry) return null;
  const { draft, portrait } = entry;

  const files: AttachmentBuilder[] = [];
  let thumb: string | undefined;
  if (portrait) {
    try {
      const bytes = await getPortrait(portrait.storagePath);
      thumb = `${safeFileName(draft.name)}.png`;
      files.push(new AttachmentBuilder(bytes, { name: thumb }));
    } catch (err) {
      console.error("npc portrait fetch failed:", err);
    }
  }
  // Share is intentionally absent here — it's offered only after Accept & save.
  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`npc:accept:${draftId}`)
      .setLabel("Accept & save")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`npc:edit:${draftId}`)
      .setLabel("Edit")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`npc:regen:${draftId}`)
      .setLabel("Regenerate")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`npc:dismiss:${draftId}`)
      .setLabel("Dismiss")
      .setStyle(ButtonStyle.Danger),
  );
  return {
    embeds: [npcEmbed(draft, portrait?.label ?? null, theme, thumb)],
    files,
    attachments: [],
    components: [buttons],
  };
}

/** /npc — DM only. Generate a grounded NPC + matched portrait, shown as a draft to review. */
async function handleNpc(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const viewer = await resolveViewer(
      interaction.guildId,
      interaction.user.id,
    );
    if (!viewer) {
      await interaction.editReply("You're not part of this campaign.");
      return;
    }
    if (viewer.role !== "DM") {
      await interaction.editReply("Only the DM can generate NPCs.");
      return;
    }
    const prompt = interaction.options.getString("prompt") ?? undefined;
    const channelId = await resolveRevealChannelId(
      interaction,
      viewer.campaignId,
    );
    // live:true grounds the NPC in the scene playing out right now (needs an active
    // recording — that's what fills the live transcript buffer).
    let liveContext: string | undefined;
    if (interaction.options.getBoolean("live")) {
      const session = await getActiveSession(viewer.campaignId);
      if (!session) {
        await interaction.editReply(
          "No session is being recorded — start one with `/record`, or drop `live:true`.",
        );
        return;
      }
      liveContext = await getLiveTranscript(session.gameSessionId, 10);
      if (!liveContext) {
        await interaction.editReply(
          "Nothing's been transcribed yet from this scene — give it a minute of talking, then try again.",
        );
        return;
      }
    }
    const draft = await generateNpc(viewer.campaignId, prompt, liveContext);
    const portrait = await matchPortrait(
      portraitQuery(draft.race, draft.role, draft.appearance),
      viewer.campaignId,
    );
    const draftId = randomUUID();
    npcDrafts.set(draftId, {
      draft,
      portrait,
      prompt,
      liveContext,
      channelId,
      touchedAt: Date.now(),
    });
    const payload = await npcDraftReply(draftId, viewer.theme);
    if (payload) await interaction.editReply(payload);
  } catch (err) {
    console.error("/npc failed:", err);
    await interaction
      .editReply("Something went wrong generating that NPC.")
      .catch(() => {});
  }
}

/** Accept / Regenerate button from /npc. */
async function handleNpcButton(interaction: ButtonInteraction): Promise<void> {
  const [, action, draftId] = interaction.customId.split(":");
  const viewer = await resolveViewer(interaction.guildId, interaction.user.id);
  if (!viewer || viewer.role !== "DM") {
    await interaction.reply({
      content: "Only the DM can do that.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const entry = draftId ? npcDrafts.get(draftId) : undefined;
  if (!entry || !draftId) {
    await interaction.update({
      content: "That NPC draft expired — run `/npc` again.",
      embeds: [],
      components: [],
      files: [],
    });
    return;
  }

  // Edit opens a modal, which MUST be the interaction's first response (no defer before it).
  if (action === "edit") {
    await interaction.showModal(npcEditModal(draftId, entry.draft));
    return;
  }
  if (action === "dismiss") {
    npcDrafts.delete(draftId);
    await interaction.update({
      content: "🗑️ Draft discarded.",
      embeds: [],
      components: [],
      files: [],
    });
    return;
  }

  // Ack, then run the deferred work inside ONE try/catch — a throw in generate/match/save/fetch
  // must not leave the DM's interaction spinning with no reply.
  await interaction.deferUpdate();
  try {
    await runNpcButtonAction(interaction, action ?? "", draftId, entry, viewer);
  } catch (err) {
    console.error("npc button action failed:", err);
    await interaction
      .editReply({
        content: "Something went wrong with that — try again.",
        embeds: [],
        components: [],
      })
      .catch(() => {});
  }
}

/** The deferred /npc button actions (regen / accept / share). Extracted so handleNpcButton
 * can wrap them in a single try/catch. */
async function runNpcButtonAction(
  interaction: ButtonInteraction,
  action: string,
  draftId: string,
  entry: NpcDraftState,
  viewer: ResolvedViewer,
): Promise<void> {
  if (action === "regen") {
    const draft = await generateNpc(
      viewer.campaignId,
      entry.prompt,
      entry.liveContext,
    );
    const portrait = await matchPortrait(
      portraitQuery(draft.race, draft.role, draft.appearance),
      viewer.campaignId,
    );
    npcDrafts.set(draftId, {
      ...entry,
      draft,
      portrait,
      touchedAt: Date.now(),
    });
    const payload = await npcDraftReply(draftId, viewer.theme);
    if (payload) await interaction.editReply(payload);
    return;
  }
  if (action === "accept") {
    await saveNpc(viewer.campaignId, entry.draft, entry.portrait?.storagePath);
    entry.saved = true; // keep the draft so Share can use it now that it's saved
    entry.touchedAt = Date.now(); // and refresh it so the TTL sweep doesn't drop it pre-Share
    const name = safeFileName(entry.draft.name);
    const files: AttachmentBuilder[] = [
      new AttachmentBuilder(
        Buffer.from(
          npcCardMarkdown(entry.draft, entry.portrait?.label ?? null),
          "utf8",
        ),
        { name: `${name}.md` },
      ),
    ];
    if (entry.portrait) {
      try {
        files.push(
          new AttachmentBuilder(await getPortrait(entry.portrait.storagePath), {
            name: `${name}.png`,
          }),
        );
      } catch (err) {
        console.error("npc portrait fetch failed:", err);
      }
    }
    // Now that it's saved, offer Share.
    const shareRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`npc:share:${draftId}`)
        .setLabel("Share to channel")
        .setStyle(ButtonStyle.Secondary),
    );
    await interaction.editReply({
      content: `✅ Saved **${entry.draft.name}** to the memory (DM-only). Your copies are below — share it with the party when you're ready.`,
      embeds: [],
      components: [shareRow],
      attachments: [],
      files,
    });
    return;
  }
  if (action === "share") {
    // Only after Accept & save. Post the PLAYER-facing card (no secret) to the channel; the NPC
    // is already saved, so we don't re-save. Re-attach the DM's downloads for convenience.
    if (!entry.saved) {
      await interaction.editReply({
        content: "Accept & save the NPC first, then share it with the party.",
      });
      return;
    }
    const name = safeFileName(entry.draft.name);
    let portraitBytes: Buffer | undefined;
    if (entry.portrait) {
      try {
        portraitBytes = await getPortrait(entry.portrait.storagePath);
      } catch (err) {
        console.error("npc portrait fetch failed:", err);
      }
    }
    const thumb = portraitBytes ? `${name}.png` : undefined;

    let note = "couldn't reach that channel";
    try {
      const channel = entry.channelId
        ? await client.channels.fetch(entry.channelId)
        : null;
      if (channel && channel.isTextBased() && !channel.isDMBased()) {
        await channel.send({
          embeds: [npcShareEmbed(entry.draft, viewer.theme, thumb)],
          files: portraitBytes
            ? [new AttachmentBuilder(portraitBytes, { name: thumb! })]
            : [],
        });
        note = `shared in <#${entry.channelId}>`;
      }
    } catch (err) {
      console.error("npc share failed:", err);
      note =
        (err as { code?: number }).code === 50001
          ? "I can't post in that channel — grant me View Channel + Send Messages + Embed Links"
          : "couldn't post to that channel";
    }

    const downloads: AttachmentBuilder[] = [
      new AttachmentBuilder(
        Buffer.from(
          npcCardMarkdown(entry.draft, entry.portrait?.label ?? null),
          "utf8",
        ),
        { name: `${name}.md` },
      ),
    ];
    if (portraitBytes) {
      downloads.push(
        new AttachmentBuilder(portraitBytes, { name: `${name}.png` }),
      );
    }
    npcDrafts.delete(draftId); // shared + saved — nothing more to do with this draft
    await interaction.editReply({
      content: `✅ **${entry.draft.name}** — ${note}. Players don't see the DM secret. Your copies:`,
      embeds: [],
      components: [],
      attachments: [],
      files: downloads,
    });
  }
}

/** The 5-field edit modal (Discord caps modals at 5 inputs) — the highest-value fields to
 * tweak. Changing race/appearance re-matches the portrait on submit. */
function npcEditModal(draftId: string, d: NpcDraft): ModalBuilder {
  const row = (
    id: string,
    label: string,
    value: string,
    style: TextInputStyle,
    max: number,
  ) =>
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId(id)
        .setLabel(label)
        .setStyle(style)
        .setValue((value ?? "").slice(0, max))
        .setMaxLength(max)
        .setRequired(true),
    );
  return new ModalBuilder()
    .setCustomId(`npcedit:${draftId}`)
    .setTitle("Edit NPC")
    .addComponents(
      row("name", "Name", d.name, TextInputStyle.Short, 100),
      row("race", "Race", d.race, TextInputStyle.Short, 60),
      row(
        "appearance",
        "Appearance (drives the portrait)",
        d.appearance,
        TextInputStyle.Paragraph,
        1000,
      ),
      row("hook", "Hook", d.hook, TextInputStyle.Paragraph, 1000),
      row("secret", "DM secret", d.secret, TextInputStyle.Paragraph, 1000),
    );
}

/** Edit-modal submit — apply the tweaks, re-match the portrait, re-render the draft. */
async function handleNpcEditSubmit(
  interaction: ModalSubmitInteraction,
): Promise<void> {
  const draftId = interaction.customId.split(":")[1];
  const viewer = await resolveViewer(interaction.guildId, interaction.user.id);
  if (!viewer || viewer.role !== "DM") {
    await interaction.reply({
      content: "Only the DM can do that.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const entry = draftId ? npcDrafts.get(draftId) : undefined;
  if (!entry || !draftId) {
    await interaction.reply({
      content: "That NPC draft expired — run `/npc` again.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  const g = (id: string) => interaction.fields.getTextInputValue(id).trim();
  const draft: NpcDraft = {
    ...entry.draft,
    name: g("name"),
    race: g("race"),
    appearance: g("appearance"),
    hook: g("hook"),
    secret: g("secret"),
  };
  const portrait = await matchPortrait(
    portraitQuery(draft.race, draft.role, draft.appearance),
    viewer.campaignId,
  );
  npcDrafts.set(draftId, { ...entry, draft, portrait, touchedAt: Date.now() });
  await interaction.deferUpdate();
  const payload = await npcDraftReply(draftId, viewer.theme);
  if (payload) await interaction.editReply(payload);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once(Events.ClientReady, (c) => {
  console.log(`🔥 Hearth online as ${c.user.tag}`);
  void recoverInterruptedRecordings()
    .then((recovered) => {
      if (recovered.length > 0) {
        console.log(
          `♻️  closed ${recovered.length} recording(s) cut off by a restart — their sessions will finalize`,
        );
      }
    })
    .catch((err) =>
      console.error("recovering interrupted recordings failed:", err),
    );
  if (ALLOWED_GUILDS.size > 0) {
    console.log(
      `🔒 allowlist active — ${ALLOWED_GUILDS.size} approved server(s)`,
    );
  } else {
    console.warn(
      "⚠️  no HEARTH_ALLOWED_GUILDS set — every server this bot is in can use it (and spend our API budget)",
    );
  }
});

// A single unhandled 'error' event will crash the process otherwise (spike lesson).
client.on(Events.Error, (err) => console.error("Discord client error:", err));
process.on("unhandledRejection", (err) =>
  console.error("Unhandled rejection:", err),
);

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // One gate for every command, button, and modal — an unapproved server can't spend
    // anything, because nothing downstream runs.
    if (!interaction.isAutocomplete() && !isGuildAllowed(interaction.guildId)) {
      console.warn(
        `blocked interaction from unapproved guild ${interaction.guildId ?? "(dm)"}`,
      );
      await interaction.reply({
        content:
          "Hearth isn't enabled for this server yet. It's in a limited beta — reach out if you'd like access.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (interaction.isButton()) {
      if (interaction.customId.startsWith("sh:")) {
        await handleShareButton(interaction);
        return;
      }
      if (interaction.customId.startsWith("cx:")) {
        await handleCorrectionButton(interaction);
        return;
      }
      if (interaction.customId.startsWith("rv:")) {
        await handleRevealButton(interaction);
      } else if (interaction.customId.startsWith("npc:")) {
        await handleNpcButton(interaction);
      }
      return;
    }
    if (interaction.isModalSubmit()) {
      if (interaction.customId.startsWith("npcedit:")) {
        await handleNpcEditSubmit(interaction);
      }
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    switch (interaction.commandName) {
      case "ask":
        await handleAsk(interaction);
        break;
      case "record":
        await handleRecord(interaction);
        break;
      case "stop":
        await stopRecording(interaction);
        break;
      case "upload":
        await handleUpload(interaction);
        break;
      case "reveal":
        await handleReveal(interaction);
        break;
      case "journal":
        await handleJournal(interaction);
        break;
      case "npc":
        await handleNpc(interaction);
        break;
      case "recap":
        await handleRecap(interaction);
        break;
      case "missed":
        await handleMissed(interaction);
        break;
      case "correct":
        await handleCorrect(interaction);
        break;
      case "share":
        await handleShare(interaction);
        break;
      case "setup":
        await handleSetup(interaction);
        break;
      case "join":
        await handleJoin(interaction);
        break;
      case "help":
        await handleHelp(interaction);
        break;
      case "dmmode":
        if (DEV_DM_TOGGLE) await handleDmMode(interaction);
        break;
    }
  } catch (err) {
    console.error("interaction failed:", err);
  }
});

await registerCommands();
await client.login(TOKEN);
