const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../db');
const { sendVerificationEmail, sendPasswordResetEmail } = require('../email');
const { requireAuth } = require('../middleware/auth');
const { deleteMealPhoto } = require('../storage');

const router = express.Router();

router.post('/signup', async (req, res) => {
  const { email, password, sex, age, weight_kg, height_cm, activity_level } = req.body;

  if (!email || !password || !sex || !age || !weight_kg || !height_cm) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const verificationToken = crypto.randomBytes(32).toString('hex');

    const result = await pool.query(
      `INSERT INTO users (email, password_hash, sex, age, weight_kg, height_cm, activity_level,
                           verification_token, verification_token_expires)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now() + interval '24 hours')
       RETURNING id, email`,
      [email, passwordHash, sex, age, weight_kg, height_cm, activity_level || 1.375, verificationToken]
    );

    const user = result.rows[0];
    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });

    sendVerificationEmail(user.email, verificationToken).catch((err) => console.error('Verification email failed:', err));

    res.status(201).json({ token, user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Signup failed' });
  }
});

// GET /auth/verify?token=... — called when the user clicks the link in their email
router.get('/verify', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Missing token' });

  try {
    const result = await pool.query(
      `UPDATE users SET email_verified = true, verification_token = NULL, verification_token_expires = NULL
       WHERE verification_token = $1 AND verification_token_expires > now()
       RETURNING id`,
      [token]
    );
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired verification link' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Verification failed' });
  }
});

// POST /auth/resend-verification — for a signed-in but unverified user
router.post('/resend-verification', async (req, res) => {
  const { email } = req.body;
  try {
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const result = await pool.query(
      `UPDATE users SET verification_token = $1, verification_token_expires = now() + interval '24 hours'
       WHERE email = $2 AND email_verified = false
       RETURNING email`,
      [verificationToken, email]
    );
    if (result.rows.length > 0) {
      await sendVerificationEmail(email, verificationToken);
    }
    // Same response whether or not the account exists/is already verified — don't leak account state
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not resend verification email' });
  }
});

// POST /auth/forgot-password — always responds the same way, whether or not the email exists
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;
  try {
    const resetToken = crypto.randomBytes(32).toString('hex');
    const result = await pool.query(
      `UPDATE users SET reset_token = $1, reset_token_expires = now() + interval '1 hour'
       WHERE email = $2
       RETURNING email`,
      [resetToken, email]
    );
    if (result.rows.length > 0) {
      await sendPasswordResetEmail(email, resetToken);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not process request' });
  }
});

// POST /auth/reset-password — sets a new password given a valid reset token
router.post('/reset-password', async (req, res) => {
  const { token, new_password } = req.body;
  if (!token || !new_password) {
    return res.status(400).json({ error: 'Missing token or new password' });
  }

  try {
    const passwordHash = await bcrypt.hash(new_password, 10);
    const result = await pool.query(
      `UPDATE users SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL
       WHERE reset_token = $2 AND reset_token_expires > now()
       RETURNING id`,
      [passwordHash, token]
    );
    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset link' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Password reset failed' });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Missing email or password' });
  }

  try {
    const result = await pool.query('SELECT id, password_hash FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    res.json({ token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// DELETE /auth/account — permanently deletes the account, its meal logs (via cascade),
// and its stored photos. Requires the current password as confirmation.
router.delete('/account', requireAuth, async (req, res) => {
  const { password } = req.body;
  if (!password) {
    return res.status(400).json({ error: 'Password confirmation required' });
  }

  try {
    const userResult = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.userId]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const valid = await bcrypt.compare(password, userResult.rows[0].password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Incorrect password' });
    }

    const photosResult = await pool.query(
      'SELECT image_url FROM meal_logs WHERE user_id = $1 AND image_url IS NOT NULL',
      [req.userId]
    );
    await Promise.all(photosResult.rows.map((row) => deleteMealPhoto(row.image_url).catch(() => {})));

    // meal_logs rows are removed automatically via ON DELETE CASCADE on the users FK
    await pool.query('DELETE FROM users WHERE id = $1', [req.userId]);

    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Account deletion failed' });
  }
});

module.exports = router;
