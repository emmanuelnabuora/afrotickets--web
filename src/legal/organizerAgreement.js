// src/legal/organizerAgreement.js
//
// The organizer agreement text served from GET /organizer/agreement and
// gated on by CURRENT_AGREEMENT_VERSION in routes/organizers.js.
//
// STATUS: first draft, NOT reviewed by an attorney. The numeric terms below
// (fees, tax, resale fee, payout reserve rate/hold window) are pulled
// directly from the running code as of v1.26.0 and are accurate as of this
// writing, but several sections still contain bracketed [ALL CAPS]
// placeholders for terms that require a legal/business decision this
// backend can't make on its own (company legal identity, governing law,
// liability caps, refund policy specifics, tax/merchant-of-record position,
// notice mechanism, and a privacy policy reference). Do not treat the
// presence of this file as "the agreement is finalized" — it means the
// version-acceptance mechanism now has real text behind it instead of
// nothing, not that the text is ready for a real organizer to be bound by.
// Replace AGREEMENT_TEXT (and bump AGREEMENT_VERSION) once counsel has
// signed off and the placeholders are filled in with real values.
//
// If any of the numeric defaults below (FEE_RATE, TAX_RATE,
// RESALE_FEE_RATE, payout reserve rate/hold window) change in code, this
// document needs updating to match — nothing keeps them in sync
// automatically.

const AGREEMENT_VERSION = '2026-09-v2';

