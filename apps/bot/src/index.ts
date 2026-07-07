// The Hearth bot — a thin adapter (no business logic here, per architecture.md):
// resolve who's asking → call the shared ask() pipeline → reply EPHEMERALLY so
// an answer can never leak to the channel.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChannelType,
  ChatInputCommandInteraction,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
} from "discord.js";
import { prisma } from "@hearth/db";
import type { Viewer } from "@hearth/core";
import {
  ask,
  putDocument,
  getQueue,
  retrieveContext,
  revealTo,
  addJournalNote,
  INGEST_QUEUE,
  type IngestJob,
} from "@hearth/agents";
import { startRecording, stopRecording } from "./capture.js";
import { answerEmbed, revealEmbed, journalEmbed } from "./embeds.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const TOKEN = requireEnv("DISCORD_BOT_TOKEN");
const CLIENT_ID = requireEnv("DISCORD_CLIENT_ID");
const GUILD_ID = process.env.DISCORD_GUILD_ID; // optional → instant guild registration
const CAMPAIGN_ID = process.env.HEARTH_CAMPAIGN_ID ?? "seed-ondera";

// DEV ONLY: with HEARTH_DEV_DM_TOGGLE=1, `/dmmode` lets a member view the campaign as the
// DM (to test DM_ONLY content). Gated behind the flag so it can never exist in a real
// multi-tenant deployment, where players must not self-promote.
const DEV_DM_TOGGLE = process.env.HEARTH_DEV_DM_TOGGLE === "1";
const dmOverride = new Set<string>(); // discord user ids currently viewing as the DM

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

const dmModeCommand = new SlashCommandBuilder()
  .setName("dmmode")
  .setDescription("(dev) Toggle viewing the campaign as the DM.");

async function registerCommands(): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  const body = [
    askCommand.toJSON(),
    recordCommand.toJSON(),
    stopCommand.toJSON(),
    uploadCommand.toJSON(),
    revealCommand.toJSON(),
    journalCommand.toJSON(),
  ];
  if (DEV_DM_TOGGLE) body.push(dmModeCommand.toJSON());
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body,
    });
    // Clear any global commands of the same name so they don't show as duplicates.
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });
    console.log(`Registered commands to guild ${GUILD_ID}`);
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body });
    console.log("Registered commands globally (can take ~1h to appear)");
  }
}

/** A resolved viewer plus the display name of their character (for in-world presentation).
 * The core `Viewer` stays pure — the name rides alongside only for the bot's UI. */
type ResolvedViewer = Viewer & {
  characterName: string | null;
  membershipId: string;
  theme: string;
};

/** Resolve the Discord author to a permission viewer within the campaign. */
async function resolveViewer(
  discordUserId: string,
): Promise<ResolvedViewer | null> {
  const user = await prisma.user.findUnique({
    where: { discordUserId },
    include: {
      memberships: {
        where: { campaignId: CAMPAIGN_ID },
        include: {
          characters: { where: { campaignId: CAMPAIGN_ID }, take: 1 },
          campaign: { select: { theme: true } },
        },
      },
    },
  });

  const membership = user?.memberships[0];
  if (!membership) return null;
  const character = membership.characters[0];
  // Dev DM-view override (see /dmmode) — treat this member as the DM so DM_ONLY content
  // is visible. Never active unless HEARTH_DEV_DM_TOGGLE=1.
  const role =
    DEV_DM_TOGGLE && dmOverride.has(discordUserId) ? "DM" : membership.role;
  return {
    campaignId: CAMPAIGN_ID,
    role,
    characterId: character?.id ?? null,
    partyId: character?.partyId ?? null,
    characterName: character?.name ?? null,
    membershipId: membership.id,
    theme: membership.campaign.theme,
  };
}

