const express = require('express');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// POST /feedback — logged-in users only, so feedback can be tied back to an account if useful,
// but the FK is ON DELETE SET NULL so feedback survives even after account deletion.
router.post('/', requireAuth, async (req, res) => {
  const { message, rating } = req.body;

  if (!message || !message.trim()) {
    return res.status(400).json({ error: 'Feedback message is required' });
  }
  if (rating !== undefined && rating !== null && (rating < 1 || rating > 5)) {
    return res.status(400).json({ error: 'Rating must be between 1 and 5' });
  }

  try {
    await pool.query(
      'INSERT INTO feedback (user_id, message, rating) VALUES ($1, $2, $3)',
      [req.userId, message.trim(), rating || null]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not submit feedback' });
  }
});

// GET /feedback/summary — public, no auth. Average rating + count, for display on the landing page.
router.get('/summary', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ROUND(AVG(rating)::numeric, 1) AS average_rating, COUNT(rating) AS rating_count
       FROM feedback WHERE rating IS NOT NULL`
    );
    const row = result.rows[0];
    res.json({
      average_rating: row.average_rating ? Number(row.average_rating) : null,
      rating_count: Number(row.rating_count),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load rating summary' });
  }
});

module.exports = router;
