// The Hearth bot — a thin adapter (no business logic here, per architecture.md):
// resolve who's asking → call the shared ask() pipeline → reply EPHEMERALLY so
// an answer can never leak to the channel.

import {
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
import { ask } from "@hearth/agents";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const TOKEN = requireEnv("DISCORD_BOT_TOKEN");
const CLIENT_ID = requireEnv("DISCORD_CLIENT_ID");
const GUILD_ID = process.env.DISCORD_GUILD_ID; // optional → instant guild registration
const CAMPAIGN_ID = process.env.HEARTH_CAMPAIGN_ID ?? "seed-ondera";

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

async function registerCommands(): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  const body = [askCommand.toJSON()];
  if (GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
      body,
    });
    // Clear any global command of the same name so it doesn't show as a duplicate.
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: [] });
    console.log(`Registered /ask to guild ${GUILD_ID}`);
  } else {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body });
    console.log("Registered /ask globally (can take ~1h to appear)");
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
  return {
    campaignId: CAMPAIGN_ID,
    role: membership.role,
    characterId: character?.id ?? null,
    partyId: character?.partyId ?? null,
  };
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (c) =>
  console.log(`🔥 Hearth online as ${c.user.tag}`),
);

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || interaction.commandName !== "ask") {
    return;
  }
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
});

await registerCommands();
await client.login(TOKEN);
