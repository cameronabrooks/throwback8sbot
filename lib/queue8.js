const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ChannelType,
} = require('discord.js');
const { processMatchResult, isBanned, banPlayer } = require('./queue_ratings');

const GAME_MAPS  = require('../config/game_maps.json');
const QUEUE_SIZE   = 8;
const VOTES_TO_WIN = 4;

// Snake draft: 6 picks after 2 captains
const SNAKE_ORDER = ['A', 'B', 'B', 'A', 'A', 'B'];

const METHOD_LABELS = {
  random: '🎲 Random',
  vote:   '🗳️ Player Vote',
};

// Format → ordered list of mode keys; used for random map assignment after draft
const FORMATS = {
  hp:    { label: 'All Hardpoint',      emoji: '🎯', modes: ['hardpoint', 'hardpoint', 'hardpoint'] },
  snd:   { label: 'All Search & Destroy', emoji: '💣', modes: ['search_and_destroy', 'search_and_destroy', 'search_and_destroy'] },
  mixed: { label: 'Mixed (HP / S&D / HP)', emoji: '🔀', modes: ['hardpoint', 'search_and_destroy', 'hardpoint'] },
};

// queueChannelId → queue state (one queue per channel)
const guilds = new Map();
// `${guildId}_${matchNum}` → post-match state (rematch, MVP)
const pendingResults = new Map();
// matchTextChannelId → queueChannelId (for resolving match-phase interactions)
const matchChannelMap = new Map();

function getGuild(channelId) {
  if (!guilds.has(channelId)) {
    guilds.set(channelId, {
      players: [], message: null, queueVc: null, active: false, testMode: false,
      matchCount: 0, queueName: '8s Queue', game: null, guildId: null, queueChannelId: null, lastEvent: null,
      methodVote: null, modeVote: null, captainVote: null,
      match: null, blocked: new Set(), locked: false,
    });
  }
  return guilds.get(channelId);
}

// Resolve a queue state from either its queue channel ID or a match text channel ID
function resolveQueue(channelId) {
  if (guilds.has(channelId)) return guilds.get(channelId);
  const queueChannelId = matchChannelMap.get(channelId);
  return queueChannelId ? guilds.get(queueChannelId) : null;
}

// ─── Map helpers ──────────────────────────────────────────────────────────────

function pickRandomMaps(format, game) {
  const { modes } = FORMATS[format] ?? FORMATS.hp;
  const mapsForGame = GAME_MAPS[game] ?? {};
  const usedPerMode = {};
  return modes.map(modeKey => {
    const pool = mapsForGame[modeKey] ?? [];
    const used = usedPerMode[modeKey] ?? [];
    const available = pool.filter(m => !used.includes(m));
    const from = available.length ? available : pool;
    const pick = from[Math.floor(Math.random() * from.length)] ?? '???';
    usedPerMode[modeKey] = [...used, pick];
    return { modeKey, map: pick };
  });
}

const MODE_LABELS = {
  hardpoint:         { label: 'Hardpoint',       emoji: '🎯' },
  search_and_destroy: { label: 'Search & Destroy', emoji: '💣' },
};

// ─── Queue embed ──────────────────────────────────────────────────────────────

function buildQueueEmbed(players, blocked, queueName = '8s Queue', lastEvent = null, locked = false, game = null) {
  const slots = Array.from({ length: QUEUE_SIZE }, (_, i) => {
    const p = players[i];
    return `\`${i + 1}.\` ${p ? `<@${p.id}>` : '—'}`;
  });
  const half = QUEUE_SIZE / 2;

  const descParts = [];
  if (lastEvent) descParts.push(lastEvent);
  if (locked) descParts.push('🔒 **Queue is locked** — no new players can join');
  else if (blocked.size) descParts.push(`🔒 ${blocked.size} player(s) must vote before re-queuing`);
  descParts.push(`\nQueue ${players.length}/${QUEUE_SIZE}`);

  const gameLabel = game ? (GAME_MAPS[game]?.label ?? game) : null;

  return new EmbedBuilder()
    .setColor(players.length === QUEUE_SIZE ? 0x57f287 : 0x2b2d31)
    .setTitle(gameLabel ? `${queueName} — ${gameLabel}` : queueName)
    .setDescription(descParts.join('\n'))
    .addFields(
      { name: '​', value: slots.slice(0, half).join('\n'), inline: true },
      { name: '​', value: slots.slice(half).join('\n'), inline: true },
    )
    // Machine-parseable — lets recoverQueues() restore the map pool after a bot restart.
    .setFooter({ text: `game:${game ?? 'none'}` })
    .setTimestamp();
}

function buildQueueRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('q8_join').setLabel('Join').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('q8_leave').setLabel('Leave').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('q8_clear').setLabel('Clear').setStyle(ButtonStyle.Danger),
  );
}

// ─── Method vote ──────────────────────────────────────────────────────────────

function tallyMethodVotes(mv) {
  const t = { random: 0, vote: 0 };
  for (const m of mv.votes.values()) t[m] = (t[m] || 0) + 1;
  return t;
}

function buildMethodVoteEmbed(mv) {
  const t = tallyMethodVotes(mv);
  const lines = Object.entries(METHOD_LABELS).map(([k, label]) => {
    const n = t[k] || 0;
    return `${'█'.repeat(n)}${'░'.repeat(Math.max(0, 5 - n))} **${n}** — ${label}`;
  });
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle('🗳️ Step 1 of 3 — How should captains be chosen?')
    .setDescription(`${mv.votes.size}/${mv.players.length} players have voted. Click again to change.`)
    .addFields({ name: 'Votes', value: lines.join('\n') })
    .setFooter({ text: 'Most votes wins. Staff can decide early.' });
}

function buildMethodVoteRow() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('q8_method_random').setLabel('🎲 Random').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('q8_method_vote').setLabel('🗳️ Player Vote').setStyle(ButtonStyle.Success),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('q8_method_decide').setLabel('Decide Now (Staff)').setStyle(ButtonStyle.Danger),
    ),
  ];
}

function resolveMethod(mv) {
  const t = tallyMethodVotes(mv);
  const entries = Object.entries(t).sort((a, b) => b[1] - a[1]);
  const max = entries[0][1];
  const tied = entries.filter(([, v]) => v === max);
  return tied[Math.floor(Math.random() * tied.length)][0];
}

// ─── Mode/format vote ─────────────────────────────────────────────────────────

function tallyFormatVotes(mv) {
  const t = { hp: 0, snd: 0, mixed: 0 };
  for (const m of mv.votes.values()) t[m] = (t[m] || 0) + 1;
  return t;
}

