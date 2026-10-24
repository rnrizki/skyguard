const express = require('express');
const { engine } = require('express-handlebars');
const cookieParser = require('cookie-parser');
const path = require('path');
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration from Environment Variables
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'SkyGuard2026!';
const GO2RTC_URL = process.env.GO2RTC_URL || 'http://localhost:1984';

// S3 Storage Credentials
const S3_ENDPOINT = process.env.S3_ENDPOINT || 'https://s3api1.skyconnection.id';
const S3_REGION = process.env.S3_REGION || 'us-west-1';
const S3_BUCKET = process.env.S3_BUCKET || 'frigate';
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || '73IGfrigateTCD0ytq';
const S3_SECRET_KEY = process.env.S3_SECRET_KEY || 'Np6XMltnNIsKzSLDjZzg9umAJGMfx3iKe1gsio3e';

// ParadeDB PostgreSQL Credentials
const PARADEDB_URL = process.env.PARADEDB_URL || 'postgresql://postgres:dNGwXb9OCrJNNaJMoKI7@mail-paradedb-46ygk4-postgres-1:5432/app';
const SYNC_KEY = process.env.SYNC_KEY || 'skyguard_sync_secret_key_2026';

// Initialize S3 Client
const s3 = new S3Client({
  endpoint: S3_ENDPOINT,
  region: S3_REGION,
  credentials: {
    accessKeyId: S3_ACCESS_KEY,
    secretAccessKey: S3_SECRET_KEY
  },
  forcePathStyle: true
});

// Initialize ParadeDB Pool
const pool = new Pool({
  connectionString: PARADEDB_URL,
  max: 15,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle ParadeDB client:', err.message);
});

// Auto-migrate ParadeDB Table & Indexes
async function initDatabase() {
  try {
    const client = await pool.connect();
    try {
      console.log('Connecting to ParadeDB PostgreSQL...');
      await client.query(`
        CREATE TABLE IF NOT EXISTS recordfrigate (
          id VARCHAR(64) PRIMARY KEY,
          camera VARCHAR(64) NOT NULL,
          path VARCHAR(255) NOT NULL,
          date VARCHAR(10) NOT NULL,
          hour VARCHAR(2) NOT NULL,
          start_time DOUBLE PRECISION NOT NULL,
          end_time DOUBLE PRECISION,
          duration REAL DEFAULT 0,
          objects INTEGER DEFAULT 0,
          motion INTEGER DEFAULT 0,
          segment_size REAL DEFAULT 0,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_recordfrigate_date_cam_hour ON recordfrigate(date, camera, hour);
        CREATE INDEX IF NOT EXISTS idx_recordfrigate_date_cam ON recordfrigate(date, camera);
        CREATE INDEX IF NOT EXISTS idx_recordfrigate_date ON recordfrigate(date DESC);
        CREATE INDEX IF NOT EXISTS idx_recordfrigate_start ON recordfrigate(start_time DESC);
        CREATE INDEX IF NOT EXISTS idx_recordfrigate_camera ON recordfrigate(camera);
      `);
      console.log('✓ ParadeDB table "recordfrigate" and indexes verified successfully.');
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('⚠ Warning: Could not initialize ParadeDB table:', err.message);
  }
}

initDatabase();

// Middleware
app.use(express.text({ type: ['text/*', 'application/sdp'] }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser('skyguard-secret-signature'));
app.use(express.static(path.join(__dirname, 'public')));

// Handlebars View Engine
app.engine('hbs', engine({
  extname: '.hbs',
  defaultLayout: 'main',
  layoutsDir: path.join(__dirname, 'views/layouts'),
  helpers: {
    eq: (a, b) => a === b,
    formatDate: (d) => new Date(d).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })
  }
}));
app.set('view engine', 'hbs');
app.set('views', path.join(__dirname, 'views'));

// Authentication Middleware
const requireAuth = (req, res, next) => {
  const token = req.cookies.skyguard_auth;
  if (token === 'authenticated_session_token') {
    return next();
  }
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized. Please login first.' });
  }
  res.redirect('/login');
};

