const express = require('express');
const pool = require('../db');

const router = express.Router();

// Simple shared-secret check — fine for a solo founder checking in on a beta.
// Not a real admin auth system; don't build more on top of this without upgrading it.
function requireAdminKey(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!key || key !== process.env.ADMIN_SECRET_KEY) {
    return res.status(401).json({ error: 'Invalid admin key' });
  }
  next();
}

// GET /admin/stats — signups, activity, and recent feedback so you can see how
// people are actually using the app and what they're saying about it.
router.get('/stats', requireAdminKey, async (req, res) => {
  try {
    const [users, activeUsers, meals, mealsWeek, feedbackSummary, recentFeedback] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE created_at > now() - interval '7 days') AS last_7_days FROM users`),
      pool.query(`SELECT COUNT(DISTINCT user_id) AS count FROM meal_logs WHERE logged_at > now() - interval '7 days'`),
      pool.query(`SELECT COUNT(*) AS total FROM meal_logs`),
      pool.query(`SELECT COUNT(*) AS total FROM meal_logs WHERE logged_at > now() - interval '7 days'`),
      pool.query(`SELECT ROUND(AVG(rating)::numeric, 1) AS average_rating, COUNT(rating) AS rating_count FROM feedback WHERE rating IS NOT NULL`),
      pool.query(`SELECT message, rating, created_at FROM feedback ORDER BY created_at DESC LIMIT 20`),
    ]);

    res.json({
      users: { total: Number(users.rows[0].total), last_7_days: Number(users.rows[0].last_7_days) },
      active_users_last_7_days: Number(activeUsers.rows[0].count),
      meals_logged: { total: Number(meals.rows[0].total), last_7_days: Number(mealsWeek.rows[0].total) },
      feedback: {
        average_rating: feedbackSummary.rows[0].average_rating ? Number(feedbackSummary.rows[0].average_rating) : null,
        rating_count: Number(feedbackSummary.rows[0].rating_count),
        recent: recentFeedback.rows,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Could not load stats' });
  }
});

module.exports = router;
