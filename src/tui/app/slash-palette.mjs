/*
 * app/slash-palette.mjs — which slash palette (if any) the prompt draft opens.
 */
import { SLASH_COMMANDS, slashQuery, slashCommandMatches, compareSlashCommands } from './slash-commands.mjs';

export function deriveSlashPalette({
  providerPrompt,
  settingsPrompt,
  toolApproval,
  contextPanel,
  usagePanel,
  picker,
  exiting,
  commandBusy,
  promptDraft,
  slashDismissedFor,
}) {
  const activeSlashQuery =
    providerPrompt || settingsPrompt || toolApproval || contextPanel || usagePanel ? null : slashQuery(promptDraft);
  // "Slash mode" is live whenever a /token is being edited and no other
  // surface owns the floating area. The palette stays OPEN for the whole
  // slash session — including 0-match frames — so its 14-row layout never
  // unmounts/remounts per keystroke (fullscreen repaint flicker fix).
  const slashModeLive =
    activeSlashQuery !== null && !picker && !toolApproval && !contextPanel && !usagePanel && !exiting && !commandBusy;
  const slashCommands = !slashModeLive
    ? []
    : SLASH_COMMANDS.filter((command) => slashCommandMatches(command, activeSlashQuery)).sort(compareSlashCommands);
  const slashPaletteOpen = slashModeLive && slashDismissedFor !== promptDraft;
  return { activeSlashQuery, slashCommands, slashPaletteOpen };
}