// Helper: parse path into date, hour, clean key
function parseRecordingMeta(rawPath, startTime) {
  const clean = (rawPath || '').replace(/^\/media\/frigate\//, '').replace(/^\/+/, '');
  const parts = clean.split('/');
  let date = '';
  let hour = '';
  let filename = parts[parts.length - 1] || '';

  if (parts[0] === 'recordings' && parts.length >= 4) {
    date = parts[1];
    hour = parts[2];
  } else if (parts.length >= 3) {
    date = parts[0];
    hour = parts[1];
  }

  // Fallback to timestamp if date or hour missing
  if ((!date || !hour) && startTime) {
    const d = new Date(Number(startTime) * 1000);
    date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(d);
    hour = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', hour12: false }).format(d);
  }

  return { cleanPath: clean, date, hour, filename };
}

// Cameras Definition
const CAMERAS = [
  { id: 'teras_depan', name: 'Teras Depan', stream: 'teras_depan', location: 'Outdoor Depan' },
  { id: 'camera_02', name: 'Camera 02', stream: 'camera_02', location: 'Area Kantor' },
  { id: 'camera_03', name: 'Camera 03', stream: 'camera_03', location: 'Lobi & Koridor' },
  { id: 'camera_04', name: 'Camera 04', stream: 'camera_04', location: 'Ruang Rapat' },
  { id: 'camera_05', name: 'Camera 05', stream: 'camera_05', location: 'Ruang Kerja 1' },
  { id: 'camera_06', name: 'Camera 06', stream: 'camera_06', location: 'Ruang Kerja 2' },
  { id: 'camera_07', name: 'Camera 07', stream: 'camera_07', location: 'Area Belakang' },
  { id: 'camera_08', name: 'Camera 08', stream: 'camera_08', location: 'Server / NOC Room' },
  { id: 'dcs_5020l', name: 'D-Link DCS-5020L', stream: 'dcs_5020l', location: 'Indoor Lounge' }
];

// --- AUTH ROUTES ---
app.get('/login', (req, res) => {
  if (req.cookies.skyguard_auth === 'authenticated_session_token') {
    return res.redirect('/');
  }
  res.render('login', { layout: false, error: req.query.error });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USER && password === ADMIN_PASSWORD) {
    res.cookie('skyguard_auth', 'authenticated_session_token', {
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      httpOnly: true,
      secure: false
    });
    return res.redirect('/');
  }
  res.redirect('/login?error=Invalid username or password');
});

app.get('/logout', (req, res) => {
  res.clearCookie('skyguard_auth');
  res.redirect('/login');
});

// --- SURVEILLANCE VIEWS ---
app.get('/', requireAuth, (req, res) => {
  res.render('index', {
    title: 'Live Surveillance | SkyGuard',
    activeTab: 'live',
    cameras: CAMERAS,
    go2rtcUrl: GO2RTC_URL
  });
});

app.get('/recordings', requireAuth, (req, res) => {
  res.render('recordings', {
    title: 'S3 Recordings Archive | SkyGuard',
    activeTab: 'recordings',
    cameras: CAMERAS,
    s3WebConsole: 'https://s3web1.skyconnection.id'
  });
});

