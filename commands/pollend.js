const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('pollend')
    .setDescription('End an active poll early (staff only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption(o =>
      o.setName('message_id')
        .setDescription('ID of the poll message to end')
        .setRequired(true)
    )
    .addChannelOption(o =>
      o.setName('channel')
        .setDescription('Channel containing the poll (default: current channel)')
        .setRequired(false)
    ),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const messageId = interaction.options.getString('message_id');
    const targetChannel = interaction.options.getChannel('channel') ?? interaction.channel;

    let message;
    try {
      message = await targetChannel.messages.fetch(messageId);
    } catch {
      return interaction.editReply('❌ Could not find that message. Make sure the ID and channel are correct.');
    }

    if (!message.poll) {
      return interaction.editReply('❌ That message does not contain a poll.');
    }

    if (message.poll.resultsFinalized) {
      return interaction.editReply('❌ That poll has already ended.');
    }

    try {
      await message.poll.end();
      await interaction.editReply('✅ Poll ended.');
    } catch (e) {
      await interaction.editReply(`❌ Failed to end poll: ${e.message}`);
    }
  },
};
