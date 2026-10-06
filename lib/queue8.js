const {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  StringSelectMenuBuilder, ChannelType, OverwriteType,
} = require('discord.js');
const { processMatchResult, isBanned, banPlayer } = require('./queue_ratings');
const matchRegistry = require('./matchRegistry');

const GAME_MAPS  = require('../config/game_maps.json');
const QUEUE_SIZE   = 8;
const VOTES_TO_WIN = 4;

// The pre-match votes (captain method, format, captains) move on as soon as this many players
// have voted — the rest don't have to. Capped at the lobby size just in case.
const VOTES_TO_ADVANCE = 5;
const votesNeeded = players => Math.min(VOTES_TO_ADVANCE, players.length);

// Owner + staff: can always see match channels even when they aren't one of the 8 players.
// Entries may be role ids or user ids — each is resolved against the guild at use time.
const QUEUE_STAFF_IDS = ['1532791099771326594', '1532943445927395598'];

// Builds typed permission overwrites for QUEUE_STAFF_IDS. An id that is neither a role nor a
// member of this guild is skipped, because one bad overwrite would make the whole channel
// creation fail and take the match down with it.
async function staffOverwrites(guild, allow) {
  const out = [];
  for (const id of QUEUE_STAFF_IDS) {
    if (guild.roles.cache.has(id)) {
      out.push({ id, type: OverwriteType.Role, allow });
    } else if (await guild.members.fetch(id).then(() => true).catch(() => false)) {
      out.push({ id, type: OverwriteType.Member, allow });
    }
  }
  return out;
}

// Test-mode players are fake ids shaped `test_<slot>_<realUserId>`; map them back to the real user.
function realUserId(playerId) {
  const m = /^test_\d+_(.+)$/.exec(String(playerId));
  return m ? m[1] : String(playerId);
}

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
    .setDescription(`${mv.votes.size}/${votesNeeded(mv.players)} votes needed. Click again to change.`)
    .addFields({ name: 'Votes', value: lines.join('\n') })
    .setFooter({ text: `Moves on once ${votesNeeded(mv.players)} players have voted. Most votes wins. Staff can decide early.` });
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
    .setDescription(`${mv.votes.size}/${votesNeeded(mv.players)} votes needed. Click again to change.\nMaps are assigned randomly from the CDL pool after teams are picked.`)
    .addFields({ name: 'Options', value: lines.join('\n') })
    .setFooter({ text: `Moves on once ${votesNeeded(mv.players)} players have voted. Most votes wins. Staff can decide early.` });
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
    .setDescription(`Select up to **2** captain candidates. Re-submit to change/remove.\n${cv.votes.size}/${votesNeeded(cv.players)} votes needed.`)
    .addFields({ name: 'Standings', value: lines.join('\n') })
    .setFooter({ text: `Top 2 become captains once ${votesNeeded(cv.players)} players have voted. Any player can randomize; staff can end voting.` });
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

// Stops the staging-VC watcher (see retireStagingVc). Called whenever a match ends.
function clearStagingWatch(match) {
  if (match.stagingTimer) { clearInterval(match.stagingTimer); match.stagingTimer = null; }
}

// Deletes the match's temporary queue VC, but ONLY once no player is still inside it —
// deleting a voice channel disconnects everyone in it. Until then it re-drags any player it
// finds in there (a move can fail, or someone can join late) into their team's VC. People who
// aren't players (spectators, staff) don't hold the channel open. If a player can never be
// moved, the channel simply stays until the match ends and is removed with the others.
function retireStagingVc(match, teamVcByUser) {
  const vc = match.matchQueueVc;
  if (!vc) return;
  clearStagingWatch(match);
  let busy = false;
  match.stagingTimer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      if (match.matchQueueVc !== vc) { clearStagingWatch(match); return; } // match ended / already removed
      const stuck = [...vc.members.values()].filter(m => teamVcByUser.has(m.id));
      if (stuck.length) {
        await Promise.all(stuck.map(m => m.voice.setChannel(teamVcByUser.get(m.id), '8s teams locked in').catch(() => {})));
        return;
      }
      clearStagingWatch(match);
      match.matchQueueVc = null;
      await vc.delete('8s match started').catch(() => {});
    } finally {
      busy = false;
    }
  }, 2000);
  match.stagingTimer.unref?.();
}