function buildFormatVoteEmbed(mv) {
  const t = tallyFormatVotes(mv);
  const lines = Object.entries(FORMATS).map(([k, { label, emoji }]) => {
    const n = t[k] || 0;
    return `${'█'.repeat(n)}${'░'.repeat(Math.max(0, 5 - n))} **${n}** — ${emoji} ${label}`;
  });
  return new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle('🎮 Step 2 of 3 — Vote for Match Format')
    .setDescription(`${mv.votes.size}/${mv.players.length} players have voted. Click again to change.\nMaps are assigned randomly from the CDL pool after teams are picked.`)
    .addFields({ name: 'Options', value: lines.join('\n') })
    .setFooter({ text: 'Most votes wins. Staff can decide early.' });
}

function buildFormatVoteRow() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('q8_mode_hp').setLabel('🎯 All HP').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('q8_mode_snd').setLabel('💣 All S&D').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('q8_mode_mixed').setLabel('🔀 Mixed (HP/S&D/HP)').setStyle(ButtonStyle.Success),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('q8_mode_decide').setLabel('Decide Now (Staff)').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function resolveFormat(mv) {
  const t = tallyFormatVotes(mv);
  const entries = Object.entries(t).sort((a, b) => b[1] - a[1]);
  const max = entries[0][1];
  const tied = entries.filter(([, v]) => v === max);
  return tied[Math.floor(Math.random() * tied.length)][0];
}

// ─── Captain vote ─────────────────────────────────────────────────────────────

function buildCaptainVoteEmbed(cv) {
  const tally = new Map();
  for (const voted of cv.votes.values()) {
    for (const id of voted) tally.set(id, (tally.get(id) || 0) + 1);
  }
  const sorted = [...cv.players].sort((a, b) => (tally.get(b.id) || 0) - (tally.get(a.id) || 0));
  const lines = sorted.map(p => {
    const v = tally.get(p.id) || 0;
    return `${'█'.repeat(v)}${'░'.repeat(Math.max(0, 4 - v))} **${v}** — <@${p.id}>`;
  });
  return new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('🗳️ Step 3 of 3 — Vote for Captains')
    .setDescription(`Select up to **2** captain candidates. Re-submit to change/remove.\n${cv.votes.size}/${cv.players.length} players voted.`)
    .addFields({ name: 'Standings', value: lines.join('\n') })
    .setFooter({ text: 'Top 2 become captains. Any player can randomize; staff can end voting.' });
}

function buildCaptainVoteComponents(cv) {
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('q8_capvote')
        .setPlaceholder('Choose up to 2 captain candidates…')
        .setMinValues(0).setMaxValues(2)
        .addOptions(cv.players.map(p => ({ label: p.displayName, value: p.id }))),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('q8_capvote_random').setLabel('🎲 Go Random').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('q8_capvote_end').setLabel('End Voting (Staff)').setStyle(ButtonStyle.Danger),
    ),
  ];
}

function resolveCaptainsFromVote(cv) {
  const tally = new Map();
  for (const voted of cv.votes.values()) {
    for (const id of voted) tally.set(id, (tally.get(id) || 0) + 1);
  }
  return [...cv.players].sort((a, b) => (tally.get(b.id) || 0) - (tally.get(a.id) || 0)).slice(0, 2);
}

// ─── Snake draft ──────────────────────────────────────────────────────────────

function buildPickEmbed(ps, format) {
  const pickNum = SNAKE_ORDER.length - ps.remaining.length;
  const cap = ps.turn === 'A' ? ps.teamA[0] : ps.teamB[0];
  const nextPicks = SNAKE_ORDER.slice(pickNum + 1, pickNum + 3).map(t => t === 'A' ? '🔵 Team 1' : '🔴 Team 2').join(' → ');
  const fmt = format ? FORMATS[format] : null;
  return new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle(`⚔️ Snake Draft — Pick ${pickNum + 1} of ${SNAKE_ORDER.length}${fmt ? ` | ${fmt.emoji} ${fmt.label}` : ''}`)
    .setDescription(`<@${cap.id}> — it's your pick!${nextPicks ? `\nUp next: ${nextPicks}` : ''}`)
    .addFields(
      { name: '🔵 Team 1', value: ps.teamA.map((p, i) => i === 0 ? `👑 <@${p.id}>` : `<@${p.id}>`).join('\n'), inline: true },
      { name: '🔴 Team 2', value: ps.teamB.map((p, i) => i === 0 ? `👑 <@${p.id}>` : `<@${p.id}>`).join('\n'), inline: true },
      { name: '📋 Available', value: ps.remaining.map(p => `<@${p.id}>`).join('\n') || '—' },
    );
}

function buildPickSelect(ps) {
  const capId = ps.turn === 'A' ? ps.teamA[0].id : ps.teamB[0].id;
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`q8_pick_${capId}`)
      .setPlaceholder('Select a player…')
      .addOptions(ps.remaining.map(p => ({ label: p.displayName, value: p.id }))),
  );
}

// ─── Match embeds ─────────────────────────────────────────────────────────────

