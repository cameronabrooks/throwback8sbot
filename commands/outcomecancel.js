const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { cancelMatch } = require('../lib/queue8');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('outcomecancel')
    .setDescription('Cancel the active match immediately (staff only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const result = await cancelMatch(interaction.channelId);
    if (result.status === 'no_match') {
      return interaction.editReply('❌ There is no active match to cancel.');
    }
    await interaction.editReply('✅ Match cancelled.');
  },
};
