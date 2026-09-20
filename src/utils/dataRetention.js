// src/utils/dataRetention.js
// Automated cleanup of data that has no ongoing purpose past its own natural
// expiry — consumed/expired verification secrets, stale sessions, and old
// notifications. audit_log is deliberately never touched here: it's the
// platform's record of what happened, not data with a retention window, and
// the DB-level trigger added alongside this (see db.js) would reject a
// delete against it anyway.
const db = require('./../db');

const VERIFICATION_RETENTION_DAYS = Number(process.env.VERIFICATION_RETENTION_DAYS) || 30;
const SESSION_RETENTION_DAYS = Number(process.env.SESSION_RETENTION_DAYS) || 90;
const NOTIFICATION_RETENTION_DAYS = Number(process.env.NOTIFICATION_RETENTION_DAYS) || 180;
const SWEEP_INTERVAL_MS = Number(process.env.RETENTION_SWEEP_INTERVAL_MS) || 24 * 60 * 60 * 1000;

// Fixed, hard-coded table list — never built from user input.
const VERIFICATION_TABLES = ['email_verifications', 'phone_verifications', 'password_resets'];

async function sweep() {
  const report = {};
  try {
    for (const table of VERIFICATION_TABLES) {
      const deleted = await db.query(
        `DELETE FROM ${table} WHERE expires_at < now() - ($1 || ' days')::interval RETURNING id`,
        [VERIFICATION_RETENTION_DAYS]
      );
      report[table] = deleted.length;
    }

    // Only sessions that are both no-longer-usable (revoked or expired) AND
    // old enough — an active, unexpired session is never touched here.
    const sessionsDeleted = await db.query(
      `DELETE FROM sessions
       WHERE (revoked_at IS NOT NULL OR expires_at < now())
         AND expires_at < now() - ($1 || ' days')::interval
       RETURNING id`,
      [SESSION_RETENTION_DAYS]
    );
    report.sessions = sessionsDeleted.length;

    const notificationsDeleted = await db.query(
      `DELETE FROM notifications WHERE sent_at < now() - ($1 || ' days')::interval RETURNING id`,
      [NOTIFICATION_RETENTION_DAYS]
    );
    report.notifications = notificationsDeleted.length;
  } catch (err) {
    console.error('[dataRetention] sweep failed:', err.message);
  }
  return report;
}

// Runs once at boot, then on a fixed interval for as long as the process
// lives. .unref() so a scheduled sweep never keeps the process alive on its
// own during shutdown.
function startRetentionSweep() {
  sweep().then((report) => console.log('[dataRetention] initial sweep:', report));
  const timer = setInterval(() => {
    sweep().then((report) => console.log('[dataRetention] sweep:', report));
  }, SWEEP_INTERVAL_MS);
  timer.unref();
}

module.exports = { sweep, startRetentionSweep };