function buildTeamsEmbed(match) {
  const { teamA, teamB, vcA, vcB, format, maps } = match;
  const fmt = format ? FORMATS[format] : null;
  const mapsStr = maps && maps.length
    ? maps.map((m, i) => `${m.emoji} Map ${i + 1}: **${m.map}** (${m.label})`).join('\n')
    : null;
  return new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(`✅ Match Started${fmt ? ` — ${fmt.emoji} ${fmt.label}` : ''}`)
    .addFields(
      { name: `🔵 Team 1${vcA ? ` — <#${vcA.id}>` : ''}`, value: teamA.map((p, i) => i === 0 ? `👑 <@${p.id}>` : `<@${p.id}>`).join('\n'), inline: true },
      { name: `🔴 Team 2${vcB ? ` — <#${vcB.id}>` : ''}`, value: teamB.map((p, i) => i === 0 ? `👑 <@${p.id}>` : `<@${p.id}>`).join('\n'), inline: true },
      ...(mapsStr ? [{ name: '🗺️ Maps', value: mapsStr }] : []),
    );
}

function buildMatchVoteEmbed(match) {
  const votesA = [...match.votes.values()].filter(v => v === 'A').length;
  const votesB = [...match.votes.values()].filter(v => v === 'B').length;
  return new EmbedBuilder()
    .setColor(0xeb459e)
    .setTitle('📊 Match Result — Who won?')
    .setDescription(`First team to **${VOTES_TO_WIN} votes** wins. All players must vote before re-queuing.`)
    .addFields(
      { name: '🔵 Team 1', value: match.teamA.map(p => `<@${p.id}>`).join('\n'), inline: true },
      { name: '🔴 Team 2', value: match.teamB.map(p => `<@${p.id}>`).join('\n'), inline: true },
      { name: 'Votes', value: `🔵 Team 1: **${votesA}** | 🔴 Team 2: **${votesB}** | Need: **${VOTES_TO_WIN}**` },
    );
}

function buildMatchVoteRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('q8_vote_A').setLabel('🔵 Team 1 Won').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('q8_vote_B').setLabel('🔴 Team 2 Won').setStyle(ButtonStyle.Danger),
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function getOrCreateCategory(guild) {
  let cat = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name.toLowerCase() === '8s matches');
  if (!cat) cat = await guild.channels.create({ name: '8s Matches', type: ChannelType.GuildCategory }).catch(() => null);
  return cat;
}

async function movePlayersToVc(guild, players, vc) {
  const results = await Promise.allSettled(
    players.map(p => guild.members.fetch(p.id).then(m => m.voice.channel ? m.voice.setChannel(vc) : null))
  );
  return players.filter((_, i) => results[i].status === 'fulfilled' && results[i].value === null);
}

async function refreshQueueEmbed(g) {
  if (!g.message) return;
  g.message = await g.message.edit({ embeds: [buildQueueEmbed(g.players, g.blocked, g.queueName, g.lastEvent, g.locked, g.game)], components: [buildQueueRow()] }).catch(() => g.message);
  // Update channel name to reflect current queue count
  const ch = g.message.channel;
  const baseName = g.queueChannelBaseName ?? ch.name.replace(/-\d+$/, '');
  const newName = g.players.length > 0 ? `in-queue-${g.players.length}` : baseName;
  if (ch.name !== newName) ch.setName(newName).catch(() => {});
}

// ─── Phase flow ───────────────────────────────────────────────────────────────

async function startFormatVote(g, players) {
  const channel = g.match.textChannel;
  const mv = { players, votes: new Map(), message: null };
  g.modeVote = mv;
  const msg = await channel.send({ embeds: [buildFormatVoteEmbed(mv)], components: buildFormatVoteRow() });
  mv.message = msg;
}

async function startCaptainSelection(g, method, players) {
  const channel = g.match.textChannel;
  const guild = channel.guild;

  if (method === 'vote') {
    const cv = { players, votes: new Map(), message: null };
    g.captainVote = cv;
    const msg = await channel.send({ embeds: [buildCaptainVoteEmbed(cv)], components: buildCaptainVoteComponents(cv) });
    cv.message = msg;
  } else {
    const sh = [...players].sort(() => Math.random() - 0.5);
    await startPickPhase(g, sh[0], sh[1], players);
  }
}

async function startPickPhase(g, captainA, captainB, allPlayers) {
  const channel = g.match.textChannel;
  const remaining = allPlayers.filter(p => p.id !== captainA.id && p.id !== captainB.id);
  const ps = {
    teamA: [captainA], teamB: [captainB], remaining,
    pickIndex: 0, turn: SNAKE_ORDER[0], message: null,
  };
  g.match.pickState = ps;
  g.match.teamA = ps.teamA;
  g.match.teamB = ps.teamB;

  const fmt = g.match.format ? FORMATS[g.match.format] : null;
  const msg = await channel.send({
    content: `👑 <@${captainA.id}> (🔵 Team 1) vs <@${captainB.id}> (🔴 Team 2)${fmt ? ` | ${fmt.emoji} ${fmt.label}` : ''} — snake draft begins!`,
    embeds: [buildPickEmbed(ps, g.match.format)],
    components: [buildPickSelect(ps)],
  });
  ps.message = msg;
}

async function launchMatch(channelId) {
  const g = getGuild(channelId);
  const ps = g.match.pickState;
  const { teamA, teamB } = ps;
  const guild = ps.message.guild;
  const channel = g.match.textChannel;

  await ps.message.edit({ components: [] }).catch(() => {});

  // Teams are locked in — clear the VC join timer and update interval
  if (g.match.vcTimer) { clearTimeout(g.match.vcTimer); g.match.vcTimer = null; }
  if (g.match.vcWarnTimer) { clearTimeout(g.match.vcWarnTimer); g.match.vcWarnTimer = null; }
  if (g.match.vcUpdateInterval) { clearInterval(g.match.vcUpdateInterval); g.match.vcUpdateInterval = null; }

  // Assign random maps now that teams are set
  const mapList = pickRandomMaps(g.match.format ?? 'hp', g.match.game ?? g.game);
  const enrichedMaps = mapList.map(({ modeKey, map }) => ({
    map,
    label: MODE_LABELS[modeKey]?.label ?? modeKey,
    emoji: MODE_LABELS[modeKey]?.emoji ?? '🗺️',
  }));
  g.match.maps = enrichedMaps;

  const vcOpts = g.match.categoryId ? { parent: g.match.categoryId } : {};
  const TEST_STAFF_ROLES = []; // TODO: staff role IDs that should see into test-mode channels
  const testPermissions = g.testMode ? [
    { id: guild.roles.everyone.id, deny: ['ViewChannel'] },
    ...TEST_STAFF_ROLES.map(id => ({ id, allow: ['ViewChannel', 'Connect'] })),
  ] : null;
  const [vcA, vcB] = await Promise.all([
    guild.channels.create({ name: '🔵 Team 1', type: ChannelType.GuildVoice, ...vcOpts, ...(testPermissions ? { permissionOverwrites: testPermissions } : {}) }),
    guild.channels.create({ name: '🔴 Team 2', type: ChannelType.GuildVoice, ...vcOpts, ...(testPermissions ? { permissionOverwrites: testPermissions } : {}) }),
  ]);

  g.match.vcA = vcA;
  g.match.vcB = vcB;
  g.match.pickState = null;

  // Delete the temporary queue staging VC now that teams are set
  if (g.match.matchQueueVc) g.match.matchQueueVc.delete().catch(() => {});
  g.match.matchQueueVc = null;

  const [notA, notB] = await Promise.all([
    movePlayersToVc(guild, teamA, vcA),
    movePlayersToVc(guild, teamB, vcB),
  ]);
  const notMoved = [...notA, ...notB];

  const ping = [...teamA, ...teamB].map(p => `<@${p.id}>`).join(' ');
  let content = `🎮 Match #${g.matchCount} | ${ping}`;
  if (notMoved.length) content += `\n⚠️ Not in voice — join manually: ${notMoved.map(p => `<@${p.id}>`).join(' ')}`;

  await channel.send({ content, embeds: [buildTeamsEmbed(g.match)] });

  const voteMsg = await channel.send({
    content: `⬇️ Vote for the winning team once your match is done. **${VOTES_TO_WIN} votes** needed.`,
    embeds: [buildMatchVoteEmbed(g.match)],
    components: [buildMatchVoteRow()],
  });
  g.match.voteMsg = voteMsg;

  for (const p of [...teamA, ...teamB]) g.blocked.add(p.id);
  await refreshQueueEmbed(g);
}

// ─── Public API ───────────────────────────────────────────────────────────────

async function startQueue(channel, testMode = false, game = 'bo6') {
  const channelId = channel.id;
  const g = getGuild(channelId);
  g.guildId = channel.guild.id;
  g.queueChannelId = channelId;
  g.queueChannelBaseName = channel.name;
  g.game = GAME_MAPS[game] ? game : 'bo6';
  g.queueName = '8s Queue';

  // Delete known reference if we have one
  if (g.message) await g.message.delete().catch(() => {});

  // Also scan the channel for any orphaned queue embeds left after a restart
  try {
    const recent = await channel.messages.fetch({ limit: 20 });
    for (const m of recent.values()) {
      if (
        m.author.id === channel.client.user.id &&
        m.components?.some(row => row.components?.some(c => c.customId === 'q8_join'))
      ) {
        await m.delete().catch(() => {});
      }
    }
  } catch { /* ignore */ }

  g.players = [];
  g.active = true;
  g.testMode = testMode;
  g.queueVc = null;
  g.methodVote = null;
  g.modeVote = null;
  g.captainVote = null;
  g.lastEvent = null;

  // Clear any existing inactivity interval from a previous queue in this channel
  if (g.inactivityInterval) { clearInterval(g.inactivityInterval); g.inactivityInterval = null; }

  const INACTIVITY_MS = 30 * 60 * 1000;
  g.inactivityInterval = setInterval(async () => {
    if (!g.active || g.match) return;
    const now = Date.now();
    const timedOut = g.players.filter(p => now - p.joinedAt >= INACTIVITY_MS);
    if (!timedOut.length) return;
    g.players = g.players.filter(p => now - p.joinedAt < INACTIVITY_MS);
    g.lastEvent = `Player Left Queue Due To Inactivity\n${timedOut.map(p => `<@${p.id}>`).join(' ')}`;
    await refreshQueueEmbed(g);
  }, 60 * 1000);

  const msg = await channel.send({
    content: testMode ? '⚠️ **TEST MODE** — one player can fill all 8 slots.' : undefined,
    embeds: [buildQueueEmbed([], g.blocked, g.queueName, g.lastEvent, g.locked, g.game)],
    components: [buildQueueRow()],
  });
  g.message = msg;
  return msg;
}

async function joinQueue(channelId, member) {
  const g = getGuild(channelId);
  if (!g.active) return { status: 'inactive' };
  if (g.locked && !g.testMode) return { status: 'locked' };
  if (!g.testMode && g.guildId && isBanned(g.guildId, member.id)) return { status: 'banned' };
  if (g.blocked.has(member.id) && !g.testMode) return { status: 'must_vote' };

  if (g.testMode) {
    // In test mode allow the same player to fill remaining slots with fake entries
    const slot = g.players.length + 1;
    if (slot > QUEUE_SIZE) return { status: 'already_in' };
    g.players.push({ id: `test_${slot}_${member.id}`, displayName: `Test Player ${slot}`, joinedAt: Date.now() });
  } else {
    if (g.players.some(p => p.id === member.id)) return { status: 'already_in' };
    g.players.push({ id: member.id, displayName: member.displayName, joinedAt: Date.now() });
    g.lastEvent = `Player Joined Queue\n<@${member.id}>`;
  }

  if (g.players.length === QUEUE_SIZE) {
    const popped = g.players.splice(0, QUEUE_SIZE);
    g.matchCount++;
    const matchNum = g.matchCount;

    const guild = g.message.guild;
    const queueChannel = g.message.channel;
    const queueCategory = queueChannel.parentId;
    const vcOpts = queueCategory ? { parent: queueCategory } : {};

    const TEST_STAFF_ROLES = []; // TODO: staff role IDs that should see into test-mode channels
    const testPermissions = g.testMode ? [
      { id: guild.roles.everyone.id, deny: ['ViewChannel'] },
      ...TEST_STAFF_ROLES.map(id => ({ id, allow: ['ViewChannel', 'Connect'] })),
    ] : null;

    const [textCh, matchQueueVc] = await Promise.all([
      guild.channels.create({ name: `queue-${matchNum}`, type: ChannelType.GuildText, ...vcOpts, ...(testPermissions ? { permissionOverwrites: testPermissions } : {}) }).catch(() => null),
      guild.channels.create({ name: `🎮 Queue #${matchNum}`, type: ChannelType.GuildVoice, ...vcOpts, ...(testPermissions ? { permissionOverwrites: testPermissions } : {}) }).catch(() => null),
    ]);

    if (textCh) matchChannelMap.set(textCh.id, channelId);
    if (g.inactivityInterval) { clearInterval(g.inactivityInterval); g.inactivityInterval = null; }
    g.lastEvent = null;
    g.match = {
      textChannelId: textCh?.id ?? null,
      teamA: [], teamB: [], vcA: null, vcB: null,
      textChannel: textCh, matchQueueVc, categoryId: queueCategory ?? null, format: null, maps: null, _captainMethod: 'random',
      game: g.game,
      votes: new Map(), voteMsg: null, pickState: null,
      players: popped, vcTimer: null, vcWarnTimer: null,
    };

    await refreshQueueEmbed(g);

    const ping = popped.map(p => `<@${p.id}>`).join(' ');
    const deadlineTs = Math.floor((Date.now() + 5 * 60 * 1000) / 1000);


    // Countdown embed in match text channel
    let countdownMsg = null;
    if (textCh) {
      const buildCountdownEmbed = (missingPlayers) => new EmbedBuilder()
        .setColor(missingPlayers.length === 0 ? 0x57f287 : 0xe67e22)
        .setTitle(`🎮 Queue #${matchNum} — Join the Voice Channel!`)
        .setDescription(
          matchQueueVc
            ? `All players must join <#${matchQueueVc.id}> before the timer expires or the match will be cancelled.`
            : 'All players must be ready before the timer expires.'
        )
        .addFields(
          { name: '⏱️ Deadline', value: `<t:${deadlineTs}:R>` },
          { name: `⏳ Still Waiting (${missingPlayers.length})`, value: missingPlayers.length ? missingPlayers.map(p => `<@${p.id}>`).join('\n') : '✅ Everyone is in!' },
        )
        .setFooter({ text: 'Players who join in time will be kept. No-shows are dropped.' });

      countdownMsg = await textCh.send({ content: ping, embeds: [buildCountdownEmbed(popped)] });
      g.match.countdownMsg = countdownMsg;

      // Update every minute — re-ping only those still missing
      g.match.vcUpdateInterval = setInterval(async () => {
        if (!g.match || g.match.matchQueueVc?.id !== matchQueueVc?.id) return;
        const inVc = matchQueueVc ? [...matchQueueVc.members.values()] : [];
        const missing = popped.filter(p => !inVc.some(m => m.id === p.id));
        const missingPing = missing.map(p => `<@${p.id}>`).join(' ');
        await countdownMsg.edit({
          content: missing.length ? `⏳ Still waiting: ${missingPing}` : '✅ All players in!',
          embeds: [buildCountdownEmbed(missing)],
        }).catch(() => {});
      }, 60 * 1000);
    }

    // 5-minute deadline
    g.match.vcTimer = setTimeout(async () => {
      if (!g.match || g.match.matchQueueVc?.id !== matchQueueVc?.id) return;
      const inVc = matchQueueVc ? [...matchQueueVc.members.values()] : [];
      const presentIds = new Set(inVc.map(m => m.id));
      const present = popped.filter(p => presentIds.has(p.id));
      const absent = popped.filter(p => !presentIds.has(p.id));

      if (g.match.vcUpdateInterval) { clearInterval(g.match.vcUpdateInterval); g.match.vcUpdateInterval = null; }
      if (absent.length === 0) return; // everyone joined, all good

      // Cancel the current match state
      const match = g.match;
      if (match.textChannelId) matchChannelMap.delete(match.textChannelId);
      g.match = null;
      g.methodVote = null;
      g.modeVote = null;
      g.captainVote = null;
      for (const p of popped) g.blocked.delete(p.id);

      // Temp-ban no-shows for 5 minutes
      if (g.guildId) {
        const tempBanExpiry = Date.now() + 5 * 60 * 1000;
        for (const p of absent) {
          banPlayer(g.guildId, p.id, 'Did not join queue VC in time', null, tempBanExpiry);
        }
      }

      const absentMention = absent.map(p => `<@${p.id}>`).join(' ');
      const presentMention = present.length ? present.map(p => `<@${p.id}>`).join(' ') : 'none';

      // Only pull from the waiting queue if there are enough players to fill every missing spot
      const canFill = g.players.length >= absent.length;
      const pulled = canFill ? g.players.splice(0, absent.length) : [];
      // If we can fill: combine present + pulled. If not: re-queue all 8 original players
      const combined = canFill ? [...present, ...pulled] : [...popped];
      const pulledMention = pulled.length ? pulled.map(p => `<@${p.id}>`).join(' ') : null;

      if (textCh) {
        let msg = `⏰ **Time's up!** Not everyone joined the voice channel.\n❌ No-shows (banned from queue for 5 min): ${absentMention}`;
        if (canFill) {
          msg += `\n🔄 Stayed: ${presentMention}`;
          if (pulledMention) msg += `\n➕ Pulled from queue: ${pulledMention}`;
        } else {
          msg += `\n🔄 Re-queuing all 8 players.`;
        }
        await textCh.send({ content: msg }).catch(() => {});
      }

      // Put combined back at the front of the queue (reset joinedAt so they get a fresh 30min window)
      const now = Date.now();
      g.players.unshift(...combined.map(p => ({ ...p, joinedAt: now })));
      g.lastEvent = `Player Left Queue Due To Inactivity\n${absent.map(p => `<@${p.id}>`).join(' ')}`;
      await refreshQueueEmbed(g);

      setTimeout(() => {
        if (match.vcA) match.vcA.delete().catch(() => {});
        if (match.vcB) match.vcB.delete().catch(() => {});
        if (matchQueueVc) matchQueueVc.delete().catch(() => {});
        if (textCh) textCh.delete().catch(() => {});
      }, 10000);

      // If we now have a full lobby, fire the queue immediately
      if (g.players.length >= QUEUE_SIZE) {
        const next = g.players[g.players.length - 1];
        await joinQueue(channelId, { id: next.id, displayName: next.displayName });
      }
    }, 5 * 60 * 1000);

    const mv = { players: popped, votes: new Map(), message: null };
    g.methodVote = mv;
    const mvMsg = await textCh.send({
      content: ping,
      embeds: [buildMethodVoteEmbed(mv)],
      components: buildMethodVoteRow(),
    });
    mv.message = mvMsg;

    return { status: 'fired', matchNum };
  }

  await refreshQueueEmbed(g);
  return { status: 'joined', count: g.players.length };
}

async function leaveQueue(channelId, userId) {
  const g = getGuild(channelId);
  if (!g.active) return { status: 'inactive' };
  const before = g.players.length;
  g.players = g.players.filter(p => p.id !== userId);
  if (g.players.length === before) return { status: 'not_in' };
  g.lastEvent = `Player Left Queue\n<@${userId}>`;
  await refreshQueueEmbed(g);
  return { status: 'left' };
}

async function clearQueue(channelId) {
  const g = getGuild(channelId);
  if (!g.active) return false;
  g.players = [];
  g.lastEvent = null;
  await refreshQueueEmbed(g);
  return true;
}

// Method vote
async function handleMethodVote(channelId, voterId, method) {
  const g = resolveQueue(channelId);
  if (!g) return { status: 'no_vote' };
  const mv = g.methodVote;
  if (!mv) return { status: 'no_vote' };
  if (!mv.players.some(p => p.id === voterId)) return { status: 'not_in_queue' };
  if (mv.votes.get(voterId) === method) mv.votes.delete(voterId);
  else mv.votes.set(voterId, method);
  await mv.message.edit({ embeds: [buildMethodVoteEmbed(mv)], components: buildMethodVoteRow() }).catch(() => {});
  if (mv.votes.size === mv.players.length) return finalizeMethodVote(channelId);
  return { status: 'voted' };
}

async function finalizeMethodVote(channelId) {
  const g = resolveQueue(channelId);
  if (!g) return { status: 'no_vote' };
  const mv = g.methodVote;
  if (!mv) return { status: 'no_vote' };
  g.methodVote = null;
  const method = resolveMethod(mv);
  g.match._captainMethod = method;
  await mv.message.edit({ content: `✅ **Step 1/3 done** — Captain mode: **${METHOD_LABELS[method]}**`, embeds: [], components: [] }).catch(() => {});
  await startFormatVote(g, mv.players);
  return { status: 'done', method };
}

// Format vote (hp / snd / mixed)
async function handleFormatVote(channelId, voterId, format) {
  const g = resolveQueue(channelId);
  if (!g) return { status: 'no_vote' };
  const mv = g.modeVote;
  if (!mv) return { status: 'no_vote' };
  if (!mv.players.some(p => p.id === voterId)) return { status: 'not_in_queue' };
  if (mv.votes.get(voterId) === format) mv.votes.delete(voterId);
  else mv.votes.set(voterId, format);
  await mv.message.edit({ embeds: [buildFormatVoteEmbed(mv)], components: buildFormatVoteRow() }).catch(() => {});
  if (mv.votes.size === mv.players.length) return finalizeFormatVote(channelId);
  return { status: 'voted' };
}

async function finalizeFormatVote(channelId) {
  const g = resolveQueue(channelId);
  if (!g) return { status: 'no_vote' };
  const mv = g.modeVote;
  if (!mv) return { status: 'no_vote' };
  g.modeVote = null;
  const format = resolveFormat(mv);
  g.match.format = format;
  const { label, emoji } = FORMATS[format];
  await mv.message.edit({ content: `✅ **Step 2/3 done** — Format: **${emoji} ${label}** *(maps drawn after draft)*`, embeds: [], components: [] }).catch(() => {});
  await startCaptainSelection(g, g.match._captainMethod, mv.players);
  return { status: 'done', format };
}

// Captain vote
async function handleCaptainVote(channelId, voterId, selectedIds) {
  const g = resolveQueue(channelId);
  if (!g) return { status: 'no_vote' };
  const cv = g.captainVote;
  if (!cv) return { status: 'no_vote' };
  if (!cv.players.some(p => p.id === voterId)) return { status: 'not_in_queue' };
  cv.votes.set(voterId, selectedIds);
  await cv.message.edit({ embeds: [buildCaptainVoteEmbed(cv)], components: buildCaptainVoteComponents(cv) }).catch(() => {});
  if (cv.votes.size === cv.players.length) return finalizeCaptainVote(channelId);
  return { status: 'voted' };
}

async function finalizeCaptainVote(channelId) {
  const g = resolveQueue(channelId);
  if (!g) return { status: 'no_vote' };
  const cv = g.captainVote;
  if (!cv) return { status: 'no_vote' };
  g.captainVote = null;
  await cv.message.edit({ components: [] }).catch(() => {});
  const [capA, capB] = resolveCaptainsFromVote(cv);
  await startPickPhase(g, capA, capB, cv.players);
  return { status: 'done' };
}

async function randomizeCaptains(channelId, requesterId) {
  const g = resolveQueue(channelId);
  if (!g) return { status: 'no_vote' };
  const cv = g.captainVote;
  if (!cv) return { status: 'no_vote' };
  if (!cv.players.some(p => p.id === requesterId)) return { status: 'not_in_queue' };
  g.captainVote = null;
  await cv.message.edit({ components: [] }).catch(() => {});
  const sh = [...cv.players].sort(() => Math.random() - 0.5);
  await startPickPhase(g, sh[0], sh[1], cv.players);
  return { status: 'done' };
}

// Snake draft pick
async function handlePick(channelId, captainId, pickedPlayerId) {
  const g = resolveQueue(channelId);
  if (!g) return { status: 'no_pick' };
  const ps = g.match?.pickState;
  if (!ps) return { status: 'no_pick' };
  const expectedCaptainId = ps.turn === 'A' ? ps.teamA[0].id : ps.teamB[0].id;
  if (captainId !== expectedCaptainId) return { status: 'not_your_turn' };
  const idx = ps.remaining.findIndex(p => p.id === pickedPlayerId);
  if (idx === -1) return { status: 'invalid' };

  const picked = ps.remaining.splice(idx, 1)[0];
  if (ps.turn === 'A') ps.teamA.push(picked); else ps.teamB.push(picked);

  if (ps.remaining.length === 1) {
    const last = ps.remaining.splice(0, 1)[0];
    const nextTurn = SNAKE_ORDER[ps.pickIndex + 1] ?? (ps.teamA.length <= ps.teamB.length ? 'A' : 'B');
    if (nextTurn === 'A') ps.teamA.push(last); else ps.teamB.push(last);
  }

  g.match.teamA = ps.teamA;
  g.match.teamB = ps.teamB;

  if (ps.remaining.length === 0) {
    await launchMatch(channelId);
    return { status: 'done' };
  }

  ps.pickIndex++;
  ps.turn = SNAKE_ORDER[ps.pickIndex];
  await ps.message.edit({ embeds: [buildPickEmbed(ps, g.match.format)], components: [buildPickSelect(ps)] });
  return { status: 'picked' };
}

// Match result vote — VOTES_TO_WIN threshold
async function handleMatchVote(channelId, userId, vote) {
  const g = resolveQueue(channelId);
  if (!g) return { status: 'no_match' };
  const match = g.match;
  if (!match || match.pickState) return { status: 'no_match' };

  const allPlayers = [...match.teamA, ...match.teamB];
  if (!allPlayers.some(p => p.id === userId)) return { status: 'not_in_match' };
  if (match.votes.has(userId)) return { status: 'already_voted' };

  match.votes.set(userId, vote);
  g.blocked.delete(userId);
  await refreshQueueEmbed(g);

  const votesA = [...match.votes.values()].filter(v => v === 'A').length;
  const votesB = [...match.votes.values()].filter(v => v === 'B').length;

  if (match.voteMsg) {
    await match.voteMsg.edit({ embeds: [buildMatchVoteEmbed(match)], components: [buildMatchVoteRow()] }).catch(() => {});
  }

  if (votesA >= VOTES_TO_WIN || votesB >= VOTES_TO_WIN) {
    const winner = votesA >= VOTES_TO_WIN ? 'A' : 'B';
    const winTeam = winner === 'A' ? match.teamA : match.teamB;
    const winLabel = winner === 'A' ? '🔵 Team 1' : '🔴 Team 2';

    if (match.voteMsg) {
      await match.voteMsg.edit({
        content: `🏆 **${winLabel} wins!** ${winTeam.map(p => `<@${p.id}>`).join(' ')}`,
        embeds: [buildMatchVoteEmbed(match)],
        components: [],
      }).catch(() => {});
    }

    for (const p of allPlayers) g.blocked.delete(p.id);
    await refreshQueueEmbed(g);

    // Post result to queue-results channel (find or create in same category)
    const matchNum = g.matchCount;
    // Skip rating updates for test matches
    let ratingResults = [];
    if (!g.testMode) {
      const loseTeamForRating = winner === 'A' ? match.teamB : match.teamA;
      ratingResults = processMatchResult(g.guildId, winTeam, loseTeamForRating);
    }

    const guild = match.textChannel?.guild;
    if (guild) {
      const categoryId = match.categoryId;
      let resultsChannel = guild.channels.cache.find(
        c => c.type === ChannelType.GuildText && (c.name === 'queue-results' || c.name === '8s results') && c.parentId === categoryId,
      );
      if (!resultsChannel) {
        const createOpts = { name: 'queue-results', type: ChannelType.GuildText };
        if (categoryId) createOpts.parent = categoryId;
        resultsChannel = await guild.channels.create(createOpts).catch(() => null);
      }
      if (resultsChannel) {
        const loseTeam = winner === 'A' ? match.teamB : match.teamA;
        const loseLabel = winner === 'A' ? '🔴 Team 2' : '🔵 Team 1';

        const ratingLine = p => {
          const r = ratingResults.find(x => x.userId === p.id);
          if (!r) return `<@${p.id}>`;
          const sign = r.delta >= 0 ? '+' : '';
          return `<@${p.id}> ${sign}${r.delta} **(${r.newRating.toFixed(1)})**`;
        };

        const resultEmbed = new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle(`🏆 Winner For Queue#${matchNum} 🏆`)
          .addFields(
            { name: winLabel,  value: winTeam.map(ratingLine).join('\n'),  inline: true },
            { name: loseLabel, value: loseTeam.map(ratingLine).join('\n'), inline: true },
          )
          .setTimestamp();
        if (g.testMode) resultEmbed.setFooter({ text: '⚠️ Test match — ratings not affected' });

        const resultRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`q8_rematch_${matchNum}`)
            .setLabel('Rematch')
            .setEmoji('⚔️')
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId(`q8_mvp_${matchNum}`)
            .setLabel('Vote MVP')
            .setEmoji('🏆')
            .setStyle(ButtonStyle.Primary),
        );

        const allMatchPlayers = [...winTeam, ...loseTeam];
        await resultsChannel.send({
          embeds: [resultEmbed],
          components: [resultRow],
        }).then(msg => {
          pendingResults.set(`${guild.id}_${matchNum}`, {
            players: allMatchPlayers,
            queueChannelId: g.queueChannelId,
            mvpVotes: new Map(),
            mvpMsg: null,
            resultsMsg: msg,
          });
        }).catch(() => {});
      }
    }

    if (match.textChannelId) matchChannelMap.delete(match.textChannelId);
    g.match = null;

    // Delete match channels after a short delay
    setTimeout(() => {
      if (match.vcA) match.vcA.delete().catch(() => {});
      if (match.vcB) match.vcB.delete().catch(() => {});
      if (match.textChannel) match.textChannel.delete().catch(() => {});
    }, 10000);

    return { status: 'resolved', winner: winLabel };
  }

  return { status: 'voted' };
}