// Moves every player who is connected to ANY voice channel in the server into `vc`.
// Returns who moved, who simply isn't in a call, and who couldn't be moved (missing
// permission, left the server, disconnected mid-move) so callers can tell players to join
// by hand. Test-mode players are fake ids and are treated as not in voice.
async function moveToVc(guild, players, vc, reason) {
  const out = { moved: new Set(), notInVoice: [], failed: [] };
  await Promise.all(players.map(async p => {
    if (String(p.id).startsWith('test_')) { out.notInVoice.push(p); return; }
    try {
      const member = await guild.members.fetch(p.id);
      if (!member.voice?.channel) { out.notInVoice.push(p); return; }
      if (member.voice.channelId !== vc.id) await member.voice.setChannel(vc, reason);
      out.moved.add(p.id);
    } catch {
      out.failed.push(p);
    }
  }));
  return out;
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
  // channelId is the match text channel (that's where draft interactions come from), not the
  // queue lobby — getGuild() here would create a blank state and crash on the final pick.
  const g = resolveQueue(channelId);
  if (!g?.match?.pickState) return;
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
  const testPermissions = g.testMode ? [
    { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: ['ViewChannel'] },
    ...await staffOverwrites(guild, ['ViewChannel', 'Connect']),
  ] : null;
  const [vcA, vcB] = await Promise.all([
    guild.channels.create({ name: '🔵 Team 1', type: ChannelType.GuildVoice, ...vcOpts, ...(testPermissions ? { permissionOverwrites: testPermissions } : {}) }),
    guild.channels.create({ name: '🔴 Team 2', type: ChannelType.GuildVoice, ...vcOpts, ...(testPermissions ? { permissionOverwrites: testPermissions } : {}) }),
  ]);

  g.match.vcA = vcA;
  g.match.vcB = vcB;
  matchRegistry.addChannels(g.match.registryKey, [vcA.id, vcB.id]);
  g.match.pickState = null;

  // Drag each player into their team's voice channel. This must finish BEFORE the staging VC
  // is deleted: deleting a voice channel disconnects everyone still inside it, which used to
  // kick the players who were waiting there before they could be moved.
  const [moveA, moveB] = await Promise.all([
    moveToVc(guild, teamA, vcA, '8s teams locked in'),
    moveToVc(guild, teamB, vcB, '8s teams locked in'),
  ]);
  const notMoved = [...moveA.notInVoice, ...moveA.failed, ...moveB.notInVoice, ...moveB.failed];

  // The temporary queue staging VC goes only once no player is left in it (see retireStagingVc):
  // deleting it disconnects whoever is inside, so anyone whose move failed or who joined late
  // is dragged again first.
  const teamVcByUser = new Map();
  for (const p of teamA) teamVcByUser.set(p.id, vcA);
  for (const p of teamB) teamVcByUser.set(p.id, vcB);
  retireStagingVc(g.match, teamVcByUser);

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

    const testPermissions = g.testMode ? [
      { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: ['ViewChannel'] },
      ...await staffOverwrites(guild, ['ViewChannel', 'Connect']),
    ] : null;

    // The match text channel is private: only the 8 players who popped, the bot, and the
    // owner/staff can see it. Players who've since left the server are skipped so a
    // stale id can't make channel creation fail.
    const realIds = [...new Set(popped.map(p => realUserId(p.id)))];
    const presentIds = (await Promise.all(
      realIds.map(id => guild.members.fetch(id).then(() => id).catch(() => null)),
    )).filter(Boolean);
    const playerPerms = ['ViewChannel', 'SendMessages', 'ReadMessageHistory'];
    const matchTextPermissions = [
      { id: guild.roles.everyone.id, type: OverwriteType.Role, deny: ['ViewChannel'] },
      ...await staffOverwrites(guild, playerPerms),
      { id: guild.client.user.id, type: OverwriteType.Member, allow: [...playerPerms, 'EmbedLinks'] },
      ...presentIds.map(id => ({ id, type: OverwriteType.Member, allow: playerPerms })),
    ];

    const [textCh, matchQueueVc] = await Promise.all([
      guild.channels.create({ name: `queue-${matchNum}`, type: ChannelType.GuildText, ...vcOpts, permissionOverwrites: matchTextPermissions }).catch(() => null),
      guild.channels.create({ name: `🎮 Queue #${matchNum}`, type: ChannelType.GuildVoice, ...vcOpts, ...(testPermissions ? { permissionOverwrites: testPermissions } : {}) }).catch(() => null),
    ]);

    if (textCh) matchChannelMap.set(textCh.id, channelId);
    // Record the channel ids on disk so a restart can clean them up (see cleanupStaleMatches).
    const registryKey = textCh?.id ?? matchQueueVc?.id ?? null;
    matchRegistry.track(registryKey, {
      guildId: guild.id, queueChannelId: channelId, matchNum, startedAt: Date.now(),
      channelIds: [textCh?.id, matchQueueVc?.id].filter(Boolean),
    });
    if (g.inactivityInterval) { clearInterval(g.inactivityInterval); g.inactivityInterval = null; }
    g.lastEvent = null;
    g.match = {
      registryKey,
      textChannelId: textCh?.id ?? null,
      teamA: [], teamB: [], vcA: null, vcB: null,
      textChannel: textCh, matchQueueVc, categoryId: queueCategory ?? null, format: null, maps: null, _captainMethod: 'random',
      game: g.game,
      votes: new Map(), voteMsg: null, pickState: null,
      players: popped, vcTimer: null, vcWarnTimer: null,
    };

    await refreshQueueEmbed(g);

    // Pull anyone who is already in a voice channel into the staging VC so they don't have to
    // go looking for it. Whoever couldn't be moved stays on the "still waiting" list below.
    const pulled = matchQueueVc
      ? (await moveToVc(guild, popped, matchQueueVc, '8s queue popped')).moved
      : new Set();

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
            ? `All players must join <#${matchQueueVc.id}> before the timer expires or the match will be cancelled.` +
              (pulled.size ? `\nPlayers already in a voice channel (${pulled.size}) were moved in automatically.` : '')
            : 'All players must be ready before the timer expires.'
        )
        .addFields(
          { name: '⏱️ Deadline', value: `<t:${deadlineTs}:R>` },
          { name: `⏳ Still Waiting (${missingPlayers.length})`, value: missingPlayers.length ? missingPlayers.map(p => `<@${p.id}>`).join('\n') : '✅ Everyone is in!' },
        )
        .setFooter({ text: 'Players who join in time will be kept. No-shows are dropped.' });

      countdownMsg = await textCh.send({ content: ping, embeds: [buildCountdownEmbed(popped.filter(p => !pulled.has(p.id)))] });
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
        matchRegistry.untrack(match.registryKey);
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
  if (mv.votes.size >= votesNeeded(mv.players)) return finalizeMethodVote(channelId);
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
  if (mv.votes.size >= votesNeeded(mv.players)) return finalizeFormatVote(channelId);
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
  // Only the 8 popped players are valid candidates, and at most 2 of them.
  const candidates = new Set(cv.players.map(p => p.id));
  cv.votes.set(voterId, selectedIds.filter(id => candidates.has(id)).slice(0, 2));
  await cv.message.edit({ embeds: [buildCaptainVoteEmbed(cv)], components: buildCaptainVoteComponents(cv) }).catch(() => {});
  if (cv.votes.size >= votesNeeded(cv.players)) return finalizeCaptainVote(channelId);
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

