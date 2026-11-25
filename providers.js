'use strict';
/*
 * Connecteurs externes de VuPay : envoi des SMS et paiement des retraits Mobile Money.
 * Choisis-les dans le fichier .env (SMS_PROVIDER et PAYOUT_PROVIDER).
 *
 * Les modes "http" sont des modèles génériques : chaque fournisseur (CinetPay, PayDunya,
 * Wave Business, Orange SMS API, etc.) a son propre format. Adapte buildSmsRequest()
 * et buildPayoutRequest() en suivant la documentation de ton fournisseur.
 */

// ---------- SMS ----------
function buildSmsRequest(to, message) {
  return {
    url: process.env.SMS_API_URL,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (process.env.SMS_API_KEY || '') },
    body: { to, message, sender: process.env.SMS_SENDER || 'VuPay' }
  };
}

async function sendSms(to, message) {
  const mode = process.env.SMS_PROVIDER || 'console';
  if (mode === 'console') {
    console.log(`[SMS -> ${to}] ${message}`);
    return;
  }
  if (mode === 'http') {
    const r = buildSmsRequest(to, message);
    if (!r.url) throw new Error('SMS_API_URL manquant dans .env');
    const res = await fetch(r.url, { method: 'POST', headers: r.headers, body: JSON.stringify(r.body) });
    if (!res.ok) throw new Error('Envoi SMS refusé (' + res.status + ')');
    return;
  }
  throw new Error('SMS_PROVIDER inconnu : ' + mode);
}

// ---------- Retraits Mobile Money ----------
/*
 * payout(tx, setStatus)
 *   tx        : { ref, amount, currency, operator, phone }   (phone au format international, ex. +221771234567)
 *   setStatus : fonction(statut) avec statut = 'En traitement' | 'Envoyé' | 'Échoué'
 *
 * Modes :
 *   simulation : passe tout seul à "Envoyé" après quelques secondes (pour tester, AUCUN argent envoyé)
 *   manual     : reste "En attente" ; tu paies toi-même puis tu valides dans /admin.html
 *   http       : appelle l'API de ton agrégateur ; le statut final arrive par le webhook
 *                POST /api/webhooks/payout  { reference, status: "success" | "failed" }
 *                avec l'en-tête  X-Webhook-Secret: <PAYOUT_WEBHOOK_SECRET>
 */
function buildPayoutRequest(tx) {
  return {
    url: process.env.PAYOUT_API_URL,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (process.env.PAYOUT_API_KEY || '') },
    body: {
      reference: tx.ref,
      amount: tx.amount,
      currency: tx.currency,
      operator: tx.operator,
      phone: tx.phone,
      notify_url: (process.env.PUBLIC_URL || '') + '/api/webhooks/payout'
    }
  };
}

async function payout(tx, setStatus) {
  const mode = process.env.PAYOUT_PROVIDER || 'simulation';
  if (mode === 'simulation') {
    setTimeout(() => setStatus('En traitement'), 2500);
    setTimeout(() => setStatus('Envoyé'), 7000);
    return;
  }
  if (mode === 'manual') return;
  if (mode === 'http') {
    const r = buildPayoutRequest(tx);
    if (!r.url) throw new Error('PAYOUT_API_URL manquant dans .env');
    const res = await fetch(r.url, { method: 'POST', headers: r.headers, body: JSON.stringify(r.body) });
    if (!res.ok) throw new Error('Retrait refusé par le fournisseur (' + res.status + ')');
    setStatus('En traitement');
    return;
  }
  throw new Error('PAYOUT_PROVIDER inconnu : ' + mode);
}

module.exports = { sendSms, payout };