// Returns 'toggled_on', 'toggled_off', or 'no_queue'
async function toggleTestMode(channelId) {
  const g = getGuild(channelId);
  if (!g.active) return 'no_queue';
  g.testMode = !g.testMode;
  if (g.message) {
    g.message = await g.message.edit({
      content: g.testMode ? '⚠️ **TEST MODE** — one player can fill all 8 slots.' : null,
      embeds: [buildQueueEmbed(g.players, g.blocked, g.queueName, g.lastEvent, g.locked, g.game)],
      components: [buildQueueRow()],
    }).catch(() => g.message);
  }
  return g.testMode ? 'toggled_on' : 'toggled_off';
}

async function lockQueue(channelId, locked) {
  const g = getGuild(channelId);
  if (!g.active) return 'no_queue';
  g.locked = locked;
  await refreshQueueEmbed(g);
  return locked ? 'locked' : 'unlocked';
}

async function renameQueue(channelId, name) {
  const g = getGuild(channelId);
  if (!g.active) return 'no_queue';
  g.queueName = name;
  await refreshQueueEmbed(g);
  return 'renamed';
}

async function stopQueue(channelId) {
  const g = getGuild(channelId);
  if (!g.active) return false;
  g.active = false;
  g.testMode = false;
  g.players = [];
  if (g.inactivityInterval) { clearInterval(g.inactivityInterval); g.inactivityInterval = null; }
  if (g.message) { await g.message.delete().catch(() => {}); g.message = null; }
  return true;
}

