// src/utils/emailProvider.js
// Real email delivery via SendGrid's REST API — a plain fetch() call, no SDK
// needed for something this simple. Falls back to nothing (the caller in
// notify.js handles logging) when not configured.
function isConfigured() {
  return !!(process.env.SENDGRID_API_KEY && process.env.SENDGRID_FROM_EMAIL);
}

async function sendEmail({ to, subject, text }) {
  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: process.env.SENDGRID_FROM_EMAIL, name: 'AfroTickets' },
      subject,
      content: [{ type: 'text/plain', value: text }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`SendGrid error (${res.status}): ${body.slice(0, 300)}`);
  }
}

module.exports = { isConfigured, sendEmail };
