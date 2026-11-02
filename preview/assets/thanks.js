/* thanks.js — verifies a Stripe Checkout Session before revealing anything.
 * PREVIEW COPY (mock mode enabled in preview/thanks.html).
 * Contract: GET /api/session?session_id=cs_... -> see DELIVERY-WIRING.md
 *
 * The session_id in the URL is NEVER trusted. The browser only learns a
 * download URL if the server confirmed payment_status === 'paid' with Stripe.
 */
(function () {
  'use strict';

  var API = '/api/session';
  var MOCK = window.VAULT_MOCK === true;

  var el = {
    main:    document.getElementById('main'),
    eyebrow: document.getElementById('eyebrow'),
    title:   document.getElementById('title'),
    lede:    document.getElementById('lede'),
    panel:   document.getElementById('panel')
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function setState(state, title, lede, eyebrow) {
    el.main.setAttribute('data-state', state);
    if (eyebrow) el.eyebrow.textContent = eyebrow;
    el.title.textContent = title;
    el.lede.textContent = lede;
  }

  function panel(html) { el.panel.innerHTML = html; }

  function supportLine(extra) {
    return '<p class="thanks__note">' + (extra ? esc(extra) + ' ' : '') +
      'Email <a href="mailto:support@xevolution.biz">support@xevolution.biz</a> ' +
      'with your Stripe receipt and we will send your files by hand.</p>';
  }

  function renderVerifying() {
    setState('verifying', 'Checking your order',
      'One moment while we confirm your payment with Stripe.');
    panel('<p class="thanks__muted"><span class="thanks__spin" aria-hidden="true"></span>Verifying…</p>');
  }

  function renderPaid(d) {
    setState('paid', 'Payment confirmed',
      'Thank you. Your download is ready below, and a copy of this link has been emailed to you.',
      'Order confirmed');

    var html = '<span class="thanks__badge thanks__badge--ok">Paid</span>';

    if (d.product) {
      html += '<p class="thanks__label">Your purchase</p>' +
              '<p class="thanks__muted" style="margin-bottom:1.25rem">' + esc(d.product) + '</p>';
    }

    if (d.download_url) {
      html += '<a class="thanks__btn" href="' + esc(d.download_url) +
              '" rel="noopener">Download your files</a>';
      html += '<p class="thanks__note">' +
              (d.expires_at
                ? 'This link works once and expires on ' +
                  esc(new Date(d.expires_at * 1000).toLocaleString()) + '.'
                : 'This link is single-use.') +
              ' Save the files somewhere safe.</p>';
    } else {
      html += '<p class="thanks__muted">Your link is on its way by email. ' +
              'It usually arrives within a minute.</p>';
    }

    if (d.email) {
      html += '<p class="thanks__note">Sent to <strong>' + esc(d.email) + '</strong>.</p>';
    }

    html += '<p class="thanks__note">Can\'t download it? ' +
            'Email <a href="mailto:support@xevolution.biz">support@xevolution.biz</a> ' +
            'with your receipt and we will send your files by hand.</p>';

    html += '<p class="thanks__order">Order ID <span>' + esc(d.order || '') + '</span></p>';
    panel(html);
  }

  function renderPending() {
    setState('pending', 'Payment still processing',
      'Your bank has not confirmed the payment yet. Nothing else is needed from you.',
      'Order pending');
    panel(
      '<span class="thanks__badge thanks__badge--warn">Processing</span>' +
      '<p class="thanks__muted">Some payment methods take a few minutes, or up to a ' +
      'few business days for bank debits. We email your download link the moment ' +
      'the payment clears.</p>' +
      '<p class="thanks__note"><button class="thanks__btn thanks__btn--ghost" ' +
      'onclick="location.reload()">Check again</button></p>' +
      supportLine()
    );
  }

  function renderDeliveredBefore() {
    setState('delivered', 'This link was already used',
      'Your download link is single-use, so it has already been redeemed.',
      'Order confirmed');
    panel(
      '<span class="thanks__badge thanks__badge--warn">Already redeemed</span>' +
      '<p class="thanks__muted">That is expected if you already downloaded your files. ' +
      'The same link was also emailed to you.</p>' +
      supportLine('Need it again?')
    );
  }

  function renderUnknown() {
    setState('unknown', 'We could not find that order',
      'This page needs the link Stripe sent you when you paid.',
      'Order not found');
    panel(
      '<span class="thanks__badge thanks__badge--bad">Not found</span>' +
      '<p class="thanks__muted">Open the confirmation link from your Stripe receipt ' +
      'email, or just reply to that receipt.</p>' +
      supportLine()
    );
  }

  function renderError(kind) {
    setState('error', 'We could not confirm your payment',
      'Your payment is not in question — only this page failed to load the confirmation.',
      'Connection problem');
    panel(
      '<span class="thanks__badge thanks__badge--bad">Unavailable</span>' +
      '<p class="thanks__muted">' +
        (kind === 'network'
          ? 'This page could not reach our server. Check your connection and try again.'
          : 'Our server could not reach Stripe. Your download link was still emailed to you.') +
      '</p>' +
      '<p class="thanks__note"><button class="thanks__btn thanks__btn--ghost" ' +
      'onclick="location.reload()">Try again</button></p>' +
      supportLine()
    );
  }

  function mockResult(sid) {
    if (!sid) return { status: 400, body: { ok: false, error: 'missing_session' } };
    if (/^cs_mock_paid/.test(sid)) {
      return { status: 200, body: {
        ok: true, status: 'paid', email: 'buyer@example.com',
        product: 'Outbound Agency Vault — Complete Pack',
        order: sid,
        download_url: '/downloads/497-vault.zip?t=MOCKTOKEN',
        expires_at: Math.floor(Date.now() / 1000) + 86400,
        already_delivered: false
      }};
    }
    if (/^cs_mock_pending/.test(sid))   return { status: 200, body: { ok: true, status: 'pending' } };
    if (/^cs_mock_delivered/.test(sid)) return { status: 200, body: { ok: true, status: 'delivered_before' } };
    if (/^cs_mock_500/.test(sid))       return { status: 502, body: { ok: false, error: 'stripe_unreachable' } };
    return { status: 404, body: { ok: false, error: 'unknown_session' } };
  }

  function sessionIdFromUrl() {
    try {
      return new URLSearchParams(window.location.search).get('session_id') || '';
    } catch (e) { return ''; }
  }

  function apply(res) {
    var body = res.body || {};
    if (res.status === 404) return renderUnknown();
    if (res.status === 400) return renderUnknown();
    if (res.status >= 500)  return renderError('server');
    if (!body.ok)           return renderError('server');

    if (body.status === 'paid')             return renderPaid(body);
    if (body.status === 'pending')          return renderPending();
    if (body.status === 'delivered_before') return renderDeliveredBefore();
    return renderUnknown();
  }

  function start() {
    var sid = sessionIdFromUrl();
    renderVerifying();

    if (MOCK) {
      window.setTimeout(function () { apply(mockResult(sid)); }, 120);
      return;
    }

    if (!sid) return renderUnknown();

    fetch(API + '?session_id=' + encodeURIComponent(sid), {
      headers: { 'Accept': 'application/json' },
      credentials: 'omit'
    })
      .then(function (r) {
        return r.json().then(function (body) { return { status: r.status, body: body }; })
                       .catch(function () { return { status: r.status, body: {} }; });
      })
      .then(apply)
      .catch(function () { renderError('network'); });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