const CANCEL_VOTES_NEEDED = 5; // majority of 8

function buildCancelVoteEmbed(cv) {
  return new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle('🚫 Vote to Cancel Match')
    .setDescription(`**${cv.votes.size}/${CANCEL_VOTES_NEEDED}** votes to cancel. All 8 players can vote.`)
    .setFooter({ text: 'Vote again to remove your vote.' });
}

function buildCancelVoteRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('q8_cancel_vote').setLabel('🚫 Vote to Cancel').setStyle(ButtonStyle.Danger),
  );
}

// Staff: immediately cancel the active match
async function cancelMatch(channelId) {
  const g = resolveQueue(channelId);
  if (!g?.match) return { status: 'no_match' };
  const match = g.match;
  const allPlayers = [...(match.teamA || []), ...(match.teamB || [])];

  if (match.vcTimer) clearTimeout(match.vcTimer);
  if (match.vcWarnTimer) clearTimeout(match.vcWarnTimer);
  if (match.vcUpdateInterval) clearInterval(match.vcUpdateInterval);
  if (match.voteMsg) await match.voteMsg.edit({ components: [] }).catch(() => {});
  if (match.cancelVoteMsg) await match.cancelVoteMsg.edit({ components: [] }).catch(() => {});
  if (match.textChannel) {
    await match.textChannel.send('❌ **Match cancelled by staff.**').catch(() => {});
  }

  for (const p of allPlayers) g.blocked.delete(p.id);
  if (match.textChannelId) matchChannelMap.delete(match.textChannelId);
  g.match = null;
  await refreshQueueEmbed(g);

  setTimeout(() => {
    if (match.vcA) match.vcA.delete().catch(() => {});
    if (match.vcB) match.vcB.delete().catch(() => {});
    if (match.matchQueueVc) match.matchQueueVc.delete().catch(() => {});
    if (match.textChannel) match.textChannel.delete().catch(() => {});
  }, 5000);

  return { status: 'cancelled' };
}

