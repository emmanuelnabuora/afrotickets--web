// src/utils/qrTicket.js
// A real digital ticket = a signed JWT (so it can't be forged or edited) whose
// one-time-use state lives in the database (so it can't be reused after entry,
// which a JWT's own signature can never enforce on its own).
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { JWT_SECRET } = require('../auth');

// Ticket tokens are signed with a *separate* secret from session tokens so a
// leaked ticket QR can never be used to authenticate as the user.
const TICKET_SECRET = process.env.TICKET_SECRET || 'dev-ticket-secret-change-me';

function signTicketToken({ ticketId, eventId, ticketTypeId, ownerUserId }) {
  const jti = crypto.randomBytes(12).toString('hex'); // unique id, checked against DB on scan
  const token = jwt.sign(
    { ticketId, eventId, ticketTypeId, ownerUserId, jti },
    TICKET_SECRET,
    { expiresIn: '180d' } // long-lived signature; actual validity is DB status, not expiry
  );
  return { token, jti };
}

function verifyTicketToken(token) {
  // Throws if the signature is invalid or the token was tampered with.
  return jwt.verify(token, TICKET_SECRET);
}

async function ticketQrDataUrl(token) {
  // PNG data URL the client can render directly in an <img src="...">
  return QRCode.toDataURL(token, { margin: 1, width: 320, color: { dark: '#160B2E', light: '#FFFFFF' } });
}

module.exports = { signTicketToken, verifyTicketToken, ticketQrDataUrl };
