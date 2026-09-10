// src/utils/audit.js
const db = require('../db');

async function audit(actorUserId, action, targetType, targetId, meta = {}) {
  await db.query(
    `INSERT INTO audit_log (actor_user_id, action, target_type, target_id, meta) VALUES ($1, $2, $3, $4, $5)`,
    [actorUserId ?? null, action, targetType ?? null, targetId ?? null, JSON.stringify(meta)]
  );
}

module.exports = { audit };
