// The Hearth bot — a thin adapter (no business logic here, per architecture.md):
// resolve who's asking → call the shared ask() pipeline → reply EPHEMERALLY so
// an answer can never leak to the channel.

import {
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
  INGEST_QUEUE,
  type IngestJob,
} from "@hearth/agents";
import { startRecording, stopRecording } from "./capture.js";

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

/** Resolve the Discord author to a permission viewer within the campaign. */
async function resolveViewer(discordUserId: string): Promise<Viewer | null> {
  const user = await prisma.user.findUnique({
    where: { discordUserId },
    include: {
      memberships: {
        where: { campaignId: CAMPAIGN_ID },
        include: {
          characters: { where: { campaignId: CAMPAIGN_ID }, take: 1 },
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
    const { answer } = await ask(viewer, question);
    const reply = answer.length > 1900 ? `${answer.slice(0, 1900)}…` : answer;
    await interaction.editReply(reply);
  } catch (err) {
    console.error("/ask failed:", err);
    // Never let the fallback itself throw and leave the interaction hanging.
    await interaction
      .editReply("Something went wrong reaching the memory.")
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
    // Real multi-tenancy will gate this to the DM; for the single-tenant demo any
    // member may upload (content is DM_ONLY regardless).

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
  if (!interaction.isChatInputCommand()) return;
  try {
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
      case "dmmode":
        if (DEV_DM_TOGGLE) await handleDmMode(interaction);
        break;
    }
  } catch (err) {
    console.error(`/${interaction.commandName} failed:`, err);
  }
});

await registerCommands();
await client.login(TOKEN);