// Player: start or vote on a cancel vote in the match text channel
async function handleCancelVote(channelId, userId) {
  const g = resolveQueue(channelId);
  if (!g?.match) return { status: 'no_match' };
  const match = g.match;
  const allPlayers = [...(match.teamA || []), ...(match.teamB || [])];
  if (!allPlayers.some(p => p.id === userId)) return { status: 'not_in_match' };

  // Start the vote if it doesn't exist yet
  if (!match.cancelVote) {
    match.cancelVote = { votes: new Set() };
    const channel = match.textChannel;
    if (!channel) return { status: 'no_channel' };
    const msg = await channel.send({
      content: `${allPlayers.map(p => `<@${p.id}>`).join(' ')}\n⚠️ A player has called for a match cancellation.`,
      embeds: [buildCancelVoteEmbed(match.cancelVote)],
      components: [buildCancelVoteRow()],
    });
    match.cancelVoteMsg = msg;
  }

  const cv = match.cancelVote;
  if (cv.votes.has(userId)) {
    cv.votes.delete(userId);
  } else {
    cv.votes.add(userId);
  }

  await match.cancelVoteMsg.edit({
    embeds: [buildCancelVoteEmbed(cv)],
    components: [buildCancelVoteRow()],
  }).catch(() => {});

  if (cv.votes.size >= CANCEL_VOTES_NEEDED) {
    await match.cancelVoteMsg.edit({ content: '🚫 **Match cancelled by player vote.**', components: [] }).catch(() => {});
    for (const p of allPlayers) g.blocked.delete(p.id);
    if (match.textChannelId) matchChannelMap.delete(match.textChannelId);
    g.match = null;
    await refreshQueueEmbed(g);
    setTimeout(() => {
      if (match.vcA) match.vcA.delete().catch(() => {});
      if (match.vcB) match.vcB.delete().catch(() => {});
      if (match.matchQueueVc) match.matchQueueVc.delete().catch(() => {});
      if (match.textChannel) match.textChannel.delete().catch(() => {});
    }, 5000);
    return { status: 'cancelled' };
  }

  return { status: 'voted', count: cv.votes.size, needed: CANCEL_VOTES_NEEDED };
}

