const fs = require('fs');
const path = require('path');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'reaction_roles_config.json');
const BUTTONS_PER_ROW = 5;

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function getGroup(config, groupId) {
  return config.groups.find(g => g.id === groupId);
}

// Role button ids are unique across all groups, so a click can be resolved
// without knowing which group it came from.
function getRoleEntry(config, roleEntryId) {
  for (const group of config.groups) {
    const entry = group.roles.find(r => r.id === roleEntryId);
    if (entry) return entry;
  }
  return null;
}

function buildMessageContent(group) {
  const lines = [];
  if (group.title) lines.push(`**${group.title}**`);
  lines.push(...group.roles.map(r => (r.emoji ? `${r.emoji} for ${r.label}` : r.label)));
  return lines.join('\n');
}

function buildButtonRows(group) {
  const buttons = group.roles.map(r => {
    const button = new ButtonBuilder()
      .setCustomId(`rr_${r.id}`)
      .setLabel(r.label)
      .setStyle(ButtonStyle.Primary);
    if (r.emoji) button.setEmoji(r.emoji);
    return button;
  });

  const rows = [];
  for (let i = 0; i < buttons.length; i += BUTTONS_PER_ROW) {
    rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + BUTTONS_PER_ROW)));
  }
  return rows;
}

module.exports = {
  CONFIG_PATH,
  loadConfig,
  getGroup,
  getRoleEntry,
  buildMessageContent,
  buildButtonRows
};
