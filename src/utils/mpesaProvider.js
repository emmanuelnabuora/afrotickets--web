// src/utils/mpesaProvider.js
// Real Safaricom Daraja integration (STK Push / Lipa Na M-Pesa Online) — not
// a mock. Requires MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_SHORTCODE,
// MPESA_PASSKEY, MPESA_CALLBACK_URL, and MPESA_CALLBACK_SECRET to be set;
// isConfigured() gates whether checkout uses this or falls back to the mock
// provider, so the app is honest about which path a given deployment is on
// rather than silently pretending a real payment happened.
const crypto = require('crypto');

function baseUrl() {
  return process.env.MPESA_ENV === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';
}

function isConfigured() {
  return !!(
    process.env.MPESA_CONSUMER_KEY &&
    process.env.MPESA_CONSUMER_SECRET &&
    process.env.MPESA_SHORTCODE &&
    process.env.MPESA_PASSKEY &&
    process.env.MPESA_CALLBACK_URL &&
    process.env.MPESA_CALLBACK_SECRET
  );
}

// OAuth tokens are valid ~1 hour; cache in-process and refetch a little
// before expiry rather than requesting a fresh one on every checkout.
let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt) return cachedToken;

  const credentials = Buffer.from(
    `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
  ).toString('base64');

  const res = await fetch(`${baseUrl()}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${credentials}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Daraja OAuth failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  cachedToken = data.access_token;
  // expires_in is in seconds (typically 3599); refresh 60s early to be safe.
  cachedTokenExpiresAt = Date.now() + (Number(data.expires_in || 3500) - 60) * 1000;
  return cachedToken;
}

// Accepts 07XXXXXXXX, 7XXXXXXXX, +2547XXXXXXXX, or 2547XXXXXXXX and
// normalizes to the 2547XXXXXXXX / 2541XXXXXXXX form Daraja requires.
function normalizePhone(phone) {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('254') && digits.length === 12) return digits;
  if (digits.startsWith('0') && digits.length === 10) return '254' + digits.slice(1);
  if ((digits.startsWith('7') || digits.startsWith('1')) && digits.length === 9) return '254' + digits;
  throw new Error(`"${phone}" doesn't look like a valid Kenyan phone number`);
}

function timestampNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

// Initiates an STK Push: Safaricom sends a payment prompt to the customer's
// phone. This call returning successfully means the prompt was *sent* — it
// says nothing about whether the customer approved it. That result arrives
// later, asynchronously, via the callback Safaricom posts to MPESA_CALLBACK_URL.
async function initiateSTKPush({ phone, amountCents, accountReference, transactionDesc }) {
  const normalizedPhone = normalizePhone(phone);
  const shortcode = process.env.MPESA_SHORTCODE;
  const timestamp = timestampNow();
  const password = Buffer.from(`${shortcode}${process.env.MPESA_PASSKEY}${timestamp}`).toString('base64');
  const amount = Math.max(1, Math.round(amountCents / 100)); // Daraja wants whole KES, minimum 1

  const token = await getAccessToken();
  const callbackUrl = `${process.env.MPESA_CALLBACK_URL.replace(/\/$/, '')}/${process.env.MPESA_CALLBACK_SECRET}`;

  const res = await fetch(`${baseUrl()}/mpesa/stkpush/v1/processrequest`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: amount,
      PartyA: normalizedPhone,
      PartyB: shortcode,
      PhoneNumber: normalizedPhone,
      CallBackURL: callbackUrl,
      AccountReference: String(accountReference).slice(0, 12),
      TransactionDesc: String(transactionDesc).slice(0, 13),
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ResponseCode !== '0') {
    throw new Error(data.errorMessage || data.ResponseDescription || `STK push failed (${res.status})`);
  }

  return {
    merchantRequestId: data.MerchantRequestID,
    checkoutRequestId: data.CheckoutRequestID,
    customerMessage: data.CustomerMessage,
  };
}

// Parses Safaricom's actual documented callback shape into a flat object.
// ResultCode 0 = customer approved and paid; anything else = declined,
// cancelled, timed out, or insufficient funds — all treated as "failed"
// here, with the human-readable reason preserved in resultDesc.
function parseCallback(body) {
  const callback = body?.Body?.stkCallback;
  if (!callback) throw new Error('Not a recognizable Daraja STK callback payload');

  const result = {
    merchantRequestId: callback.MerchantRequestID,
    checkoutRequestId: callback.CheckoutRequestID,
    resultCode: callback.ResultCode,
    resultDesc: callback.ResultDesc,
    success: callback.ResultCode === 0,
  };

  if (result.success && callback.CallbackMetadata?.Item) {
    const items = {};
    callback.CallbackMetadata.Item.forEach((i) => { items[i.Name] = i.Value; });
    result.amount = items.Amount;
    result.mpesaReceiptNumber = items.MpesaReceiptNumber;
    result.transactionDate = items.TransactionDate;
    result.phoneNumber = items.PhoneNumber;
  }

  return result;
}

function verifyCallbackSecret(pathSecret) {
  const expected = process.env.MPESA_CALLBACK_SECRET || '';
  if (!expected) return false;
  const a = Buffer.from(String(pathSecret || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { isConfigured, initiateSTKPush, parseCallback, verifyCallbackSecret, normalizePhone };
