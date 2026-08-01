const { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { loadConfig, buildCategorySelectRow } = require('../lib/applications');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('postapplicationmenu')
    .setDescription('Post the application category dropdown in a channel')
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('Channel to post the application menu in')
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)),

  async execute(interaction) {
    const isStaff = interaction.member?.permissions?.has(PermissionFlagsBits.ManageGuild)
      || interaction.member?.roles?.cache?.some(r => r.name.toLowerCase() === 'staff');
    if (!isStaff) {
      return interaction.reply({ content: '❌ You need staff permissions to post the application menu.', ephemeral: true });
    }

    const channel = interaction.options.getChannel('channel');
    const config = loadConfig();

    const embed = new EmbedBuilder()
      .setTitle('📋 Applications')
      .setColor(0x5865F2)
      .setDescription(config.messages?.info || 'Select a category below to start an application.');

    const row = buildCategorySelectRow(config);

    await channel.send({ embeds: [embed], components: [row] });
    await interaction.reply({ content: `✅ Application menu posted in ${channel}.`, ephemeral: true });
  }
};
