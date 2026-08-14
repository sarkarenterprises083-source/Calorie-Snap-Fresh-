// Vercel builds this file as a serverless function. vercel.json routes every request here,
// so the Express app inside server.js handles routing exactly as it does locally —
// no route-by-route rewrite needed.
module.exports = require('../server');
