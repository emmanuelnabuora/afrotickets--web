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
};

function renderNotification(type, payload) {
  const fn = TEMPLATES[type];
  if (fn) return fn(payload || {});
  return { subject: 'AfroTickets update', body: `You have an AfroTickets update: ${type}` };
}

module.exports = { renderNotification };
