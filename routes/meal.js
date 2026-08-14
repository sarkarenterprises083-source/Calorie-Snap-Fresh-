const express = require('express');
const multer = require('multer');
const pool = require('../db');
const { requireAuth } = require('../middleware/auth');
const { uploadMealPhoto, getSignedPhotoUrl } = require('../storage');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

const FREE_DAILY_SCAN_LIMIT = 5;
const BETA_MODE = process.env.BETA_MODE === 'true'; // during beta, everyone gets unlimited scans — no paywall yet

const FOOD_ANALYSIS_PROMPT = `You are a nutrition estimator specialized in Indian home cooking and restaurant food.
Look at the meal photo and identify each distinct food item, estimate its portion in grams, and
estimate calories and macros. Use realistic reference weights for common Indian dishes
(e.g. 1 medium roti ~= 40g ~= 120 kcal, 1 cup cooked rice ~= 150g ~= 200 kcal,
1 katori dal ~= 150g ~= 180 kcal) as anchors, adjusted for what you actually see in the photo.

Respond with ONLY valid JSON, no other text, in this exact shape:
{
  "items": [
    { "name": "string", "grams": number, "kcal": number, "protein_g": number, "carbs_g": number, "fat_g": number }
  ],
  "total_kcal": number,
  "total_protein_g": number,
  "total_carbs_g": number,
  "total_fat_g": number
}`;

// Checks and increments the free-tier daily scan quota. Paid users are unlimited.
// In beta mode, everyone is unlimited — flip BETA_MODE=false later to turn the paywall
// back on without touching any other code.
async function checkAndConsumeScanQuota(userId) {
  if (BETA_MODE) return { allowed: true };

  const { rows } = await pool.query(
    'SELECT plan_tier, plan_expires_at, scans_used_today, scans_reset_at FROM users WHERE id = $1',
    [userId]
  );
  const user = rows[0];
  if (!user) throw new Error('User not found');

  const hasPaidAccess = user.plan_tier === 'paid' && user.plan_expires_at && new Date(user.plan_expires_at) > new Date();
  if (hasPaidAccess) return { allowed: true };

  const today = new Date().toISOString().slice(0, 10);
  const resetAt = user.scans_reset_at.toISOString ? user.scans_reset_at.toISOString().slice(0, 10) : user.scans_reset_at;

  let scansUsed = user.scans_used_today;
  if (resetAt !== today) {
    scansUsed = 0; // new day, quota refreshed
  }

  if (scansUsed >= FREE_DAILY_SCAN_LIMIT) {
    return { allowed: false };
  }

  await pool.query(
    `UPDATE users SET scans_used_today = $1, scans_reset_at = $2 WHERE id = $3`,
    [scansUsed + 1, today, userId]
  );
  return { allowed: true };
}

// POST /meals/scan — send a photo, get back AI-estimated food + macros.
// This does NOT log anything yet; the client shows the result for the user to confirm or edit first.
router.post('/scan', requireAuth, upload.single('photo'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No photo uploaded' });
  }

  try {
    const quota = await checkAndConsumeScanQuota(req.userId);
    if (!quota.allowed) {
      return res.status(429).json({ error: 'Daily free scan limit reached. Upgrade for unlimited scans.' });
    }

    // Upload first so we have a permanent key even if the vision call fails —
    // the user doesn't have to re-upload just because analysis errored out.
    const imageKey = await uploadMealPhoto(req.userId, req.file);

    const base64Image = req.file.buffer.toString('base64');

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                { inline_data: { mime_type: req.file.mimetype, data: base64Image } },
                { text: FOOD_ANALYSIS_PROMPT },
              ],
            },
          ],
          generationConfig: { temperature: 0.4 },
        }),
      }
    );

    const data = await response.json();
    const textBlock = data.candidates?.[0]?.content?.parts?.find((p) => p.text);
    if (!textBlock) {
      console.error('Gemini response missing text:', JSON.stringify(data));
      return res.status(502).json({ error: 'No response from vision model' });
    }

    const cleaned = textBlock.text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    // image_key is what gets stored via POST /meals; image_preview_url is a 5-minute link
    // just for showing the photo on the confirm screen — never persist this URL itself.
    const previewUrl = await getSignedPhotoUrl(imageKey, 300);
    res.json({ analysis: parsed, image_key: imageKey, image_preview_url: previewUrl, raw: data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Photo analysis failed' });
  }
});

