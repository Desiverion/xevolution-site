/**
 * worker.js — Xevolution Vault delivery Worker (Cloudflare Workers, ES module).
 * See offers/497-vault/launch/DELIVERY-WIRING.md for the runbook.
 */

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex'
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/* ------------------------------------------------------------------ Stripe */

async function stripeGet(env, path) {
  const res = await fetch('https://api.stripe.com/v1/' + path, {
    method: 'GET',
    headers: {
      authorization: 'Bearer ' + env.STRIPE_SECRET_KEY,
      'stripe-version': '2024-06-20'
    }
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch (e) { body = { raw: text }; }
  return { ok: res.ok, status: res.status, body };
}

/* --------------------------------------------------- webhook signature ---- */

/**
 * Verify a Stripe webhook signature without the SDK.
 * Header: "t=<ts>,v1=<hex hmac>"; signed payload "<ts>.<raw body>";
 * HMAC-SHA256 with the endpoint secret; reject anything older than 5 minutes.
 */
async function verifyStripeSignature(rawBody, sigHeader, secret, toleranceSeconds = 300) {
  if (!sigHeader || !secret) return false;

  let ts = null;
  const v1 = [];
  for (const part of sigHeader.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') ts = v;
    else if (k === 'v1') v1.push(v);
  }
  if (!ts || v1.length === 0) return false;

  const age = Math.floor(Date.now() / 1000) - Number(ts);
  if (!Number.isFinite(age) || Math.abs(age) > toleranceSeconds) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(ts + '.' + rawBody));
  const expected = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, '0')).join('');

  if (expected.length !== 64) return false;
  for (const candidate of v1) {
    if (candidate.length !== expected.length) continue;
    let d = 0;
    for (let i = 0; i < expected.length; i++) {
      d |= expected.charCodeAt(i) ^ candidate.charCodeAt(i);
    }
    if (d === 0) return true;
  }
  return false;
}

/* ------------------------------------------------------------ delivery ---- */

const TTL_DEFAULT = 604800; // 7 days

