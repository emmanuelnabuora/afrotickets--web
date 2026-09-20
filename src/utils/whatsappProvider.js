// src/utils/whatsappProvider.js
// Real WhatsApp delivery via Meta's WhatsApp Business Cloud API — a plain
// fetch() call against the Graph API, no SDK needed.
function isConfigured() {
  return !!(process.env.WHATSAPP_ACCESS_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

async function sendWhatsApp({ to, message }) {
  const url = `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.WHATSAPP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: message },
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`WhatsApp API error (${res.status}): ${JSON.stringify(data.error || data).slice(0, 300)}`);
  }
  return data;
}

module.exports = { isConfigured, sendWhatsApp };
