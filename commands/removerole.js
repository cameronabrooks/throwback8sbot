const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const logger = require('../lib/logger');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('removerole')
    .setDescription('Remove a role from every member who has it (staff only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .addRoleOption(option =>
      option.setName('role')
        .setDescription('The role to remove from all members')
        .setRequired(true)),

  async execute(interaction) {
    const role = interaction.options.getRole('role');
    await interaction.reply({ content: `⏳ Removing **${role.name}** from all members...`, ephemeral: true });

    const members = await interaction.guild.members.fetch();
    const withRole = members.filter(m => m.roles.cache.has(role.id));

    let removed = 0;
    let failed = 0;

    for (const member of withRole.values()) {
      try {
        await member.roles.remove(role, 'removerole command');
        removed++;
      } catch (e) {
        failed++;
        logger.warn({ err: e, memberId: member.id, roleId: role.id }, 'removerole: failed to remove role from member');
      }
    }

    await interaction.editReply({
      content: `✅ Removed **${role.name}** from **${removed}** member(s)${failed ? ` (${failed} failed)` : ''}.`
    });
  }
};
