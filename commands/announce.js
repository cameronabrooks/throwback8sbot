const {
  SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ChannelType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle
} = require('discord.js');
const logger = require('../lib/logger');

const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

function parseUserPing(raw) {
  const val = (raw || '').trim();
  if (!val) return null;
  const match = val.match(/^<@!?(\d+)>$/) || val.match(/^(\d+)$/);
  return match ? `<@${match[1]}>` : null;
}

function parseChannelMention(raw) {
  const val = (raw || '').trim();
  if (!val) return null;
  const match = val.match(/^<#(\d+)>$/) || val.match(/^(\d+)$/);
  return match ? `<#${match[1]}>` : null;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('announce')
    .setDescription('Post an announcement through the bot')
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('Channel to post the announcement in')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(true))
    .addStringOption(option =>
      option.setName('title')
        .setDescription('Optional title (posts as an embed instead of plain text)')
        .setRequired(false))
    .addStringOption(option =>
      option.setName('ping')
        .setDescription('Mention everyone or here above the announcement')
        .setRequired(false)
        .addChoices(
          { name: 'Everyone', value: 'everyone' },
          { name: 'Here', value: 'here' }
        )),

  async execute(interaction) {
    const isStaff = interaction.member?.permissions?.has(PermissionFlagsBits.ManageGuild)
      || interaction.member?.roles?.cache?.some(r => r.name.toLowerCase() === 'staff');
    if (!isStaff) {
      return interaction.reply({ content: '❌ You need staff permissions to make an announcement.', ephemeral: true });
    }

    const channel = interaction.options.getChannel('channel');
    let title = interaction.options.getString('title');
    const ping = interaction.options.getString('ping');
    const broadPing = ping ? `@${ping}` : null;

    const modal = new ModalBuilder()
      .setCustomId('announce_compose_modal')
      .setTitle('New Announcement');

    const messageInput = new TextInputBuilder()
      .setCustomId('message')
      .setLabel('Message')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(4000);

    const userPingInput = new TextInputBuilder()
      .setCustomId('user_ping')
      .setLabel('Ping a user (user ID, or leave blank)')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);

    const channelTagInput = new TextInputBuilder()
      .setCustomId('channel_tag')
      .setLabel('Tag a channel (channel ID, or leave blank)')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);

    modal.addComponents(
      new ActionRowBuilder().addComponents(messageInput),
      new ActionRowBuilder().addComponents(userPingInput),
      new ActionRowBuilder().addComponents(channelTagInput),
    );

    await interaction.showModal(modal);

    let modalSubmit;
    try {
      modalSubmit = await interaction.awaitModalSubmit({
        filter: i => i.customId === 'announce_compose_modal' && i.user.id === interaction.user.id,
        time: 5 * 60 * 1000,
      });
    } catch {
      return;
    }

    await modalSubmit.deferReply({ ephemeral: true });

    let message = modalSubmit.fields.getTextInputValue('message');
    let userPing = parseUserPing(modalSubmit.fields.getTextInputValue('user_ping'));
    let channelTag = parseChannelMention(modalSubmit.fields.getTextInputValue('channel_tag'));

    function buildPingLine() {
      const parts = [broadPing, userPing, channelTag].filter(Boolean);
      return parts.length ? parts.join(' ') : null;
    }

    function buildPayload() {
      const pingLine = buildPingLine();
      if (title) {
        const embed = new EmbedBuilder()
          .setTitle(title)
          .setDescription(message)
          .setColor(0x3498DB)
          .setTimestamp();
        return { content: pingLine || null, embeds: [embed] };
      }
      return { content: pingLine ? `${pingLine}\n${message}` : message, embeds: [] };
    }

    const editButton = new ButtonBuilder()
      .setCustomId('announce_edit')
      .setLabel('Edit')
      .setStyle(ButtonStyle.Secondary);
    const editRow = new ActionRowBuilder().addComponents(editButton);

    const sentMessage = await channel.send({ ...buildPayload(), components: [editRow] });

    await modalSubmit.editReply({ content: `✅ Announcement posted in ${channel}.` });

    const collector = sentMessage.createMessageComponentCollector({
      filter: i => i.customId === 'announce_edit',
      time: EDIT_WINDOW_MS,
    });

    collector.on('collect', async buttonInteraction => {
      if (buttonInteraction.user.id !== interaction.user.id) {
        return buttonInteraction.reply({ content: '❌ Only the person who posted this announcement can edit it.', ephemeral: true });
      }

      const editModalId = `announce_edit_modal_${Date.now()}`;
      const editModal = new ModalBuilder()
        .setCustomId(editModalId)
        .setTitle('Edit Announcement');

      const titleInput = new TextInputBuilder()
        .setCustomId('title')
        .setLabel('Title (leave blank for plain text)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setValue(title || '');

      const editMessageInput = new TextInputBuilder()
        .setCustomId('message')
        .setLabel('Message')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(4000)
        .setValue(message);

      const editUserPingInput = new TextInputBuilder()
        .setCustomId('user_ping')
        .setLabel('Ping a user (user ID, or leave blank)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setValue(userPing ? userPing.replace(/[<@>]/g, '') : '');

      const editChannelTagInput = new TextInputBuilder()
        .setCustomId('channel_tag')
        .setLabel('Tag a channel (channel ID, or leave blank)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setValue(channelTag ? channelTag.replace(/[<#>]/g, '') : '');

      editModal.addComponents(
        new ActionRowBuilder().addComponents(titleInput),
        new ActionRowBuilder().addComponents(editMessageInput),
        new ActionRowBuilder().addComponents(editUserPingInput),
        new ActionRowBuilder().addComponents(editChannelTagInput),
      );

      await buttonInteraction.showModal(editModal);

      try {
        const editSubmit = await buttonInteraction.awaitModalSubmit({
          filter: i => i.customId === editModalId && i.user.id === interaction.user.id,
          time: 5 * 60 * 1000,
        });

        title = editSubmit.fields.getTextInputValue('title').trim() || null;
        message = editSubmit.fields.getTextInputValue('message');
        userPing = parseUserPing(editSubmit.fields.getTextInputValue('user_ping'));
        channelTag = parseChannelMention(editSubmit.fields.getTextInputValue('channel_tag'));

        await sentMessage.edit({ ...buildPayload(), components: [editRow] });
        await editSubmit.reply({ content: '✅ Announcement updated.', ephemeral: true });
        logger.info({ messageId: sentMessage.id, userId: interaction.user.id }, 'Announcement edited');
      } catch {
        // modal timed out or failed
      }
    });

    collector.on('end', async () => {
      try {
        await sentMessage.edit({ ...buildPayload(), components: [] });
      } catch {
        // message may have been deleted
      }
    });
  }
};
