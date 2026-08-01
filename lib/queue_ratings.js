const sqlite3 = require('better-sqlite3');
const path = require('path');

const db = sqlite3(path.join(__dirname, '../database/throwback8s_data.db'));

db.prepare(`
  CREATE TABLE IF NOT EXISTS queue_ratings (
    guild_id TEXT NOT NULL,
    user_id  TEXT NOT NULL,
    rating   REAL NOT NULL DEFAULT 1000,
    wins     INTEGER NOT NULL DEFAULT 0,
    losses   INTEGER NOT NULL DEFAULT 0,
    streak   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, user_id)
  )
`).run();

const DEFAULT_RATING = 1000;
const K = 32;

function getPlayer(guildId, userId) {
  return db.prepare('SELECT * FROM queue_ratings WHERE guild_id = ? AND user_id = ?').get(guildId, userId)
    ?? { guild_id: guildId, user_id: userId, rating: DEFAULT_RATING, wins: 0, losses: 0, streak: 0 };
}

function upsert(guildId, userId, rating, wins, losses, streak) {
  db.prepare(`
    INSERT INTO queue_ratings (guild_id, user_id, rating, wins, losses, streak)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET
      rating = excluded.rating,
      wins   = excluded.wins,
      losses = excluded.losses,
      streak = excluded.streak
  `).run(guildId, userId, rating, wins, losses, streak);
}

function expectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

// teamA = winners, teamB = losers
// Returns array of { userId, oldRating, newRating, delta, won }
function processMatchResult(guildId, teamA, teamB) {
  const aPlayers = teamA.map(p => getPlayer(guildId, p.id));
  const bPlayers = teamB.map(p => getPlayer(guildId, p.id));

  const avgA = aPlayers.reduce((s, p) => s + p.rating, 0) / aPlayers.length;
  const avgB = bPlayers.reduce((s, p) => s + p.rating, 0) / bPlayers.length;

  const expA = expectedScore(avgA, avgB);
  const expB = 1 - expA;

  const deltaA = parseFloat((K * (1 - expA)).toFixed(1));
  const deltaB = parseFloat((K * (0 - expB)).toFixed(1));

  const results = [];

  const update = db.transaction(() => {
    for (const p of aPlayers) {
      const newRating = Math.max(0, p.rating + deltaA);
      const newStreak = p.streak >= 0 ? p.streak + 1 : 1;
      upsert(guildId, p.user_id, newRating, p.wins + 1, p.losses, newStreak);
      results.push({ userId: p.user_id, oldRating: p.rating, newRating, delta: deltaA, won: true });
    }
    for (const p of bPlayers) {
      const newRating = Math.max(0, p.rating + deltaB);
      const newStreak = p.streak <= 0 ? p.streak - 1 : -1;
      upsert(guildId, p.user_id, newRating, p.wins, p.losses + 1, newStreak);
      results.push({ userId: p.user_id, oldRating: p.rating, newRating, delta: deltaB, won: false });
    }
  });
  update();

  return results;
}

function getLeaderboard(guildId, limit = 10) {
  return db.prepare(`
    SELECT * FROM queue_ratings
    WHERE guild_id = ?
    ORDER BY rating DESC
    LIMIT ?
  `).all(guildId, limit);
}

function resetPlayer(guildId, userId) {
  db.prepare('DELETE FROM queue_ratings WHERE guild_id = ? AND user_id = ?').run(guildId, userId);
}

function resetAll(guildId) {
  db.prepare('DELETE FROM queue_ratings WHERE guild_id = ?').run(guildId);
}

// ─── Queue bans ───────────────────────────────────────────────────────────────

db.prepare(`
  CREATE TABLE IF NOT EXISTS queue_bans (
    guild_id   TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    reason     TEXT,
    banned_by  TEXT,
    banned_at  INTEGER NOT NULL,
    expires_at INTEGER,
    PRIMARY KEY (guild_id, user_id)
  )
`).run();

// Add expires_at column if it doesn't exist yet (migration for existing installs)
try {
  db.prepare('ALTER TABLE queue_bans ADD COLUMN expires_at INTEGER').run();
} catch { /* column already exists */ }

function banPlayer(guildId, userId, reason, bannedBy, expiresAt = null) {
  db.prepare(`
    INSERT INTO queue_bans (guild_id, user_id, reason, banned_by, banned_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(guild_id, user_id) DO UPDATE SET
      reason = excluded.reason, banned_by = excluded.banned_by,
      banned_at = excluded.banned_at, expires_at = excluded.expires_at
  `).run(guildId, userId, reason ?? null, bannedBy ?? null, Date.now(), expiresAt ?? null);
}

function unbanPlayer(guildId, userId) {
  const info = db.prepare('DELETE FROM queue_bans WHERE guild_id = ? AND user_id = ?').run(guildId, userId);
  return info.changes > 0;
}

function isBanned(guildId, userId) {
  const row = db.prepare('SELECT expires_at FROM queue_bans WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
  if (!row) return false;
  if (row.expires_at !== null && row.expires_at <= Date.now()) {
    db.prepare('DELETE FROM queue_bans WHERE guild_id = ? AND user_id = ?').run(guildId, userId);
    return false;
  }
  return true;
}

function getBan(guildId, userId) {
  return db.prepare('SELECT * FROM queue_bans WHERE guild_id = ? AND user_id = ?').get(guildId, userId);
}

module.exports = { getPlayer, processMatchResult, getLeaderboard, resetPlayer, resetAll, DEFAULT_RATING, banPlayer, unbanPlayer, isBanned, getBan };
