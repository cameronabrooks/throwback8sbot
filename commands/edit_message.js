const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ChannelType } = require('discord.js');

function parseMessageRef(ref) {
  const linkMatch = ref.match(/channels\/\d+\/(\d+)\/(\d+)/);
  if (linkMatch) return { channelId: linkMatch[1], messageId: linkMatch[2] };
  return { channelId: null, messageId: ref.trim() };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('editmessage')
    .setDescription('Edit a message the bot sent')
    .addStringOption(option =>
      option.setName('message')
        .setDescription('Message link or ID to edit')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('content')
        .setDescription('New plain text content (leave blank to leave unchanged)')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('embed_description')
        .setDescription("New description for the message's first embed (leave blank to leave unchanged)")
        .setRequired(false))
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('Channel the message is in (defaults to this channel, ignored if a message link is given)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(false)),

  async execute(interaction) {
    const isStaff = interaction.member?.permissions?.has(PermissionFlagsBits.ManageGuild)
      || interaction.member?.roles?.cache?.some(r => r.name.toLowerCase() === 'staff' || r.name.toLowerCase() === 'commissioner' || r.name.toLowerCase() === 'mfic');
    if (!isStaff) {
      return interaction.reply({ content: '❌ You need staff permissions to edit a bot message.', ephemeral: true });
    }

    const ref = interaction.options.getString('message');
    const newContent = interaction.options.getString('content');
    const newEmbedDescription = interaction.options.getString('embed_description');
    const channelOption = interaction.options.getChannel('channel');

    if (!newContent && newEmbedDescription === null) {
      return interaction.reply({ content: '❌ Provide at least `content` or `embed_description` to change.', ephemeral: true });
    }

    const { channelId, messageId } = parseMessageRef(ref);

    try {
      const channel = channelId
        ? await interaction.client.channels.fetch(channelId)
        : (channelOption || interaction.channel);

      const message = await channel.messages.fetch(messageId);

      if (message.author.id !== interaction.client.user.id) {
        return interaction.reply({ content: '❌ That message wasn\'t sent by this bot.', ephemeral: true });
      }

      const payload = {};
      if (newContent) payload.content = newContent;
      if (newEmbedDescription !== null) {
        if (message.embeds.length === 0) {
          return interaction.reply({ content: '❌ That message has no embed to edit a description on.', ephemeral: true });
        }
        const updatedEmbeds = message.embeds.map((embed, i) =>
          i === 0 ? EmbedBuilder.from(embed).setDescription(newEmbedDescription) : EmbedBuilder.from(embed)
        );
        payload.embeds = updatedEmbeds;
      }

      await message.edit(payload);
      await interaction.reply({ content: `✅ Edited the message in ${channel}.`, ephemeral: true });
    } catch (e) {
      return interaction.reply({ content: `❌ Failed to edit that message: ${e.message}`, ephemeral: true });
    }
  }
};