const AGREEMENT_TEXT = `AFROTICKETS ORGANIZER AGREEMENT
Version: 2026-09-v2 (draft — not yet reviewed by an attorney)
Last updated: [DATE OF ACTUAL ADOPTION]

NOTE: This is a first draft. Sections marked with a bracketed [ALL CAPS]
placeholder are not yet finalized and require legal/business sign-off
before this agreement should be treated as binding.

This Organizer Agreement ("Agreement") is between [COMPANY LEGAL NAME], a
[ENTITY TYPE, e.g. "company incorporated in Kenya"] ("AfroTickets," "we,"
"us"), and the individual or entity that creates an organizer account on
the AfroTickets platform ("Organizer," "you"). By creating events, listing
tickets, or otherwise using AfroTickets' organizer tools, you agree to this
Agreement.

1. ELIGIBILITY AND ACCOUNT REGISTRATION

1.1. You must provide accurate, current information when creating your
organizer account, including your legal name or business name, country,
and settlement details for receiving payouts.

1.2. AfroTickets reviews and approves organizer accounts before they can
publish events. Approval is not a guarantee that any specific event will
be approved, or that your account will not later be suspended under
Section 9.

1.3. You may be asked to submit identity or business-registration
documents to verify your account. You're responsible for the accuracy of
anything you submit, and for keeping your account information current.

1.4. You must be legally able to enter into this Agreement and to organize
the type of event you list (e.g., holding any venue, safety, or
performance licenses your local law requires — AfroTickets does not
verify these on your behalf).

2. EVENT LISTINGS

2.1. You're solely responsible for the accuracy of your event listings —
date, time, venue, pricing, age restrictions, and any other details
attendees rely on.

2.2. You will not list an event that is illegal, fraudulent, infringes on
someone else's rights (including tickets you don't have the right to
sell), or that AfroTickets reasonably determines is harmful, deceptive, or
damaging to the platform's reputation.

2.3. AfroTickets may decline to publish, or may remove, an event listing
at its discretion, including before or after tickets go on sale.

3. TICKET SALES, FEES, AND TAXES

3.1. AfroTickets charges a platform fee of 8% of the ticket subtotal on
primary sales, and collects 2% as tax on top of the subtotal, both added
to the price a buyer pays at checkout. These rates are set by AfroTickets
and may change with notice to you (see Section 12).

3.2. If resale is enabled for your event, resold tickets carry a
face-value price cap and a 10% resale fee, charged to the reseller. You
may disable resale for a specific event; see your event settings.

3.3. You are responsible for any taxes owed on your own proceeds beyond
what AfroTickets collects and remits on your behalf (if any) — AfroTickets
does not provide tax advice, and [WHETHER AFROTICKETS ACTS AS MERCHANT OF
RECORD, COLLECTS VAT ON YOUR BEHALF, ETC. NEEDS COUNSEL/FINANCE INPUT —
THIS VARIES BY JURISDICTION].

4. PAYMENTS AND PAYOUTS

4.1. Buyer payments are processed by AfroTickets' payment providers
(currently M-Pesa and, where configured, other providers). AfroTickets is
not a bank; funds are held and disbursed according to this section.

4.2. Your proceeds (ticket subtotal, less the platform fee, less any
refunds — see Section 5) become payable once your event's scheduled start
time has passed.

4.3. AfroTickets holds back a reserve of 10% of your gross proceeds for 14
days after your event, as a buffer against refunds, disputes, or
chargebacks. The reserve (net of anything paid out through refunds during
the hold) is released to you automatically once the hold period ends.

4.4. Payouts are sent to the settlement account (mobile money or bank
account) you provide and verify in your organizer profile. You're
responsible for the accuracy of this information; AfroTickets is not
liable for a payout sent to a settlement account you provided incorrectly.

4.5. AfroTickets may delay, hold, or freeze payouts to your account if it
reasonably suspects fraud, a high volume of disputes or chargebacks, a
violation of this Agreement, or a legal or regulatory requirement to do
so, pending investigation.

4.6. Where AfroTickets cannot complete an automated payout (e.g., a
payment provider isn't configured for disbursement to your settlement
method), AfroTickets will arrange payment through a manual process and
will notify you.

5. REFUNDS, CANCELLATIONS, AND POSTPONEMENTS

5.1. Buyers may request a refund through AfroTickets. Refund requests are
reviewed and decided by AfroTickets, not automatically approved.
[REFUND ELIGIBILITY POLICY — E.G. WINDOW BEFORE EVENT, WHO BEARS THE COST
OF A DISCRETIONARY REFUND VS. AN EVENT-CAUSED ONE — NEEDS A BUSINESS
DECISION FROM YOU, NOT JUST CODE BEHAVIOR.]

5.2. If you cancel or postpone your event, AfroTickets will notify
affected ticket holders and will open refund eligibility for affected
orders. You are responsible for any proceeds already paid out to you that
need to be returned to buyers as a result of a cancellation, to the extent
AfroTickets cannot recover them from your pending proceeds or reserve.

5.3. AfroTickets may issue a refund to a buyer without your prior approval
where required by a payment provider's dispute/chargeback process,
applicable law, or where AfroTickets reasonably believes the listing was
inaccurate, fraudulent, or in breach of this Agreement.

6. RESALE

6.1. If you allow resale of tickets to your event, resales are subject to
AfroTickets' face-value price cap and resale fee (Section 3.2). You may
disable resale for your event at any time; doing so does not cancel
resale listings already active at the time you disable it.

6.2. AfroTickets is not a party to a resale transaction between a seller
and buyer beyond facilitating it on the platform.

7. YOUR CONTENT AND DATA

7.1. You retain ownership of the content you submit (event descriptions,
images, and similar) but grant AfroTickets a license to display,
reproduce, and distribute it in connection with operating and promoting
the platform.

7.2. AfroTickets processes attendee personal data you can access through
the platform (e.g., ticket holder names for check-in) solely to operate
the platform on your behalf. You agree to use that data only for purposes
related to your event, and not to sell it, share it beyond what's needed
to run your event, or retain it longer than necessary.
[THIS SECTION NEEDS TO REFERENCE YOUR ACTUAL PRIVACY POLICY/DATA
PROCESSING TERMS ONCE THOSE EXIST.]

8. PROHIBITED CONDUCT

You will not, in connection with the platform: (a) list fraudulent,
counterfeit, or unauthorized tickets or events; (b) attempt to manipulate
fees, pricing, or the resale cap; (c) circumvent AfroTickets' payment flow
to collect payment for a listed event outside the platform; (d) submit
false or forged identity/business documents; (e) use the platform to
violate any applicable law; or (f) interfere with the platform's security
or normal operation (including automated abuse of any endpoint).

9. SUSPENSION AND TERMINATION

9.1. AfroTickets may suspend your account — pausing your ability to
create or edit events, generate seating, or change event images — if it
reasonably believes you've violated this Agreement, are under
investigation for fraud or a dispute pattern, or for any other reason at
AfroTickets' discretion, with or without prior notice. Suspension does
not cancel your existing published events or affect your ability to
cancel/postpone them, and does not by itself freeze payouts (see Section
4.5 for that).

9.2. AfroTickets may terminate your account for a serious or repeated
violation of this Agreement, illegal conduct, or fraud. You may close
your account at any time, subject to completing any obligations to buyers
of tickets already sold (refund handling, the event itself, etc.).

9.3. Sections that by their nature should survive termination (including
Section 4 as to funds already owed, and Sections 10, 11, 12.3, and 13)
survive termination of this Agreement.

10. DISCLAIMERS

AfroTickets provides the platform "as is." AfroTickets is a ticketing and
payment-facilitation platform — it does not organize, endorse, or
guarantee the occurrence, quality, or safety of your event.
[STANDARD WARRANTY DISCLAIMER LANGUAGE TO BE FINALIZED BY COUNSEL FOR YOUR
JURISDICTION(S) — SOME CONSUMER-PROTECTION REGIMES LIMIT WHAT CAN BE
DISCLAIMED.]

11. LIMITATION OF LIABILITY AND INDEMNIFICATION

11.1. [LIABILITY CAP LANGUAGE — TYPICALLY CAPPED AT FEES PAID TO
AFROTICKETS OVER SOME PERIOD, OR A FIXED AMOUNT — NEEDS COUNSEL INPUT.]

11.2. You agree to indemnify AfroTickets against claims arising from your
event, your listing's accuracy, your violation of this Agreement, or your
violation of law — [SCOPE/CARVE-OUTS NEED COUNSEL REVIEW].

12. CHANGES TO THIS AGREEMENT

12.1. AfroTickets may update this Agreement from time to time. When it
does, the platform will require you to review and accept the updated
version — identified by its version label — before you can continue
creating or editing events, generating seating, or changing event images.
Your prior acceptance of an earlier version does not carry over.

12.2. Material changes will be communicated to you [VIA EMAIL / IN-APP
NOTICE — CONFIRM YOUR ACTUAL NOTICE MECHANISM] with reasonable advance
notice where practicable.

12.3. This Section, and the version-acceptance mechanism it describes, is
implemented in the platform's code as the CURRENT_AGREEMENT_VERSION
constant (currently "2026-09-v2").

13. GOVERNING LAW AND DISPUTES

[GOVERNING LAW AND DISPUTE-RESOLUTION MECHANISM (COURTS VS. ARBITRATION,
VENUE, LANGUAGE) NEEDS TO BE SET BY COUNSEL BASED ON WHERE THE COMPANY IS
INCORPORATED AND WHERE ITS ORGANIZERS ARE LOCATED.]

14. MISCELLANEOUS

14.1. This Agreement is the entire agreement between you and AfroTickets
regarding your use of organizer tools, and supersedes prior agreements on
the same subject.

14.2. If any provision of this Agreement is found unenforceable, the rest
remains in effect.

14.3. You may not assign this Agreement without AfroTickets' consent;
AfroTickets may assign it in connection with a merger, acquisition, or
sale of assets.

14.4. Notices to AfroTickets should be sent to [NOTICE EMAIL/ADDRESS].`;

module.exports = { AGREEMENT_VERSION, AGREEMENT_TEXT };
