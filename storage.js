const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const crypto = require('crypto');
const path = require('path');

// Works with AWS S3 as-is. For Cloudflare R2 or Backblaze B2 (cheaper, often free egress —
// worth it if most of your users and traffic are in India), just set S3_ENDPOINT to their
// endpoint URL; the API is S3-compatible so nothing else here changes.
const s3 = new S3Client({
  region: process.env.S3_REGION || 'auto',
  endpoint: process.env.S3_ENDPOINT || undefined,
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID,
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.S3_BUCKET;

// Uploads a meal photo to a PRIVATE bucket and returns its storage key (not a public URL —
// meal photos are personal, so nothing should be fetchable without a signed, expiring link).
async function uploadMealPhoto(userId, file) {
  const ext = path.extname(file.originalname) || '.jpg';
  const key = `meal-photos/${userId}/${Date.now()}-${crypto.randomUUID()}${ext}`;

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
      ServerSideEncryption: 'AES256', // encryption at rest
    })
  );

  return key;
}

// Turns a stored key into a time-limited URL — call this only when actually returning
// data to the owning user, never store the signed URL itself (it expires and shouldn't be cached).
async function getSignedPhotoUrl(key, expiresInSeconds = 3600) {
  if (!key) return null;
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return getSignedUrl(s3, command, { expiresIn: expiresInSeconds });
}

async function deleteMealPhoto(key) {
  if (!key) return;
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
}

module.exports = { uploadMealPhoto, getSignedPhotoUrl, deleteMealPhoto };
