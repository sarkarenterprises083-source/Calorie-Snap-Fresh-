require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const mealRoutes = require('./routes/meals');
const paymentRoutes = require('./routes/payments');
const feedbackRoutes = require('./routes/feedback');
const adminRoutes = require('./routes/admin');

const app = express();
app.use(helmet());
// In production, set FRONTEND_URL to your deployed frontend's origin so only it can call this API.
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

// Brute-force protection on auth endpoints — 20 attempts per 15 min per IP.
// (Loose enough for a real user fumbling a password; tight enough to stop scripted guessing.)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});
app.use('/auth', authLimiter, authRoutes);
app.use('/meals', mealRoutes);
app.use('/payments', paymentRoutes);
app.use('/feedback', feedbackRoutes);
app.use('/admin', adminRoutes);

app.get('/health', (req, res) => res.json({ ok: true }));

// Only start a long-running server when run directly (local dev / Railway-style hosting).
// On Vercel, api/index.js imports `app` and Vercel's runtime handles invocation instead.
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
