// One-off: compress every stored WAV clip to Ogg Opus, keeping all the audio.
//
//   pnpm --filter @hearth/bot compress-clips --dry-run      # count, and size what it would save
//   pnpm --filter @hearth/bot compress-clips --limit 5      # try a few
//   pnpm --filter @hearth/bot compress-clips                # the rest
//
// Each clip is uploaded as .ogg and its row pointed at it before the WAV is deleted, so a run
// stopped part-way loses nothing: start it again and it picks up the clips still on .wav.

import { prisma } from "@hearth/db";
import { deleteClip, getClip, putClip } from "@hearth/agents";
import { wavToOggOpus } from "./compress-wav.js";

const CONCURRENCY = 4;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const dryRun = process.argv.includes("--dry-run");
const limit = arg("--limit") ? Number(arg("--limit")) : undefined;

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;

async function main(): Promise<void> {
  const clips = await prisma.audioClip.findMany({
    where: { storagePath: { endsWith: ".wav" } },
    select: { id: true, storagePath: true },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  console.log(
    `${clips.length} WAV clip(s) to compress${dryRun ? " (dry run — nothing is changed)" : ""}`,
  );

  let done = 0;
  let failed = 0;
  let before = 0;
  let after = 0;
  let next = 0;

  async function work(): Promise<void> {
    while (next < clips.length) {
      const clip = clips[next++]!;
      try {
        const wav = await getClip(clip.storagePath);
        const ogg = wavToOggOpus(wav);
        before += wav.length;
        after += ogg.length;
        if (!dryRun) {
          const key = clip.storagePath.replace(/\.wav$/, ".ogg");
          await putClip(key, ogg);
          await prisma.audioClip.update({
            where: { id: clip.id },
            data: { storagePath: key, codec: "opus" },
          });
          await deleteClip(clip.storagePath);
        }
        done++;
        if (done % 100 === 0 || done === clips.length)
          console.log(
            `  ${done}/${clips.length}  ${mb(before)} → ${mb(after)}`,
          );
      } catch (err) {
        failed++;
        console.error(`  clip ${clip.id} (${clip.storagePath}) failed:`, err);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, work));
  const ratio = after > 0 ? (before / after).toFixed(1) : "—";
  console.log(
    `${dryRun ? "Would compress" : "Compressed"} ${done} clip(s): ${mb(before)} → ${mb(after)} ` +
      `(${ratio}× smaller)${failed ? `; ${failed} failed and were left as WAV` : ""}`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
