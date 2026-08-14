-- Photo-to-Calorie/BMR Tracker — schema

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  sex TEXT CHECK (sex IN ('m', 'f')) NOT NULL,
  age INT NOT NULL,
  weight_kg NUMERIC NOT NULL,
  height_cm NUMERIC NOT NULL,
  activity_level NUMERIC NOT NULL DEFAULT 1.375, -- multiplier, e.g. 1.2 / 1.375 / 1.55 / 1.725
  plan_tier TEXT NOT NULL DEFAULT 'free', -- free | paid
  plan_expires_at TIMESTAMPTZ, -- null for free tier; paid access is valid until this timestamp
  scans_used_today INT NOT NULL DEFAULT 0,
  scans_reset_at DATE NOT NULL DEFAULT CURRENT_DATE,
  email_verified BOOLEAN NOT NULL DEFAULT false,
  verification_token TEXT,
  verification_token_expires TIMESTAMPTZ,
  reset_token TEXT,
  reset_token_expires TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE meal_logs (
  id SERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  image_url TEXT, -- storage KEY (not a public URL) — bucket is private; use getSignedPhotoUrl() to view

  -- what the AI returned, kept as-is for audit + future model training
  ai_food_name TEXT,
  ai_grams NUMERIC,
  ai_kcal NUMERIC,
  ai_protein_g NUMERIC,
  ai_carbs_g NUMERIC,
  ai_fat_g NUMERIC,
  ai_raw_response JSONB, -- full model response, useful for debugging/retraining

  -- what's actually counted toward the user's daily total —
  -- starts equal to the ai_* values, overwritten if the user corrects it
  food_name TEXT NOT NULL,
  grams NUMERIC,
  kcal NUMERIC NOT NULL,
  protein_g NUMERIC,
  carbs_g NUMERIC,
  fat_g NUMERIC,

  was_edited BOOLEAN NOT NULL DEFAULT false, -- true once a user corrects an AI read
  logged_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_meal_logs_user_date ON meal_logs (user_id, logged_at);

CREATE TABLE feedback (
  id SERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id) ON DELETE SET NULL, -- kept even if the user later deletes their account
  message TEXT NOT NULL,
  rating INT CHECK (rating BETWEEN 1 AND 5), -- optional
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
