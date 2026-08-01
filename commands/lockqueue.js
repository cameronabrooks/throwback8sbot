const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { lockQueue } = require('../lib/queue8');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('lockqueue')
    .setDescription('Lock the 8s queue so no players can join (staff only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const result = await lockQueue(interaction.channelId, true);
    if (result === 'no_queue') return interaction.editReply('❌ No active queue in this channel.');
    return interaction.editReply('🔒 Queue locked — players cannot join until unlocked.');
  },
};
