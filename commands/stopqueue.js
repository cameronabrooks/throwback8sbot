const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { stopQueue } = require('../lib/queue8');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('stopqueue')
    .setDescription('Stop the active 8s queue and remove its embed')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const stopped = await stopQueue(interaction.channelId);
    await interaction.editReply(stopped ? '🛑 Queue stopped.' : '❌ There is no active queue.');
  },
};