function ttl(env) {
  const n = Number(env.TOKEN_TTL_SECONDS);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : TTL_DEFAULT;
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function downloadUrl(env, token) {
  return env.FILE_BASE_URL + '/d/' + token;
}

async function readPaidSession(env, sessionId) {
  const r = await stripeGet(env, 'checkout/sessions/' + encodeURIComponent(sessionId));
  if (!r.ok) return { error: 'stripe_error', status: r.status };
  const s = r.body;

  const paid = s.payment_status === 'paid';
  const pending = s.payment_status === 'unpaid' || s.status === 'open';
  const items = (s.line_items && s.line_items.data) || [];
  const product = items.length
    ? items.map((li) => li.description || '').filter(Boolean).join(', ')
    : (s.metadata && s.metadata.product_name) || '';

  return {
    id: s.id,
    paid,
    pending,
    email: (s.customer_details && s.customer_details.email) || s.customer_email || '',
    product,
    amountTotal: s.amount_total,
    currency: s.currency
  };
}

/** Create the delivery record exactly once per Checkout Session. */
async function ensureRecord(env, session) {
  const key = 'session:' + session.id;
  const existing = await env.KV.get(key, 'json');
  if (existing) return { record: existing, created: false };

  const now = Math.floor(Date.now() / 1000);
  const record = {
    session_id: session.id,
    token: randomToken(),
    email: session.email,
    product: session.product,
    amount_total: session.amountTotal,
    currency: session.currency,
    created_at: now,
    expires_at: now + ttl(env),
    email_sent: false,
    downloads: 0
  };

  await env.KV.put(key, JSON.stringify(record), { expirationTtl: ttl(env) });
  await env.KV.put('token:' + record.token, session.id, { expirationTtl: ttl(env) });
  return { record, created: true };
}

async function sendDeliveryEmail(env, record) {
  const link = downloadUrl(env, record.token);
  const html = `
    <div style="font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:16px;line-height:1.6;color:#12141a">
      <h1 style="font-size:22px;margin:0 0 12px">Your Outbound Agency Vault is ready</h1>
      <p style="margin:0 0 16px">Thanks for your order. Your download link is below.</p>
      <p style="margin:0 0 20px">
        <a href="${link}" style="display:inline-block;padding:12px 20px;background:#e4572e;color:#fff;
           text-decoration:none;border-radius:10px;font-weight:600">Download your files</a>
      </p>
      <p style="margin:0 0 16px;color:#4a4f5a;font-size:14px">
        This link is single-use and expires on ${new Date(record.expires_at * 1000).toUTCString()}.
        Save the files somewhere safe.
      </p>
      <p style="margin:0 0 16px;color:#4a4f5a;font-size:14px">
        If the button does not work, paste this into your browser:<br>
        <span style="word-break:break-all">${link}</span>
      </p>
      <p style="margin:24px 0 0;color:#7b818c;font-size:13px">
        Need a hand? Reply to this email or write to support@xevolution.biz
        with your Stripe receipt and we will send the files by hand.
      </p>
    </div>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: 'Bearer ' + env.RESEND_API_KEY,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      from: env.MAIL_FROM,
      to: [record.email],
      reply_to: 'support@xevolution.biz',
      subject: 'Your Outbound Agency Vault download',
      html,
      text: 'Your Outbound Agency Vault is ready.\n\n' + link +
            '\n\nThis link is single-use and expires ' +
            new Date(record.expires_at * 1000).toUTCString() +
            '.\n\nNeed a hand? Write to support@xevolution.biz with your Stripe receipt.'
    })
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { ok: false, status: res.status, detail: detail.slice(0, 500) };
  }
  return { ok: true };
}

/** Safe to call repeatedly and concurrently for the same session. */
async function fulfill(env, sessionId, { sendMail = true } = {}) {
  const session = await readPaidSession(env, sessionId);
  if (session.error) return { ok: false, reason: 'stripe_unreachable' };
  if (!session.paid) return { ok: false, reason: session.pending ? 'pending' : 'not_paid' };

  const { record } = await ensureRecord(env, session);

  if (sendMail && !record.email_sent) {
    if (!record.email) {
      record.email_error = 'no_email_on_session';
    } else {
      const sent = await sendDeliveryEmail(env, record);
      if (sent.ok) {
        record.email_sent = true;
        record.email_sent_at = Math.floor(Date.now() / 1000);
      } else {
        record.email_error = 'resend_' + sent.status;
        record.email_error_detail = sent.detail;
      }
    }
    await env.KV.put('session:' + sessionId, JSON.stringify(record), { expirationTtl: ttl(env) });
  }

  return { ok: true, record, session };
}

/* ------------------------------------------------------------- handlers --- */

async function handleSession(env, url) {
  const sessionId = url.searchParams.get('session_id');
  if (!sessionId) return json({ ok: false, error: 'missing_session' }, 400);
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
    return json({ ok: false, error: 'unknown_session' }, 404);
  }

  const result = await fulfill(env, sessionId, { sendMail: true });

  if (!result.ok) {
    if (result.reason === 'stripe_unreachable') {
      return json({ ok: false, error: 'stripe_unreachable' }, 502);
    }
    if (result.reason === 'pending') return json({ ok: true, status: 'pending' });
    return json({ ok: false, error: 'unknown_session' }, 404);
  }

  const rec = result.record;

  const claimed = await env.KV.get('claim:' + rec.token);
  if (claimed) {
    return json({
      ok: true,
      status: 'delivered_before',
      email: rec.email,
      product: rec.product,
      order: rec.session_id
    });
  }

  return json({
    ok: true,
    status: 'paid',
    email: rec.email,
    product: rec.product,
    order: rec.session_id,
    download_url: downloadUrl(env, rec.token),
    expires_at: rec.expires_at,
    already_delivered: false
  });
}

async function handleDownload(env, token) {
  const sessionId = await env.KV.get('token:' + token);
  if (!sessionId) return html410('This download link has expired or was already used.');

  const claimKey = 'claim:' + token;
  const already = await env.KV.get(claimKey);
  if (already) return html410('This download link has expired or was already used.');
  await env.KV.put(claimKey, '1', { expirationTtl: 60 });

  const record = await env.KV.get('session:' + sessionId, 'json');
  if (record) {
    record.downloads = (record.downloads || 0) + 1;
    record.last_download_at = Math.floor(Date.now() / 1000);
    await env.KV.put('session:' + sessionId, JSON.stringify(record), {
      expirationTtl: Math.max(60, record.expires_at - Math.floor(Date.now() / 1000))
    });
  }

  return Response.redirect(env.FILE_BASE_URL + '/' + env.FILE_PATH, 302);
}

function html410(message) {
  return new Response(
    '<!doctype html><meta charset="utf-8"><title>Link expired</title>' +
    '<body style="font-family:system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1.25rem;color:#12141a">' +
    '<h1 style="font-size:1.6rem">Link expired</h1>' +
    '<p style="color:#4a4f5a">' + message + '</p>' +
    '<p style="color:#4a4f5a">Email <a href="mailto:support@xevolution.biz">support@xevolution.biz</a> ' +
    'with your Stripe receipt and we will send your files by hand.</p></body>',
    { status: 410, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }
  );
}

async function handleWebhook(env, request) {
  const sig = request.headers.get('stripe-signature');
  const raw = await request.text();

  const valid = await verifyStripeSignature(raw, sig, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) return json({ ok: false, error: 'bad_signature' }, 400);

  let event;
  try { event = JSON.parse(raw); } catch (e) {
    return json({ ok: false, error: 'bad_payload' }, 400);
  }

  const type = event.type;
  if (type !== 'checkout.session.completed' && type !== 'checkout.session.async_payment_succeeded') {
    return json({ ok: true, ignored: type });
  }

  const sessionId = event.data && event.data.object && event.data.object.id;
  if (!sessionId) return json({ ok: false, error: 'no_session_id' }, 400);

  const result = await fulfill(env, sessionId, { sendMail: true });

  if (!result.ok) {
    if (result.reason === 'stripe_unreachable') {
      return json({ ok: false, error: 'stripe_unreachable' }, 502);
    }
    return json({ ok: true, status: result.reason });
  }

  return json({ ok: true, status: 'fulfilled', email_sent: !!result.record.email_sent });
}

/* --------------------------------------------------------------- router --- */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/session' && request.method === 'GET') {
      return handleSession(env, url);
    }
    if (path.startsWith('/d/') && request.method === 'GET') {
      return handleDownload(env, path.slice(3));
    }
    if (path === '/webhook') {
      if (request.method !== 'POST') return json({ ok: false, error: 'method' }, 405);
      return handleWebhook(env, request);
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  }
};

export { verifyStripeSignature, fulfill, readPaidSession };