// Snake draft pick. `userId` is the Discord user who clicked the dropdown — only the
// captain whose turn it is may pick (the customId alone proves nothing about the clicker).
async function handlePick(channelId, userId, pickedPlayerId) {
  const g = resolveQueue(channelId);
  if (!g) return { status: 'no_pick' };
  const ps = g.match?.pickState;
  if (!ps) return { status: 'no_pick' };
  const captainUserIds = [ps.teamA[0].id, ps.teamB[0].id].map(realUserId);
  if (!captainUserIds.includes(userId)) return { status: 'not_captain' };
  const expectedCaptainId = ps.turn === 'A' ? ps.teamA[0].id : ps.teamB[0].id;
  if (realUserId(expectedCaptainId) !== userId) return { status: 'not_your_turn' };
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
    clearStagingWatch(match);

    // Delete match channels after a short delay
    setTimeout(() => {
      if (match.vcA) match.vcA.delete().catch(() => {});
      if (match.vcB) match.vcB.delete().catch(() => {});
      if (match.matchQueueVc) match.matchQueueVc.delete().catch(() => {}); // only still set if a player never left it
      if (match.textChannel) match.textChannel.delete().catch(() => {});
      matchRegistry.untrack(match.registryKey);
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

// Match state lives in memory, so a bot restart orphans any in-flight match: its channels
// stay behind but cancelMatch() can no longer find it. These two helpers let staff clean
// that up from inside the match's `queue-<n>` text channel.
function trackedMatchChannelIds() {
  const ids = new Set();
  for (const g of guilds.values()) {
    const m = g.match;
    if (!m) continue;
    for (const c of [m.textChannel, m.vcA, m.vcB, m.matchQueueVc]) if (c?.id) ids.add(c.id);
    if (m.textChannelId) ids.add(m.textChannelId);
  }
  return ids;
}

// Returns { channel, voices } if `channel` is a queue-<n> match channel the bot has no
// record of, otherwise null. Voice channels still owned by a live match are never included
// (after a restart the match counter resets, so a live "🎮 Queue #1" can share a name with
// an orphaned one).
function findOrphanedMatch(channel) {
  if (!channel || channel.type !== ChannelType.GuildText) return null;
  const m = /^queue-(\d+)$/.exec(channel.name ?? '');
  if (!m) return null;
  if (matchChannelMap.has(channel.id) || guilds.has(channel.id)) return null;
  const tracked = trackedMatchChannelIds();
  const voices = [...channel.guild.channels.cache.values()].filter(c =>
    c.type === ChannelType.GuildVoice &&
    c.parentId === channel.parentId &&
    !tracked.has(c.id) &&
    (c.name === `🎮 Queue #${m[1]}` || c.name === '🔵 Team 1' || c.name === '🔴 Team 2'),
  );
  return { channel, voices };
}

// Deletes the voice channels first and the text channel last, so a command run inside the
// text channel can still reply before it disappears.
async function removeOrphanedMatch({ channel, voices }) {
  for (const vc of voices) await vc.delete('Orphaned 8s match cleanup').catch(() => {});
  matchRegistry.untrack(channel.id);
  await channel.delete('Orphaned 8s match cleanup').catch(() => {});
}

// Runs once at startup. A restart wipes in-memory match state, so every match still in the
// on-disk registry is stranded: delete exactly the channels recorded for it (by id, never by
// name) and tell the lobby so those players know to re-queue. Entries whose channels belong
// to a match that is live right now are skipped, in case a match popped before this ran.
async function cleanupStaleMatches(client) {
  const tracked = trackedMatchChannelIds();
  for (const [key, entry] of Object.entries(matchRegistry.all())) {
    const ids = entry.channelIds ?? [];
    if (ids.some(id => tracked.has(id))) continue;
    try {
      const found = (await Promise.all(ids.map(id => client.channels.fetch(id).catch(() => null)))).filter(Boolean);
      for (const channel of found) await channel.delete('8s match orphaned by bot restart').catch(() => {});
      if (found.length && entry.queueChannelId) {
        const lobby = await client.channels.fetch(entry.queueChannelId).catch(() => null);
        if (lobby?.isTextBased?.()) {
          await lobby.send(`⚠️ The bot restarted, so queue match #${entry.matchNum} was cancelled. Please re-queue.`).catch(() => {});
        }
      }
    } catch { /* drop the entry below regardless */ }
    matchRegistry.untrack(key);
  }
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
  clearStagingWatch(match);
  await refreshQueueEmbed(g);

  setTimeout(() => {
    if (match.vcA) match.vcA.delete().catch(() => {});
    if (match.vcB) match.vcB.delete().catch(() => {});
    if (match.matchQueueVc) match.matchQueueVc.delete().catch(() => {});
    if (match.textChannel) match.textChannel.delete().catch(() => {});
    matchRegistry.untrack(match.registryKey);
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
    clearStagingWatch(match);
    await refreshQueueEmbed(g);
    setTimeout(() => {
      if (match.vcA) match.vcA.delete().catch(() => {});
      if (match.vcB) match.vcB.delete().catch(() => {});
      if (match.matchQueueVc) match.matchQueueVc.delete().catch(() => {});
      if (match.textChannel) match.textChannel.delete().catch(() => {});
      matchRegistry.untrack(match.registryKey);
    }, 5000);
    return { status: 'cancelled' };
  }

  return { status: 'voted', count: cv.votes.size, needed: CANCEL_VOTES_NEEDED };
}

// Called on bot ready — scans all guild text channels for an existing queue embed
// and restores in-memory state (game, name, lock, and the waiting players listed in the
// embed) so commands like /stopqueue and /renamequeue work and nobody is silently dropped.
async function recoverQueues(client) {
  // First clear out matches stranded by the restart (best effort — must never block recovery).
  await cleanupStaleMatches(client).catch(() => {});

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

          // Rebuild the waiting list from the embed's slot fields. Without this a restart leaves
          // the embed showing players as queued while the bot has forgotten them. Capped below
          // QUEUE_SIZE (a full lobby would already have popped), and anyone who has since left
          // the server is dropped. Blocked-until-voted players can't be recovered, which is fine:
          // a restart cancels any in-flight match, so nobody should still be blocked.
          const queueEmbed = queueMsg.embeds?.[0];
          const slotText = (queueEmbed?.fields ?? []).map(f => f.value ?? '').join('\n');
          const slotIds = [...new Set([...slotText.matchAll(/<@!?(\d{15,25})>/g)].map(m => m[1]))].slice(0, QUEUE_SIZE - 1);
          const restored = [];
          for (const id of slotIds) {
            const member = await guild.members.fetch(id).catch(() => null);
            if (member) restored.push({ id, displayName: member.displayName, joinedAt: Date.now() });
          }
          g.players = restored;
          g.locked = /Queue is locked/.test(queueEmbed?.description ?? '');
          g.testMode = (queueMsg.content ?? '').includes('TEST MODE');
          // If someone shown in the embed couldn't be restored, correct what players see.
          if (restored.length !== slotIds.length) await refreshQueueEmbed(g);

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
  cancelMatch, handleCancelVote, findOrphanedMatch, removeOrphanedMatch, cleanupStaleMatches,
  handleRematch, handleMvpOpen, handleMvpVote,
};
