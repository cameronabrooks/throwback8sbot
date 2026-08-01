const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getPlayer, DEFAULT_RATING } = require('../lib/queue_ratings');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('8srating')
    .setDescription('View your 8s queue rating')
    .addUserOption(o => o.setName('player').setDescription('Player to look up (defaults to you)').setRequired(false)),

  async execute(interaction) {
    await interaction.deferReply({ ephemeral: false });
    const target = interaction.options.getUser('player') ?? interaction.user;
    const p = getPlayer(interaction.guildId, target.id);
    const gamesPlayed = p.wins + p.losses;
    const winRate = gamesPlayed > 0 ? ((p.wins / gamesPlayed) * 100).toFixed(1) : '—';
    const streakStr = p.streak > 1 ? `🔥 ${p.streak}W streak` : p.streak < -1 ? `❄️ ${Math.abs(p.streak)}L streak` : null;

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`🎮 8s Rating — ${target.displayName}`)
      .setThumbnail(target.displayAvatarURL())
      .addFields(
        { name: 'Rating', value: `**${Math.round(p.rating)}** MMR`, inline: true },
        { name: 'Record', value: `${p.wins}W — ${p.losses}L`, inline: true },
        { name: 'Win Rate', value: `${winRate}%`, inline: true },
      );
    if (streakStr) embed.setFooter({ text: streakStr });

    await interaction.editReply({ embeds: [embed] });
  },
};
