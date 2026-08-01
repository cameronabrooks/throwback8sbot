const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const { renameQueue } = require('../lib/queue8');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('renamequeue')
    .setDescription('Rename the active 8s queue embed (staff only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o =>
      o.setName('name').setDescription('New name for the queue').setRequired(true)
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });
    const name = interaction.options.getString('name');
    const result = await renameQueue(interaction.channelId, name);
    if (result === 'no_queue') return interaction.editReply('❌ There is no active queue to rename.');
    await interaction.editReply(`✅ Queue renamed to **${name}**.`);
  },
};
