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
  getPortrait,
  retrieveContext,
  revealTo,
  addJournalNote,
  generateNpc,
  matchPortrait,
  portraitQuery,
  saveNpc,
  getActiveSession,
  getLiveTranscript,
  ingestUpload,
  proposeCorrection,
  applyCorrection,
  rejectCorrection,
  summarizeRecent,
  resolveCampaignId,
  resolveMember,
  getCampaignDiscord,
  setupCampaign,
  joinCampaign,
  type ResolvedMember,
  type NpcDraft,
  type PortraitMatch,
} from "@hearth/agents";
import { startRecording, stopRecording } from "./capture.js";
import {
  answerEmbed,
  revealEmbed,
  journalEmbed,
  npcEmbed,
  npcShareEmbed,
  npcCardMarkdown,
  safeFileName,
  helpEmbed,
  recapEmbed,
  correctionEmbeds,
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
  .setDescription("Create this server's campaign and make yourself the DM.")
  .addStringOption((o) =>
    o
      .setName("name")
      .setDescription("What's the campaign called?")
      .setRequired(true),
  )
  .addStringOption((o) =>
    o
      .setName("dm_name")
      .setDescription(
        "What should we call you at the table? (labels your lines in transcripts)",
      ),
  );

const joinCommand = new SlashCommandBuilder()
  .setName("join")
  .setDescription("Join this server's campaign with your character.")
  .addStringOption((o) =>
    o
      .setName("character")
      .setDescription("Your character's name")
      .setRequired(true),
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

const recapCommand = new SlashCommandBuilder()
  .setName("recap")
  .setDescription("What did I miss? Catch up on the session.")
  .addIntegerOption((o) =>
    o
      .setName("minutes")
      .setDescription("How far back to catch up (default 10)")
      .setMinValue(1)
      .setMaxValue(120),
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
    correctCommand.toJSON(),
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
    await interaction.editReply({
      embeds: [
        answerEmbed(
          viewer,
          viewer.characterName,
          question,
          result,
          viewer.theme,
        ),
      ],
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
    const perms = interaction.memberPermissions;
    if (!perms?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.editReply(
        "You need the **Manage Server** permission to set up a campaign here.",
      );
      return;
    }
    const name = interaction.options.getString("name", true);
    const dmName = interaction.options.getString("dm_name") ?? undefined;
    const result = await setupCampaign(
      guildId,
      interaction.user.id,
      interaction.user.username,
      name,
      dmName,
    );
    if (result.alreadyExisted) {
      await interaction.editReply(
        `This server already runs **${result.campaignName}** — players can \`/join\`.`,
      );
      return;
    }
    await interaction.editReply(
      `🔥 **${result.campaignName}** is live and you're the DM.\n` +
        "Players join with `/join character:<name>`. Then `/record` to capture a session, `/upload` your notes, and `/help` for everything else.",
    );
  } catch (err) {
    console.error("/setup failed:", err);
    await interaction
      .editReply("Something went wrong setting up the campaign.")
      .catch(() => {});
  }
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
    const result = await joinCampaign(
      campaignId,
      interaction.user.id,
      interaction.user.username,
      characterName,
    );
    await interaction.editReply(
      result.renamed
        ? `Your character is now **${result.characterName}**.`
        : `🎲 Welcome — you're playing **${result.characterName}**. Try \`/ask\` to see what they know, or \`/journal\` to keep private notes.`,
    );
  } catch (err) {
    console.error("/join failed:", err);
    await interaction
      .editReply("Something went wrong joining the campaign.")
      .catch(() => {});
  }
}

/** /recap — catch up on the session. While one is being recorded that's a summary of the last
 * few minutes of live table talk; otherwise it's the stored recap of the last finished session.
 * Both are table-audible, so there's nothing to permission-filter. */
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
    const minutes = interaction.options.getInteger("minutes") ?? 10;
    const live = await getActiveSession(viewer.campaignId);

    if (live) {
      const transcript = await getLiveTranscript(live.gameSessionId, minutes);
      if (!transcript) {
        await interaction.editReply(
          `Nothing's been transcribed in the last ${minutes} minutes — it may still be catching up.`,
        );
        return;
      }
      const summary = await summarizeRecent(transcript);
      await interaction.editReply({
        embeds: [
          recapEmbed(
            `⏪ The last ${minutes} minutes`,
            summary,
            `Session ${live.number} · in progress`,
            viewer.theme,
          ),
        ],
      });
      return;
    }

    // No live session — fall back to the last finished session's recap.
    const last = await prisma.gameSession.findFirst({
      where: { campaignId: viewer.campaignId, recap: { not: null } },
      orderBy: { number: "desc" },
      select: { number: true, title: true, recap: true },
    });
    if (!last?.recap) {
      await interaction.editReply(
        "No sessions have been recorded yet — the DM can start one with `/record`.",
      );
      return;
    }
    await interaction.editReply({
      embeds: [
        recapEmbed(
          last.title ?? `Session ${last.number}`,
          last.recap,
          `Session ${last.number} · last time`,
          viewer.theme,
        ),
      ],
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

/** /record — resolve this server's campaign, then start capture. */
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
  if (viewer.role !== "DM") {
    await interaction.reply({
      content: "Only the DM can start a recording.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
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
    const doc = await ingestUpload(
      viewer.campaignId,
      attachment.name,
      data,
      attachment.contentType ?? undefined,
      extractUnits,
    );

    console.log(
      `📄 upload: "${attachment.name}" (${data.length} bytes) → ${doc.documentId} queued`,
    );
    await interaction.editReply(
      `📄 Uploaded **${attachment.name}** — parsing it into the memory.`,
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

/** /reveal — DM only. Find the best matching fact + document for `about`, then show the DM
 * exactly what they'd release, with Confirm/Cancel buttons — nothing is granted until they
 * click. (A one-way action, so it must be previewed first.) */
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
  const suffix = `${scope}:${channelId}`;

  const { units, chunks } = await retrieveContext(viewer, about, {
    unitLimit: 1,
    chunkLimit: 1,
  });
  const unit = units[0];
  const chunk = chunks[0];
  if (!unit && !chunk) {
    await interaction.editReply(`Nothing in the memory matched "${about}".`);
    return;
  }

  const destination = isParty
    ? channelId
      ? `📣 Will be announced in <#${channelId}>`
      : "📣 (no announce channel available — it'll still be revealed)"
    : `✉️ Will be sent privately to ${target.label}`;
  const lines = [
    `**Reveal to ${target.label}** — confirm what to release:`,
    destination,
  ];
  const buttons: ButtonBuilder[] = [];
  if (unit) {
    lines.push(
      `\n📌 **${unit.title}** (${unit.type})\n> ${preview(unit.content)}`,
    );
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`rv:u:${unit.id}:${suffix}`)
        .setLabel(`Reveal: ${trimLabel(unit.title)}`)
        .setStyle(ButtonStyle.Success),
    );
  }
  if (chunk) {
    lines.push(
      `\n📄 **${chunk.docName}** (whole document)\n> ${preview(chunk.text)}`,
    );
    buttons.push(
      new ButtonBuilder()
        .setCustomId(`rv:d:${chunk.sourceDocumentId}:${suffix}`)
        .setLabel(`Reveal doc: ${trimLabel(chunk.docName)}`)
        .setStyle(ButtonStyle.Primary),
    );
  }
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

/** After a grant is created, surface it: DM the player (character reveal) or post to the
 * reveals channel (party reveal) with the ✨ discovered embed — the reveal IS the announcement,
 * so the content rides along. Returns a short note for the DM's confirmation. The reveal still
 * stands even if the announcement itself fails (closed DMs, missing channel, …). */
async function announceReveal(
  kind: string,
  targetId: string,
  scopeType: string,
  scopeId: string,
  chanId: string,
  theme: string,
): Promise<string> {
  let itemTitle: string;
  let body: string;
  if (kind === "u") {
    const u = await prisma.knowledgeUnit.findUnique({
      where: { id: targetId },
      select: { title: true, content: true },
    });
    itemTitle = u?.title ?? "a memory";
    body = u?.content ?? "";
  } else {
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
        return "— revealed (couldn't find the player to notify)";
      const user = await client.users.fetch(discordUserId);
      await user.send({ embeds: [revealEmbed("You", itemTitle, body, theme)] });
      return `— sent privately to ${character?.name ?? "them"}`;
    }
    if (!chanId) return "— revealed (no announce channel set)";
    const channel = await client.channels.fetch(chanId);
    if (channel && channel.isTextBased() && !channel.isDMBased()) {
      await channel.send({
        embeds: [revealEmbed("The party", itemTitle, body, theme)],
      });
      return `— announced in <#${chanId}>`;
    }
    return "— revealed (couldn't reach that channel)";
  } catch (err) {
    console.error("reveal announce failed:", err);
    const missingAccess = (err as { code?: number }).code === 50001;
    return missingAccess
      ? "— revealed, but I can't post in that channel — grant me View Channel + Send Messages + Embed Links there"
      : "— revealed, but the announcement couldn't be delivered";
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
  const revealTarget =
    kind === "u" ? { unitId: targetId } : { documentId: targetId };
  const scope =
    scopeType === "c" ? { characterId: scopeId } : { partyId: scopeId };
  const { revealed } = await revealTo(revealTarget, scope, membership.id);
  if (!revealed) {
    await interaction.editReply({
      content: "That was already revealed.",
      components: [],
    });
    return;
  }
  const note = await announceReveal(
    kind!,
    targetId!,
    scopeType!,
    scopeId!,
    chanId ?? "",
    viewer.theme,
  );
  await interaction.editReply({
    content: `✅ Revealed ${note}`,
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
      case "correct":
        await handleCorrect(interaction);
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