/** /ask — answer from the memory, filtered to what the asker's character knows. */
async function handleAsk(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const question = interaction.options.getString("question", true);

  // Ephemeral: only the asker sees the answer — nothing leaks to the table.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const viewer = await resolveViewer(interaction.user.id);
    if (!viewer) {
      await interaction.editReply(
        "You're not linked to a character in this campaign yet.",
      );
      return;
    }
    const result = await ask(viewer, question);
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
    const viewer = await resolveViewer(interaction.user.id);
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
      CAMPAIGN_ID,
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

/** /upload — ingest a document into the DM_ADDED corpus (parse → chunk → embed). */
async function handleUpload(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const viewer = await resolveViewer(interaction.user.id);
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
    const doc = await prisma.sourceDocument.create({
      data: {
        campaignId: CAMPAIGN_ID,
        name: attachment.name,
        sourceType: "UPLOAD",
        mimeType: attachment.contentType ?? null,
        status: "PENDING",
        extractUnits,
      },
    });
    // Tenant-scoped key: {campaignId}/{docId}/{safe-name}.
    const safeName = attachment.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const key = `${CAMPAIGN_ID}/${doc.id}/${safeName}`;
    await putDocument(key, data, attachment.contentType ?? undefined);
    await prisma.sourceDocument.update({
      where: { id: doc.id },
      data: { storagePath: key },
    });

    const boss = await getQueue();
    const job: IngestJob = { sourceDocumentId: doc.id };
    await boss.send(INGEST_QUEUE, job);

    console.log(
      `📄 upload: "${attachment.name}" (${data.length} bytes) → ${doc.id} queued`,
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
  const on = !dmOverride.has(id);
  if (on) dmOverride.add(id);
  else dmOverride.delete(id);
  await interaction.reply({
    content: on
      ? "🎭 DM view **on** — you now see everything in the campaign (DM_ONLY included)."
      : "🎭 DM view **off** — back to your character's knowledge.",
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
  to: string,
): Promise<{ characterId?: string; partyId?: string; label: string } | null> {
  const norm = to.trim().toLowerCase();
  if (["party", "the party", "everyone", "all", "everybody"].includes(norm)) {
    const party = await prisma.party.findFirst({
      where: { campaignId: CAMPAIGN_ID },
    });
    return party ? { partyId: party.id, label: "the party" } : null;
  }
  const character = await prisma.character.findFirst({
    where: {
      campaignId: CAMPAIGN_ID,
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
function resolveRevealChannelId(
  interaction: ChatInputCommandInteraction,
): string {
  const chosen = interaction.options.getChannel("in");
  if (chosen) return chosen.id;
  return process.env.HEARTH_REVEAL_CHANNEL_ID ?? interaction.channelId ?? "";
}

/** /reveal — DM only. Find the best matching fact + document for `about`, then show the DM
 * exactly what they'd release, with Confirm/Cancel buttons — nothing is granted until they
 * click. (A one-way action, so it must be previewed first.) */
async function handleReveal(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const viewer = await resolveViewer(interaction.user.id);
  if (!viewer || viewer.role !== "DM") {
    await interaction.editReply(
      "Only the DM can reveal things from the memory.",
    );
    return;
  }
  const about = interaction.options.getString("about", true);
  const to = interaction.options.getString("to", true);

  const target = await resolveRevealTarget(to);
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
  const channelId = isParty ? resolveRevealChannelId(interaction) : "";
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
  const viewer = await resolveViewer(interaction.user.id);
  if (!viewer || viewer.role !== "DM") {
    await interaction.update({
      content: "Only the DM can confirm a reveal.",
      components: [],
    });
    return;
  }
  const membership = await prisma.membership.findFirst({
    where: {
      campaignId: CAMPAIGN_ID,
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

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once(Events.ClientReady, (c) =>
  console.log(`🔥 Hearth online as ${c.user.tag}`),
);

// A single unhandled 'error' event will crash the process otherwise (spike lesson).
client.on(Events.Error, (err) => console.error("Discord client error:", err));
process.on("unhandledRejection", (err) =>
  console.error("Unhandled rejection:", err),
);

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton()) {
      if (interaction.customId.startsWith("rv:")) {
        await handleRevealButton(interaction);
      }
      return;
    }
    if (!interaction.isChatInputCommand()) return;
    switch (interaction.commandName) {
      case "ask":
        await handleAsk(interaction);
        break;
      case "record":
        await startRecording(interaction, CAMPAIGN_ID);
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
