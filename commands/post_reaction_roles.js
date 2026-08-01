const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const { loadConfig, getGroup, buildMessageContent, buildButtonRows } = require('../lib/reactionRoles');

function buildCommandData() {
  const builder = new SlashCommandBuilder()
    .setName('postreactionroles')
    .setDescription('Post a self-assignable role buttons message in a channel');

  builder.addStringOption(option => {
    option.setName('group').setDescription('Which reaction roles message to post').setRequired(true);
    try {
      const config = loadConfig();
      for (const group of config.groups.slice(0, 25)) {
        option.addChoices({ name: group.name || group.id, value: group.id });
      }
    } catch (e) {
      // config not readable at registration time; command still registers with no choices
    }
    return option;
  });

  builder.addChannelOption(option =>
    option.setName('channel')
      .setDescription('Channel to post the reaction roles message in')
      .addChannelTypes(ChannelType.GuildText)
      .setRequired(true));

  return builder;
}

module.exports = {
  data: buildCommandData(),

  async execute(interaction) {
    const isStaff = interaction.member?.permissions?.has(PermissionFlagsBits.ManageGuild)
      || interaction.member?.roles?.cache?.some(r => r.name.toLowerCase() === 'staff');
    if (!isStaff) {
      return interaction.reply({ content: '❌ You need staff permissions to post reaction roles.', ephemeral: true });
    }

    const channel = interaction.options.getChannel('channel');
    const groupId = interaction.options.getString('group');
    const config = loadConfig();
    const group = getGroup(config, groupId);

    if (!group) {
      return interaction.reply({ content: '❌ Unknown reaction roles group.', ephemeral: true });
    }

    await channel.send({
      content: buildMessageContent(group),
      components: buildButtonRows(group)
    });

    await interaction.reply({ content: `✅ Reaction roles posted in ${channel}.`, ephemeral: true });
  }
};
