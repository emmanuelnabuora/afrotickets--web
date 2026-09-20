// src/utils/notificationTemplates.js
// Turns a notification type + payload into an actual subject/body a human
// would read — used for real email/SMS/WhatsApp delivery. Kept deliberately
// generic about amounts (payloads don't always carry currency), favoring
// accuracy over cosmetic detail.
const TEMPLATES = {
  'order.paid': (p) => ({
    subject: 'Your AfroTickets order is confirmed',
    body: `Your AfroTickets order #${p.orderId} is confirmed! Your ticket is ready — open the app to view your QR code.`,
  }),
  'payment.failed': (p) => ({
    subject: 'AfroTickets payment failed',
    body: `Your AfroTickets payment for order #${p.orderId} did not go through. Please try again.`,
  }),
  'ticket.received': () => ({
    subject: "You've received an AfroTickets ticket",
    body: 'Someone transferred you an AfroTickets ticket — check My Tickets in the app.',
  }),
  'ticket.transferred': (p) => ({
    subject: 'AfroTickets ticket transferred',
    body: `Your AfroTickets ticket was sent to ${p.toEmail || 'another account'}.`,
  }),
  'ticket.invalidated': (p) => ({
    subject: 'An AfroTickets ticket was invalidated',
    body: `One of your AfroTickets tickets was invalidated${p.reason ? `: ${p.reason}` : '.'}`,
  }),
  'resale.ticket_ready': () => ({
    subject: 'Your AfroTickets resale purchase is ready',
    body: 'Your resale ticket purchase is confirmed — check My Tickets in the app.',
  }),
  'resale.payout_pending': () => ({
    subject: 'AfroTickets resale sale complete',
    body: 'Your resale listing sold — payout is pending and will be released shortly.',
  }),
  'resale.payment_failed': () => ({
    subject: 'AfroTickets resale payment failed',
    body: 'A resale purchase payment did not go through.',
  }),
  'organizer.approved': () => ({
    subject: "You're verified on AfroTickets",
    body: 'Congratulations — your AfroTickets organizer account has been approved. You can now publish events.',
  }),
  'organizer.rejected': (p) => ({
    subject: 'AfroTickets organizer application update',
    body: `Your AfroTickets organizer application was not approved${p.reason ? `: ${p.reason}` : '.'}`,
  }),
  'organizer.suspended': (p) => ({
    subject: 'Your AfroTickets organizer account has been suspended',
    body: `Your AfroTickets organizer account has been suspended${p.reason ? `: ${p.reason}` : '.'} Your existing events remain live, but you can't create or edit events until this is resolved. Contact support for details.`,
  }),
  'organizer.reactivated': () => ({
    subject: 'Your AfroTickets organizer account has been reactivated',
    body: 'Your AfroTickets organizer account is no longer suspended — you can create and edit events again.',
  }),
  'event.published': () => ({
    subject: 'Your AfroTickets event is live',
    body: 'Your event has been approved and is now published on AfroTickets.',
  }),
  'event.rejected': (p) => ({
    subject: 'AfroTickets event review update',
    body: `Your event submission was not approved${p.reason ? `: ${p.reason}` : '.'}`,
  }),
  'refund.requested': (p) => ({
    subject: 'AfroTickets refund request received',
    body: `We've received your refund request for order #${p.orderId}. Our team will review it shortly.`,
  }),
  'refund.approved': (p) => ({
    subject: 'AfroTickets refund processed',
    body: `Your refund of ${p.amountFormatted || ''} for order #${p.orderId} has been processed${p.fullRefund ? ' and the ticket(s) on this order are no longer valid' : ''}.`,
  }),
  'refund.rejected': (p) => ({
    subject: 'AfroTickets refund request update',
    body: `Your refund request for order #${p.orderId} was not approved${p.reason ? `: ${p.reason}` : '.'}`,
  }),
  'refund.failed': (p) => ({
    subject: 'AfroTickets refund could not be completed',
    body: `We approved your refund for order #${p.orderId}, but the payment provider declined it. Our team has been notified and will follow up.`,
  }),
  'refund.manual_required': (p) => ({
    subject: 'AfroTickets refund is being processed manually',
    body: `Your refund for order #${p.orderId} was approved and is being processed manually by our team since it was paid via M-Pesa — you'll be notified once it completes.`,
  }),
  'auth.email_verification': (p) => ({
    subject: 'Verify your AfroTickets email',
    body: `Welcome to AfroTickets! Verify your email with this code: ${p.token}${p.verifyUrl ? `\nOr open: ${p.verifyUrl}` : ''}\nThis code expires in 24 hours.`,
  }),
  'auth.phone_verification': (p) => ({
    subject: 'Your AfroTickets verification code',
    body: `Your AfroTickets verification code is ${p.code}. It expires in 10 minutes.`,
  }),
  'auth.password_reset': (p) => ({
    subject: 'Reset your AfroTickets password',
    body: `Use this code to reset your AfroTickets password: ${p.token}${p.resetUrl ? `\nOr open: ${p.resetUrl}` : ''}\nThis code expires in 1 hour. If you didn't request this, you can safely ignore this message.`,
  }),
  'auth.password_changed': () => ({
    subject: 'Your AfroTickets password was changed',
    body: "Your AfroTickets password was just changed. If this wasn't you, contact support immediately — all other sessions have been signed out.",
  }),
  'auth.mfa_enabled': () => ({
    subject: 'Two-factor authentication enabled',
    body: 'Two-factor authentication was just enabled on your AfroTickets account. Keep your backup codes somewhere safe — each one only works once.',
  }),
  'event.cancelled': (p) => ({
    subject: 'An AfroTickets event was cancelled',
    body: `"${p.eventName}" has been cancelled${p.reason ? `: ${p.reason}` : '.'} ${p.refundInitiated ? 'A refund has been requested on your behalf and is pending review.' : ''}`.trim(),
  }),
  'event.postponed': (p) => ({
    subject: 'An AfroTickets event was rescheduled',
    body: `"${p.eventName}" has been rescheduled from ${p.oldStartsAt} to ${p.newStartsAt}${p.reason ? `: ${p.reason}` : '.'} Your ticket is still valid for the new date.`,
  }),
  'auth.mfa_disabled': () => ({
    subject: 'Two-factor authentication disabled',
    body: "Two-factor authentication was just turned off on your AfroTickets account. If this wasn't you, contact support immediately.",
  }),
};

function renderNotification(type, payload) {
  const fn = TEMPLATES[type];
  if (fn) return fn(payload || {});
  return { subject: 'AfroTickets update', body: `You have an AfroTickets update: ${type}` };
}

module.exports = { renderNotification };
