// src/utils/smsProvider.js
// Real SMS delivery via Africa's Talking — the standard SMS gateway across
// Kenya, Nigeria, Ghana, Uganda, Rwanda, Tanzania, and most of AfroTickets'
// target markets. A plain fetch() call against their REST API.
function baseUrl() {
  // The sandbox environment uses a different host than production, keyed
  // off Africa's Talking' convention of using "sandbox" as the username.
  return process.env.AT_USERNAME === 'sandbox'
    ? 'https://api.sandbox.africastalking.com'
    : 'https://api.africastalking.com';
}

function isConfigured() {
  return !!(process.env.AT_API_KEY && process.env.AT_USERNAME);
}

async function sendSMS({ to, message }) {
  const res = await fetch(`${baseUrl()}/version1/messaging`, {
    method: 'POST',
    headers: {
      apiKey: process.env.AT_API_KEY,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({ username: process.env.AT_USERNAME, to, message }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Africa's Talking error (${res.status}): ${JSON.stringify(data).slice(0, 300)}`);
  }
  const recipient = data.SMSMessageData?.Recipients?.[0];
  if (recipient && recipient.status !== 'Success') {
    throw new Error(`Africa's Talking rejected the message: ${recipient.status}`);
  }
  return data;
}

module.exports = { isConfigured, sendSMS };
