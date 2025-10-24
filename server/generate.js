// Lightweight Express proxy to call image-generation providers securely.
// Usage: set env vars STABILITY_API_KEY and HUGGINGFACE_API_KEY (and optionally POLLINATIONS_API_KEY).
// Install: npm install express node-fetch firebase-admin express-rate-limit
// Note: In production, use platform secret management and proper Firebase Admin init.

const express = require('express');
const fetch = require('node-fetch');
const admin = require('firebase-admin');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(express.json({ limit: '2mb' }));

// Simple rate limiter
const limiter = rateLimit({ windowMs: 10 * 1000, max: 8 });
app.use('/generate', limiter);

// Initialize Firebase Admin (platforms like Cloud Functions / Vercel will provide credentials).
if (!admin.apps.length) {
  try {
    admin.initializeApp();
  } catch (e) {
    console.warn('firebase-admin initializeApp warning:', e.message || e);
  }
}

function b64FromArrayBuffer(buf) {
  return Buffer.from(buf).toString('base64');
}

// Adapter: StabilityAI
async function generateWithStability(prompt, opts = {}) {
  const API_KEY = process.env.STABILITY_API_KEY;
  if (!API_KEY) throw new Error('Missing STABILITY_API_KEY env var');

  const engine = opts.engine || 'stable-diffusion-v1-5';
  const url = `https://api.stability.ai/v1/generation/${engine}/text-to-image`;

  const body = {
    text_prompts: [{ text: prompt }],
    cfg_scale: opts.cfg_scale || 7,
    width: opts.width || 512,
    height: opts.height || 512,
    samples: opts.samples || 1
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`StabilityAI error ${res.status}: ${txt}`);
  }

  const json = await res.json();
  const images = [];
  if (json.artifacts && Array.isArray(json.artifacts)) {
    for (const art of json.artifacts) {
      if (art.base64) images.push({ b64: art.base64, mime: 'image/png' });
    }
  } else {
    const arrayBuffer = await res.arrayBuffer();
    images.push({ b64: b64FromArrayBuffer(arrayBuffer), mime: 'image/png' });
  }
  return images;
}

// Adapter: Hugging Face Inference
async function generateWithHuggingFace(prompt, opts = {}) {
  const API_KEY = process.env.HUGGINGFACE_API_KEY;
  if (!API_KEY) throw new Error('Missing HUGGINGFACE_API_KEY env var');

  const model = opts.model || 'stabilityai/stable-diffusion-2';
  const url = `https://api-inference.huggingface.co/models/${model}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      Accept: '*/*'
    },
    body: JSON.stringify({ inputs: prompt, options: { wait_for_model: true } })
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`HuggingFace error ${res.status}: ${txt}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const j = await res.json();
    // NOTE: different HF models return different shapes. Adapt here if your model returns base64 JSON.
    if (j && j[0] && j[0].generated_image) {
      return [{ b64: j[0].generated_image, mime: 'image/png' }];
    }
    throw new Error('HuggingFace returned JSON but no image found; adapt adapter for this model');
  } else {
    const arrayBuffer = await res.arrayBuffer();
    return [{ b64: b64FromArrayBuffer(arrayBuffer), mime: 'image/png' }];
  }
}

// Adapter: Pollinations (placeholder, adapt per Pollinations docs)
async function generateWithPollinations(prompt, opts = {}) {
  const API_KEY = process.env.POLLINATIONS_API_KEY;
  const url = 'https://pollinations.ai/api/v3/generate'; // placeholder
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ prompt })
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Pollinations error ${res.status}: ${txt}`);
  }
  const json = await res.json();
  const images = [];
  if (json.image && json.image.startsWith('data:')) {
    images.push({ b64: json.image.split(',')[1], mime: 'image/png' });
  } else if (json.url) {
    const imgRes = await fetch(json.url);
    const arrayBuffer = await imgRes.arrayBuffer();
    images.push({ b64: b64FromArrayBuffer(arrayBuffer), mime: imgRes.headers.get('content-type') || 'image/png' });
  }
  return images;
}

// Main endpoint
app.post('/generate', async (req, res) => {
  try {
    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.split('Bearer ')[1] : null;
    if (!idToken) return res.status(401).json({ error: 'Missing Authorization Bearer token' });

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (e) {
      return res.status(401).json({ error: 'Invalid Firebase ID token' });
    }

    const { provider, model, prompt, width, height, steps, options } = req.body;
    if (!provider || !prompt) return res.status(400).json({ error: 'provider and prompt required' });

    // TODO: moderation (block disallowed content) before calling providers.

    let images = [];
    if (provider === 'stability') {
      images = await generateWithStability(prompt, { engine: model, width, height, steps, ...options });
    } else if (provider === 'huggingface') {
      images = await generateWithHuggingFace(prompt, { model, width, height, steps, ...options });
    } else if (provider === 'pollinations') {
      images = await generateWithPollinations(prompt, { model, width, height, steps, ...options });
    } else {
      return res.status(400).json({ error: 'Unknown provider' });
    }

    return res.json({
      provider,
      model,
      images,
      meta: { uid: decoded.uid, timestamp: new Date().toISOString() }
    });
  } catch (err) {
    console.error('generate error:', err);
    return res.status(500).json({ error: err.message || 'internal error' });
  }
});

// Local dev
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Generate proxy listening on ${PORT}`));
}

module.exports = app;