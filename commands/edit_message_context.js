const {
  ContextMenuCommandBuilder, ApplicationCommandType, PermissionFlagsBits,
  ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder
} = require('discord.js');

function isStaffMember(member) {
  return member?.permissions?.has(PermissionFlagsBits.ManageGuild)
    || member?.roles?.cache?.some(r => ['staff', 'commissioner', 'mfic'].includes(r.name.toLowerCase()));
}

module.exports = {
  data: new ContextMenuCommandBuilder()
    .setName('Edit Message')
    .setType(ApplicationCommandType.Message),

  async execute(interaction) {
    if (!isStaffMember(interaction.member)) {
      return interaction.reply({ content: '❌ You need staff permissions to edit a bot message.', ephemeral: true });
    }

    const message = interaction.targetMessage;
    if (message.author.id !== interaction.client.user.id) {
      return interaction.reply({ content: '❌ That message wasn\'t sent by this bot.', ephemeral: true });
    }

    const modal = new ModalBuilder()
      .setCustomId(`editmsg_modal_${message.channelId}_${message.id}`)
      .setTitle('Edit Message');

    const contentInput = new TextInputBuilder()
      .setCustomId('content')
      .setLabel('Content')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setValue(message.content?.slice(0, 4000) || '');

    const descInput = new TextInputBuilder()
      .setCustomId('embed_description')
      .setLabel('Embed description (first embed, if any)')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(false)
      .setValue(message.embeds[0]?.description?.slice(0, 4000) || '');

    modal.addComponents(
      new ActionRowBuilder().addComponents(contentInput),
      new ActionRowBuilder().addComponents(descInput)
    );

    await interaction.showModal(modal);
  },

  async handleEditMessageModal(interaction) {
    const match = interaction.customId.match(/^editmsg_modal_(\d+)_(\d+)$/);
    if (!match) return;
    const [, channelId, messageId] = match;

    if (!isStaffMember(interaction.member)) {
      return interaction.reply({ content: '❌ You need staff permissions to edit a bot message.', ephemeral: true });
    }

    try {
      const channel = await interaction.client.channels.fetch(channelId);
      const message = await channel.messages.fetch(messageId);

      const newContent = interaction.fields.getTextInputValue('content');
      const newDescription = interaction.fields.getTextInputValue('embed_description');

      const payload = { content: newContent || null };
      if (message.embeds.length > 0) {
        payload.embeds = message.embeds.map((embed, i) =>
          i === 0 ? EmbedBuilder.from(embed).setDescription(newDescription || null) : EmbedBuilder.from(embed)
        );
      }

      await message.edit(payload);
      await interaction.reply({ content: `✅ Edited the message in ${channel}.`, ephemeral: true });
    } catch (e) {
      await interaction.reply({ content: `❌ Failed to edit that message: ${e.message}`, ephemeral: true });
    }
  }
};