// POST /meals — log a meal. Called after the user confirms (or edits) the scan result,
// or for a fully manual entry with no photo at all.
router.post('/', requireAuth, async (req, res) => {
  const {
    image_key,
    ai_food_name, ai_grams, ai_kcal, ai_protein_g, ai_carbs_g, ai_fat_g, ai_raw_response,
    food_name, grams, kcal, protein_g, carbs_g, fat_g,
  } = req.body;

  if (!food_name || kcal === undefined) {
    return res.status(400).json({ error: 'food_name and kcal are required' });
  }

  const wasEdited = ai_kcal !== undefined && Number(ai_kcal) !== Number(kcal);

  try {
    const result = await pool.query(
      `INSERT INTO meal_logs
        (user_id, image_url, ai_food_name, ai_grams, ai_kcal, ai_protein_g, ai_carbs_g, ai_fat_g, ai_raw_response,
         food_name, grams, kcal, protein_g, carbs_g, fat_g, was_edited)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING *`,
      [req.userId, image_key || null, ai_food_name || null, ai_grams || null, ai_kcal || null,
       ai_protein_g || null, ai_carbs_g || null, ai_fat_g || null, ai_raw_response || null,
       food_name, grams || null, kcal, protein_g || null, carbs_g || null, fat_g || null, wasEdited]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to log meal' });
  }
});

// PATCH /meals/:id — correct a meal already logged (e.g. the AI misjudged portion size).
router.patch('/:id', requireAuth, async (req, res) => {
  const { food_name, grams, kcal, protein_g, carbs_g, fat_g } = req.body;

  try {
    const result = await pool.query(
      `UPDATE meal_logs
       SET food_name = COALESCE($1, food_name),
           grams = COALESCE($2, grams),
           kcal = COALESCE($3, kcal),
           protein_g = COALESCE($4, protein_g),
           carbs_g = COALESCE($5, carbs_g),
           fat_g = COALESCE($6, fat_g),
           was_edited = true
       WHERE id = $7 AND user_id = $8
       RETURNING *`,
      [food_name, grams, kcal, protein_g, carbs_g, fat_g, req.params.id, req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Meal log not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update meal' });
  }
});

// GET /meals/today — BMR/TDEE target plus everything logged today.
router.get('/today', requireAuth, async (req, res) => {
  try {
    const userResult = await pool.query(
      'SELECT sex, age, weight_kg, height_cm, activity_level, plan_tier, plan_expires_at, scans_used_today, scans_reset_at, email_verified, email FROM users WHERE id = $1',
      [req.userId]
    );
    const u = userResult.rows[0];
    const bmr = 10 * u.weight_kg + 6.25 * u.height_cm - 5 * u.age + (u.sex === 'm' ? 5 : -161);
    const tdee = Math.round(bmr * u.activity_level);

    const mealsResult = await pool.query(
      `SELECT * FROM meal_logs
       WHERE user_id = $1 AND logged_at::date = CURRENT_DATE
       ORDER BY logged_at ASC`,
      [req.userId]
    );

    const totalKcal = mealsResult.rows.reduce((sum, m) => sum + Number(m.kcal), 0);

    const mealsWithSignedUrls = await Promise.all(
      mealsResult.rows.map(async (m) => ({
        ...m,
        image_url: m.image_url ? await getSignedPhotoUrl(m.image_url, 3600) : null,
      }))
    );

    const hasPaidAccess = u.plan_tier === 'paid' && u.plan_expires_at && new Date(u.plan_expires_at) > new Date();
    const today = new Date().toISOString().slice(0, 10);
    const resetAt = u.scans_reset_at.toISOString ? u.scans_reset_at.toISOString().slice(0, 10) : u.scans_reset_at;
    const scansUsedToday = resetAt === today ? u.scans_used_today : 0;

    res.json({
      bmr: Math.round(bmr),
      tdee,
      logged_kcal: totalKcal,
      remaining_kcal: tdee - totalKcal,
      meals: mealsWithSignedUrls,
      email: u.email,
      email_verified: u.email_verified,
      plan: {
        is_paid: hasPaidAccess,
        is_beta: BETA_MODE,
        expires_at: u.plan_expires_at,
        scans_used_today: scansUsedToday,
        scans_limit: hasPaidAccess ? null : FREE_DAILY_SCAN_LIMIT,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load today\'s summary' });
  }
});

module.exports = router;
