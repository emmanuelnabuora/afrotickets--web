// src/utils/mpesaProvider.js
// Real Safaricom Daraja integration (STK Push / Lipa Na M-Pesa Online) — not
// a mock. Requires MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_SHORTCODE,
// MPESA_PASSKEY, MPESA_CALLBACK_URL, and MPESA_CALLBACK_SECRET to be set;
// isConfigured() gates whether checkout uses this or falls back to the mock
// provider, so the app is honest about which path a given deployment is on
// rather than silently pretending a real payment happened.
const crypto = require('crypto');
const fs = require('fs');

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

// ===================== B2C (organizer payouts) =====================
// Separate from STK Push credentials on purpose — Daraja's B2C ("send money
// out") API is a distinct product from Lipa Na M-Pesa Online ("receive
// money"), with its own initiator identity, RSA-encrypted security
// credential, and shortcode. Most deployments configure STK Push (to accept
// payments) long before they ever configure B2C (to pay organizers out),
// so this is intentionally gated separately — payouts are honest about
// falling back to manual processing when only STK credentials exist.
function isB2CConfigured() {
  return !!(
    process.env.MPESA_INITIATOR_NAME &&
    process.env.MPESA_INITIATOR_PASSWORD &&
    process.env.MPESA_B2C_SHORTCODE &&
    process.env.MPESA_B2C_CERT_PATH &&
    process.env.MPESA_B2C_RESULT_URL &&
    process.env.MPESA_B2C_TIMEOUT_URL
  );
}

// Daraja requires the initiator password encrypted with Safaricom's public
// certificate (a different cert for sandbox vs. production, downloaded from
// the Daraja portal) — this is not a secret this app invents, it's the
// documented mechanism, hence reading an actual cert file from disk rather
// than deriving anything in code.
function buildSecurityCredential() {
  const cert = fs.readFileSync(process.env.MPESA_B2C_CERT_PATH, 'utf8');
  const encrypted = crypto.publicEncrypt(
    { key: cert, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(process.env.MPESA_INITIATOR_PASSWORD)
  );
  return encrypted.toString('base64');
}

// Initiates a B2C ("BusinessPayment") transfer to an organizer's M-Pesa
// number. Like STK Push, this only confirms Safaricom *accepted* the
// request — the actual outcome (moved / failed) arrives later via the
// ResultURL callback, parsed below by parseB2CResult.
async function initiateB2CPayout({ phone, amountCents, remarks, occasion }) {
  const normalizedPhone = normalizePhone(phone);
  const token = await getAccessToken();
  const amount = Math.max(1, Math.round(amountCents / 100));

  const res = await fetch(`${baseUrl()}/mpesa/b2c/v1/paymentrequest`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      InitiatorName: process.env.MPESA_INITIATOR_NAME,
      SecurityCredential: buildSecurityCredential(),
      CommandID: 'BusinessPayment',
      Amount: amount,
      PartyA: process.env.MPESA_B2C_SHORTCODE,
      PartyB: normalizedPhone,
      Remarks: String(remarks || 'AfroTickets payout').slice(0, 100),
      QueueTimeOutURL: process.env.MPESA_B2C_TIMEOUT_URL,
      ResultURL: process.env.MPESA_B2C_RESULT_URL,
      Occasion: String(occasion || '').slice(0, 100),
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ResponseCode !== '0') {
    throw new Error(data.errorMessage || data.ResponseDescription || `B2C payout request failed (${res.status})`);
  }
  return {
    conversationId: data.ConversationID,
    originatorConversationId: data.OriginatorConversationID,
  };
}

// Parses Safaricom's documented B2C result-callback shape. ResultCode 0
// means the transfer completed; anything else is a failure (insufficient
// utility balance, invalid recipient, etc.), with the reason in resultDesc.
function parseB2CResult(body) {
  const result = body?.Result;
  if (!result) throw new Error('Not a recognizable Daraja B2C result payload');

  const params = {};
  (result.ResultParameters?.ResultParameter || []).forEach((p) => { params[p.Key] = p.Value; });

  return {
    conversationId: result.ConversationID,
    originatorConversationId: result.OriginatorConversationID,
    transactionId: result.TransactionID || null,
    resultCode: result.ResultCode,
    resultDesc: result.ResultDesc,
    success: result.ResultCode === 0,
    transactionAmount: params.TransactionAmount,
    receiverPartyPublicName: params.ReceiverPartyPublicName,
  };
}

module.exports = {
  isConfigured,
  initiateSTKPush,
  parseCallback,
  verifyCallbackSecret,
  normalizePhone,
  isB2CConfigured,
  initiateB2CPayout,
  parseB2CResult,
};
