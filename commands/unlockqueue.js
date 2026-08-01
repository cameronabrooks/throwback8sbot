const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { lockQueue } = require('../lib/queue8');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('unlockqueue')
    .setDescription('Unlock the 8s queue so players can join again (staff only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const result = await lockQueue(interaction.channelId, false);
    if (result === 'no_queue') return interaction.editReply('❌ No active queue in this channel.');
    return interaction.editReply('🔓 Queue unlocked — players can join again.');
  },
};
