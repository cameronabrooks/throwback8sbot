const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { cancelMatch, findOrphanedMatch, removeOrphanedMatch } = require('../lib/queue8');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('outcomecancel')
    .setDescription('Cancel the active match immediately (staff only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const result = await cancelMatch(interaction.channelId);
    if (result.status !== 'no_match') {
      return interaction.editReply('✅ Match cancelled.');
    }

    // The bot keeps match state in memory, so a restart makes it forget a match that is still
    // sitting in its channels. If this is such a leftover queue-<n> channel, clean it up.
    // (Re-check the permission here: command permissions can be overridden per role in Discord.)
    if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      const orphan = findOrphanedMatch(interaction.channel);
      if (orphan) {
        const count = orphan.voices.length + 1;
        await interaction.editReply(`✅ The bot lost track of this match (it probably restarted), so I'm deleting its leftover channels (${count}).`);
        await removeOrphanedMatch(orphan);
        return;
      }
    }

    return interaction.editReply(
      '❌ There is no active match here. Run this in the queue lobby or inside the match\'s `queue-N` channel. ' +
      'If a match got stuck after a bot restart, run it inside that `queue-N` channel.',
    );
  },
};