// Called on bot ready — scans all guild text channels for an existing queue embed
// and restores in-memory state so commands like /stopqueue and /renamequeue work.
async function recoverQueues(client) {
  for (const guild of client.guilds.cache.values()) {
    for (const channel of guild.channels.cache.values()) {
      if (channel.type !== ChannelType.GuildText) continue;
      // Skip if this channel already has an active queue in memory
      const existing = guilds.get(channel.id);
      if (existing?.active) continue;
      try {
        const recent = await channel.messages.fetch({ limit: 20 });
        const queueMsg = recent.find(
          m => m.author.id === client.user.id &&
               m.components?.some(row => row.components?.some(c => c.customId === 'q8_join')),
        );
        if (queueMsg) {
          const g = getGuild(channel.id);
          g.message = queueMsg;
          g.active = true;
          g.guildId = guild.id;
          g.queueChannelId = channel.id;
          // Can't reliably recover the original name; refreshQueueEmbed will strip the suffix
          g.queueChannelBaseName = null;

          const footerText = queueMsg.embeds?.[0]?.footer?.text ?? '';
          const gameMatch = footerText.match(/^game:(\w+)$/);
          g.game = gameMatch && GAME_MAPS[gameMatch[1]] ? gameMatch[1] : 'bo6';

          const title = queueMsg.embeds?.[0]?.title ?? '';
          const gameLabel = GAME_MAPS[g.game]?.label;
          const titleSansGame = gameLabel ? title.replace(new RegExp(`\\s+—\\s+${gameLabel}$`), '') : title;
          const nameMatch = titleSansGame.match(/^(.+?)\s+•|^(.+)$/);
          if (nameMatch) g.queueName = nameMatch[1] ?? nameMatch[2];

          // Re-start the inactivity interval
          if (!g.inactivityInterval) {
            const INACTIVITY_MS = 30 * 60 * 1000;
            g.inactivityInterval = setInterval(async () => {
              if (!g.active || g.match) return;
              const now = Date.now();
              const timedOut = g.players.filter(p => now - (p.joinedAt ?? now) >= INACTIVITY_MS);
              if (!timedOut.length) return;
              g.players = g.players.filter(p => now - (p.joinedAt ?? now) < INACTIVITY_MS);
              g.lastEvent = `Player Left Queue Due To Inactivity\n${timedOut.map(p => `<@${p.id}>`).join(' ')}`;
              await refreshQueueEmbed(g);
            }, 60 * 1000);
          }
        }
      } catch { /* ignore channels we can't read */ }
    }
  }
}

