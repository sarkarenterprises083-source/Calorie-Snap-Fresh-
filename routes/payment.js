const express = require('express');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Single monthly plan for now — simplest thing that works. Swap for Razorpay Subscriptions
// later if you want auto-renewal instead of "pay again when it expires."
const MONTHLY_PRICE_PAISE = Number(process.env.MONTHLY_PRICE_PAISE || 14900); // ₹149.00

// POST /payments/create-order — starts a checkout for one month of paid access.
router.post('/create-order', requireAuth, async (req, res) => {
  try {
    const order = await razorpay.orders.create({
      amount: MONTHLY_PRICE_PAISE,
      currency: 'INR',
      receipt: `user_${req.userId}_${Date.now()}`,
    });
    res.json({ order_id: order.id, amount: order.amount, currency: order.currency, key_id: process.env.RAZORPAY_KEY_ID });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not start payment' });
  }
});

// POST /payments/verify — called by the frontend after Razorpay's checkout succeeds.
// Verifies the signature server-side (never trust the client's word alone), then grants
// or extends 30 days of paid access.
router.post('/verify', requireAuth, async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing payment details' });
  }

  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');

  if (expectedSignature !== razorpay_signature) {
    return res.status(400).json({ error: 'Payment signature could not be verified' });
  }

  try {
    // Extend from current expiry if still active (renewing before lapse), else from now.
    const result = await pool.query(
      `UPDATE users
       SET plan_tier = 'paid',
           plan_expires_at = GREATEST(COALESCE(plan_expires_at, now()), now()) + interval '30 days'
       WHERE id = $1
       RETURNING plan_expires_at`,
      [req.userId]
    );
    res.json({ ok: true, plan_expires_at: result.rows[0].plan_expires_at });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not update plan' });
  }
});

module.exports = router;
