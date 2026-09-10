// src/routes/auth.js
const express = require('express');
const db = require('../db');
const { hashPassword, verifyPassword, issueSessionToken, requireAuth } = require('../auth');
const { audit } = require('../utils/audit');
const { validateRegistration } = require('../security');

const router = express.Router();

router.post('/register', validateRegistration, async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email, and password are required' });
  }
  const allowedRoles = ['customer', 'organizer_owner'];
  const finalRole = allowedRoles.includes(role) ? role : 'customer';

  const existing = await db.one('SELECT id FROM users WHERE email = $1', [email]);
  if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

  const passwordHash = hashPassword(password);
  const created = await db.one(
    'INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING id',
    [name, email, passwordHash, finalRole]
  );

  const user = { id: created.id, name, email, role: finalRole };
  await audit(user.id, 'user.registered', 'user', user.id, { role: finalRole });

  const token = issueSessionToken(user);
  res.status(201).json({ token, user });
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const row = await db.one('SELECT * FROM users WHERE email = $1 AND deleted_at IS NULL', [email]);
  if (!row || !verifyPassword(password, row.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const user = { id: row.id, name: row.name, email: row.email, role: row.role };
  await audit(user.id, 'user.login', 'user', user.id, {});
  const token = issueSessionToken(user);
  res.json({ token, user });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: { id: req.user.sub, name: req.user.name, email: req.user.email, role: req.user.role } });
});

module.exports = router;