// --- API: GO2RTC PROXY ---
app.get('/api/go2rtc/streams', requireAuth, async (req, res) => {
  try {
    const fetch = globalThis.fetch;
    const response = await fetch(`${GO2RTC_URL}/api/streams`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.json({ error: 'Could not connect to go2rtc relay', details: err.message });
  }
});

// WebRTC Signaling Proxy to local go2rtc
app.post('/api/webrtc', requireAuth, async (req, res) => {
  try {
    const src = req.query.src;
    if (!src) return res.status(400).send('Missing src parameter');

    const fetch = globalThis.fetch;
    const response = await fetch(`${GO2RTC_URL}/api/webrtc?src=${encodeURIComponent(src)}`, {
      method: 'POST',
      headers: { 'Content-Type': req.headers['content-type'] || 'text/plain' },
      body: req.body
    });

    const sdp = await response.text();
    res.type('text/plain').send(sdp);
  } catch (err) {
    res.status(502).send(`Error communicating with go2rtc: ${err.message}`);
  }
});

// Snapshot Proxy
app.get('/api/go2rtc/frame.jpeg', requireAuth, async (req, res) => {
  try {
    const src = req.query.src;
    if (!src) return res.status(400).send('Missing src parameter');

    const fetch = globalThis.fetch;
    const response = await fetch(`${GO2RTC_URL}/api/frame.jpeg?src=${encodeURIComponent(src)}`);
    if (!response.ok) return res.status(response.status).send('Frame not available');
    
    res.set('Content-Type', 'image/jpeg');
    const buffer = await response.arrayBuffer();
    res.send(Buffer.from(buffer));
  } catch (err) {
    res.status(502).send(`Error fetching frame: ${err.message}`);
  }
});

// --- API: BATCH SYNC TO PARADEDB (Called from OpenWrt) ---
app.post('/api/recordings/batch-sync', async (req, res) => {
  const syncKey = req.headers['x-sync-key'] || req.query.key;
  if (syncKey !== SYNC_KEY) {
    return res.status(401).json({ error: 'Invalid or missing X-Sync-Key' });
  }

  const records = Array.isArray(req.body) ? req.body : (req.body.records || []);
  if (!records.length) {
    return res.json({ success: true, count: 0, message: 'Empty records batch' });
  }

  try {
    const ids = [];
    const cameras = [];
    const paths = [];
    const dates = [];
    const hours = [];
    const startTimes = [];
    const endTimes = [];
    const durations = [];
    const objectsList = [];
    const motions = [];
    const segmentSizes = [];

    for (const r of records) {
      if (!r.id || !r.camera || !r.path) continue;
      const meta = parseRecordingMeta(r.path, r.start_time);

      ids.push(String(r.id));
      cameras.push(String(r.camera));
      paths.push(meta.cleanPath);
      dates.push(meta.date);
      hours.push(meta.hour);
      startTimes.push(Number(r.start_time) || 0);
      endTimes.push(Number(r.end_time) || 0);
      durations.push(Number(r.duration) || 0);
      objectsList.push(Number(r.objects) || 0);
      motions.push(Number(r.motion) || 0);
      segmentSizes.push(Number(r.segment_size) || 0);
    }

    if (!ids.length) {
      return res.json({ success: true, count: 0 });
    }

    const query = `
      INSERT INTO recordfrigate (
        id, camera, path, date, hour, start_time, end_time, duration, objects, motion, segment_size
      )
      SELECT * FROM UNNEST(
        $1::text[],
        $2::text[],
        $3::text[],
        $4::text[],
        $5::text[],
        $6::float8[],
        $7::float8[],
        $8::real[],
        $9::int4[],
        $10::int4[],
        $11::real[]
      )
      ON CONFLICT (id) DO UPDATE SET
        objects = EXCLUDED.objects,
        motion = EXCLUDED.motion,
        segment_size = EXCLUDED.segment_size,
        duration = EXCLUDED.duration;
    `;

    await pool.query(query, [
      ids,
      cameras,
      paths,
      dates,
      hours,
      startTimes,
      endTimes,
      durations,
      objectsList,
      motions,
      segmentSizes
    ]);

    res.json({ success: true, count: ids.length });
  } catch (err) {
    console.error('Batch sync error:', err);
    res.status(500).json({ error: 'Database insertion error', details: err.message });
  }
});

// Stats API
app.get('/api/recordings/stats', requireAuth, async (req, res) => {
  try {
    const totalRes = await pool.query('SELECT COUNT(*) AS total FROM recordfrigate;');
    const camRes = await pool.query('SELECT camera, COUNT(*) AS count FROM recordfrigate GROUP BY camera ORDER BY count DESC;');
    const latestRes = await pool.query('SELECT date, hour, start_time, camera, path FROM recordfrigate ORDER BY start_time DESC LIMIT 1;');

    res.json({
      total: parseInt(totalRes.rows[0].total, 10),
      byCamera: camRes.rows,
      latest: latestRes.rows[0] || null
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve stats', details: err.message });
  }
});

// --- API: RECORDINGS ARCHIVE (PARADEDB WITH S3 FALLBACK) ---
// List distinct dates
app.get('/api/recordings/dates', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT DISTINCT date FROM recordfrigate ORDER BY date DESC LIMIT 60;');
    if (result.rows && result.rows.length > 0) {
      return res.json({ dates: result.rows.map(r => r.date), source: 'paradedb' });
    }
  } catch (err) {
    console.warn('ParadeDB dates query failed, falling back to S3:', err.message);
  }

  // Fallback to S3
  try {
    const command = new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: 'recordings/',
      Delimiter: '/'
    });
    const data = await s3.send(command);
    const prefixes = (data.CommonPrefixes || []).map(p => {
      const parts = p.Prefix.split('/');
      return parts[1]; // recordings/<YYYY-MM-DD>/
    }).filter(Boolean).sort().reverse();

    res.json({ dates: prefixes, source: 's3' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list dates from S3', details: err.message });
  }
});

// List recordings by camera and date
app.get('/api/recordings/list', requireAuth, async (req, res) => {
  const { camera, date, hour } = req.query;
  if (!date) {
    return res.status(400).json({ error: 'Date parameter is required (YYYY-MM-DD)' });
  }

  // Attempt ParadeDB Query (< 3ms)
  try {
    let sql = `
      SELECT id, camera, path, date, hour, start_time, end_time, duration, objects, motion, segment_size
      FROM recordfrigate
      WHERE date = $1
    `;
    const params = [date];
    let pIdx = 2;

    if (camera && camera !== 'all') {
      sql += ` AND camera = $${pIdx++}`;
      params.push(camera);
    }

    if (hour !== undefined && hour !== '') {
      const paddedHour = String(hour).padStart(2, '0');
      sql += ` AND hour = $${pIdx++}`;
      params.push(paddedHour);
    }

    sql += ` ORDER BY start_time DESC LIMIT 1000;`;

    const result = await pool.query(sql, params);

    // If table has data or was successfully queried
    const files = result.rows.map(r => {
      const key = r.path.replace(/^\/media\/frigate\//, '');
      const parts = key.split('/');
      const filename = parts[parts.length - 1] || '';
      const timeStr = filename.replace('.mp4', '').replace('.', ':');
      const formattedSize = r.segment_size ? `${Number(r.segment_size).toFixed(2)} MB` : 'N/A';

      return {
        id: r.id,
        key: key,
        filename: filename,
        camera: r.camera,
        date: r.date,
        hour: r.hour,
        time: `${r.hour}:${timeStr}`,
        size: Math.round((Number(r.segment_size) || 0) * 1024 * 1024),
        sizeFormatted: formattedSize,
        duration: Math.round(Number(r.duration) || 0),
        objects: r.objects || 0,
        motion: r.motion || 0,
        startTime: r.start_time,
        endTime: r.end_time
      };
    });

    return res.json({ files, count: files.length, source: 'paradedb' });
  } catch (err) {
    console.warn('ParadeDB list query failed, falling back to S3:', err.message);
  }

  // Fallback: S3 ListObjectsV2
  try {
    let prefix = `recordings/${date}/`;
    if (hour !== undefined && hour !== '') {
      const paddedHour = String(hour).padStart(2, '0');
      prefix += `${paddedHour}/`;
      if (camera && camera !== 'all') {
        prefix += `${camera}/`;
      }
    }

    const command = new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: prefix,
      MaxKeys: 1000
    });

    const data = await s3.send(command);
    const files = (data.Contents || []).filter(item => {
      if (!item.Key.endsWith('.mp4')) return false;
      if (camera && camera !== 'all') {
        return item.Key.includes(`/${camera}/`);
      }
      return true;
    }).map(item => {
      const parts = item.Key.split('/');
      const keyDate = parts[1] || '';
      const keyHour = parts[2] || '';
      const keyCamera = parts[3] || '';
      const keyFilename = parts[4] || '';
      
      const timeStr = keyFilename.replace('.mp4', '').replace('.', ':');
      const formattedSize = (item.Size / (1024 * 1024)).toFixed(2) + ' MB';

      return {
        key: item.Key,
        filename: keyFilename,
        camera: keyCamera,
        date: keyDate,
        hour: keyHour,
        time: `${keyHour}:${timeStr}`,
        size: item.Size,
        sizeFormatted: formattedSize,
        lastModified: item.LastModified
      };
    }).sort((a, b) => b.key.localeCompare(a.key));

    res.json({ files, count: files.length, prefix, source: 's3' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to query recordings from S3', details: err.message });
  }
});

// Stream MP4 Video from S3 with Byte-Range Support (for smooth scrubbing)
app.get('/api/recordings/stream', requireAuth, async (req, res) => {
  const key = req.query.key;
  if (!key) {
    return res.status(400).send('Missing key parameter');
  }

  try {
    const range = req.headers.range;
    const command = new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Range: range || undefined
    });

    const s3Response = await s3.send(command);

    if (range && s3Response.ContentRange) {
      res.writeHead(206, {
        'Content-Range': s3Response.ContentRange,
        'Accept-Ranges': 'bytes',
        'Content-Length': s3Response.ContentLength,
        'Content-Type': s3Response.ContentType || 'video/mp4'
      });
    } else {
      res.writeHead(200, {
        'Content-Length': s3Response.ContentLength,
        'Content-Type': s3Response.ContentType || 'video/mp4',
        'Accept-Ranges': 'bytes'
      });
    }

    s3Response.Body.pipe(res);
  } catch (err) {
    res.status(404).send(`Video not found or streaming error: ${err.message}`);
  }
});

// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`  SkyGuard - SkyConnection Surveillance System`);
  console.log(`  Running on http://0.0.0.0:${PORT}`);
  console.log(`  ParadeDB: ${PARADEDB_URL.replace(/:[^:@]+@/, ':***@')}`);
  console.log(`  S3 Endpoint: ${S3_ENDPOINT} (Bucket: ${S3_BUCKET})`);
  console.log(`  go2rtc Relay: ${GO2RTC_URL}`);
  console.log(`=======================================================`);
});
