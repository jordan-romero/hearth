/** The number the next recorded session gets: one after the latest, or the campaign's first
 * session number when nothing has been recorded yet (above 1 for a campaign that was already
 * running before it came to Hearth). */
export function nextSessionNumber(
  latest: number | null,
  firstSessionNumber: number,
): number {
  if (latest !== null) return latest + 1;
  return Math.max(1, Math.floor(firstSessionNumber));
}
