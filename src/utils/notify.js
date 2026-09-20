// src/utils/notify.js
// Real delivery on email/SMS/WhatsApp when a provider is configured; falls
// back to a console log (and always writes the in-app row regardless) when
// not — the same "real when possible, honest fallback otherwise" pattern
// used for payments. A delivery failure here must never break the caller
// (a payment webhook, an admin action, etc.), so every send is caught.
const db = require('../db');
const email = require('./emailProvider');
const sms = require('./smsProvider');
const whatsapp = require('./whatsappProvider');
const { renderNotification } = require('./notificationTemplates');
const pii = require('./piiCrypto');

async function notify(userId, type, payload, channels = ['in_app', 'email']) {
  // notify() must never reject — it's called fire-and-forget in some paths
  // and awaited-but-uncaught in others; a rejection here should never be
  // able to break the action that triggered it (a payment webhook, an
  // admin approval, etc.), so everything below is wrapped accordingly.
  try {
    let user = null;
    try {
      user = await db.one('SELECT email, phone FROM users WHERE id = $1', [userId]);
      // phone is stored encrypted (utils/piiCrypto.js) — decrypt before it's
      // ever handed to an SMS/WhatsApp provider, or delivery would send the
      // ciphertext instead of a real phone number.
      if (user) user.phone = pii.decrypt(user.phone);
    } catch (err) {
      // proceed without contact info — in-app row still gets written below
    }
    const { subject, body } = renderNotification(type, payload);

    for (const channel of channels) {
      try {
        await db.query(
          `INSERT INTO notifications (user_id, type, channel, payload) VALUES ($1, $2, $3, $4)`,
          [userId, type, channel, JSON.stringify(payload)]
        );
      } catch (err) {
        console.error(`[notify] failed to record ${channel} notification for user ${userId}:`, err.message);
        continue;
      }
      if (channel === 'in_app') continue;

      try {
        if (channel === 'email' && email.isConfigured() && user?.email) {
          await email.sendEmail({ to: user.email, subject, text: body });
        } else if (channel === 'sms' && sms.isConfigured() && user?.phone) {
          await sms.sendSMS({ to: user.phone, message: body });
        } else if (channel === 'whatsapp' && whatsapp.isConfigured() && user?.phone) {
          await whatsapp.sendWhatsApp({ to: user.phone, message: body });
        } else {
          console.log(`[notify:${channel}] -> user ${userId} :: ${type}`, payload);
        }
      } catch (err) {
        console.error(`[notify:${channel}] delivery failed for user ${userId}:`, err.message);
      }
    }
  } catch (err) {
    console.error(`[notify] unexpected failure for user ${userId}:`, err.message);
  }
}

module.exports = { notify };