async function handleRematch(guildId, matchNum, requesterId) {
  const key = `${guildId}_${matchNum}`;
  const pr = pendingResults.get(key);
  if (!pr) return { status: 'not_found' };
  if (!pr.players.some(p => p.id === requesterId)) return { status: 'not_in_match' };

  const g = pr.queueChannelId ? guilds.get(pr.queueChannelId) : null;
  if (!g?.active) return { status: 'no_queue' };

  // Disable the buttons on the results message
  if (pr.resultsMsg) {
    await pr.resultsMsg.edit({ components: [] }).catch(() => {});
  }
  pendingResults.delete(key);

  // Re-add all 8 players to the front of the queue with a fresh inactivity window
  const rematchNow = Date.now();
  for (const p of pr.players) {
    if (!g.players.some(x => x.id === p.id)) {
      g.players.unshift({ ...p, joinedAt: rematchNow });
    }
  }
  g.lastEvent = `🔄 Rematch — same 8 players re-queued`;
  await refreshQueueEmbed(g);

  // If we already have 8, fire immediately
  if (g.players.length >= QUEUE_SIZE) {
    const next = g.players[g.players.length - 1];
    await joinQueue(pr.queueChannelId, { id: next.id, displayName: next.displayName });
  }

  return { status: 'ok' };
}

function buildMvpSelectRow(players, matchNum) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`q8_mvp_vote_${matchNum}`)
      .setPlaceholder('Select the MVP')
      .addOptions(players.map(p => ({ label: p.displayName, value: p.id }))),
  );
}

async function handleMvpOpen(guildId, matchNum, channel) {
  const key = `${guildId}_${matchNum}`;
  const pr = pendingResults.get(key);
  if (!pr) return { status: 'not_found' };
  if (pr.mvpMsg) return { status: 'already_open' };

  const msg = await channel.send({
    content: `🏆 **Vote for the MVP of Queue #${matchNum}!**`,
    components: [buildMvpSelectRow(pr.players, matchNum)],
  });
  pr.mvpMsg = msg;
  return { status: 'ok' };
}

async function handleMvpVote(guildId, matchNum, voterId, nomineeId) {
  const key = `${guildId}_${matchNum}`;
  const pr = pendingResults.get(key);
  if (!pr) return { status: 'not_found' };
  if (!pr.players.some(p => p.id === voterId)) return { status: 'not_in_match' };

  pr.mvpVotes.set(voterId, nomineeId);

  // Tally
  const tally = new Map();
  for (const id of pr.mvpVotes.values()) tally.set(id, (tally.get(id) ?? 0) + 1);

  if (pr.mvpVotes.size >= pr.players.length) {
    // All voted — announce winner
    const [mvpId] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
    if (pr.mvpMsg) {
      await pr.mvpMsg.edit({
        content: `🏆 **MVP of Queue #${matchNum}: <@${mvpId}>!**`,
        components: [],
      }).catch(() => {});
    }
    pendingResults.delete(key);
    return { status: 'decided', mvpId };
  }

  return { status: 'voted', count: pr.mvpVotes.size, total: pr.players.length };
}

module.exports = {
  startQueue, stopQueue, toggleTestMode, renameQueue, lockQueue, recoverQueues, joinQueue, leaveQueue, clearQueue,
  handleMethodVote, finalizeMethodVote,
  handleFormatVote, finalizeFormatVote,
  handleCaptainVote, finalizeCaptainVote, randomizeCaptains,
  handlePick, handleMatchVote,
  cancelMatch, handleCancelVote,
  handleRematch, handleMvpOpen, handleMvpVote,
};
