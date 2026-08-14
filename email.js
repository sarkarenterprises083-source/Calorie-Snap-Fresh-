const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false, // true for port 465, false for 587/25
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

async function sendEmail(to, subject, html) {
  await transporter.sendMail({
    from: process.env.EMAIL_FROM || '"Calorie Snap AI" <no-reply@caloriesnapai.app>',
    to,
    subject,
    html,
  });
}

function sendVerificationEmail(to, token) {
  const link = `${process.env.FRONTEND_URL}/verify.html?token=${token}`;
  return sendEmail(
    to,
    'Verify your Calorie Snap AI account',
    `<p>Welcome to Calorie Snap AI! Click below to verify your email:</p>
     <p><a href="${link}">${link}</a></p>
     <p>This link expires in 24 hours.</p>`
  );
}

function sendPasswordResetEmail(to, token) {
  const link = `${process.env.FRONTEND_URL}/reset-password.html?token=${token}`;
  return sendEmail(
    to,
    'Reset your Calorie Snap AI password',
    `<p>Click below to set a new password:</p>
     <p><a href="${link}">${link}</a></p>
     <p>This link expires in 1 hour. If you didn't request this, ignore this email.</p>`
  );
}

module.exports = { sendEmail, sendVerificationEmail, sendPasswordResetEmail };
