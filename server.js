const express = require('express');
const { engine } = require('express-handlebars');
const cookieParser = require('cookie-parser');
const path = require('path');
const { S3Client, ListObjectsV2Command, GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration from Environment Variables
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'SkyGuard2026!';
const GO2RTC_URL = process.env.GO2RTC_URL || 'http://localhost:1984';
const FRIGATE_URL = process.env.FRIGATE_URL || 'http://100.65.136.42:5000';

// S3 Storage Credentials
const S3_ENDPOINT = process.env.S3_ENDPOINT || 'https://s3api1.skyconnection.id';
const S3_REGION = process.env.S3_REGION || 'us-west-1';
const S3_BUCKET = process.env.S3_BUCKET || 'frigate';
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || '73IGfrigateTCD0ytq';
const S3_SECRET_KEY = process.env.S3_SECRET_KEY || 'Np6XMltnNIsKzSLDjZzg9umAJGMfx3iKe1gsio3e';

// ParadeDB PostgreSQL Credentials
const PARADEDB_URL = process.env.PARADEDB_URL || 'postgresql://postgres:dNGwXb9OCrJNNaJMoKI7@mail-paradedb-46ygk4-postgres-1:5432/app';
const SYNC_KEY = process.env.SYNC_KEY || 'skyguard_sync_secret_key_2026';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

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

        CREATE TABLE IF NOT EXISTS frigate_events (
          id VARCHAR(64) PRIMARY KEY,
          camera VARCHAR(64) NOT NULL,
          label VARCHAR(64) NOT NULL,
          sub_label VARCHAR(100),
          top_score REAL,
          score REAL,
          start_time DOUBLE PRECISION NOT NULL,
          end_time DOUBLE PRECISION,
          duration REAL DEFAULT 0,
          has_clip BOOLEAN DEFAULT TRUE,
          has_snapshot BOOLEAN DEFAULT FALSE,
          date VARCHAR(10) NOT NULL,
          time VARCHAR(8) NOT NULL,
          thumbnail_base64 TEXT,
          data JSONB,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_frigate_events_start ON frigate_events(start_time DESC);
        CREATE INDEX IF NOT EXISTS idx_frigate_events_cam_start ON frigate_events(camera, start_time DESC);
        CREATE INDEX IF NOT EXISTS idx_frigate_events_date ON frigate_events(date DESC);
        CREATE INDEX IF NOT EXISTS idx_frigate_events_label ON frigate_events(label);
      `);
      console.log('✓ ParadeDB tables "recordfrigate" and "frigate_events" verified successfully.');
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

// Helper: Group individual contiguous 10-second segments into continuous video sessions
function groupIntoSessions(files) {
  if (!files || !files.length) return [];
  // Exclude recordings with duration < 3 seconds per user requirement
  const validFiles = files.filter(f => (f.duration !== undefined ? f.duration >= 3 : true));
  if (!validFiles.length) return [];

  // Sort ascending by start time
  const sorted = [...validFiles].sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
  const sessions = [];
  let current = null;

  for (const f of sorted) {
    if (!current) {
      current = {
        sessionId: `session-${f.id || f.key.replace(/[^a-zA-Z0-9]/g, '_')}`,
        camera: f.camera,
        date: f.date,
        hour: f.hour,
        startTime: f.startTime,
        endTime: f.endTime || (f.startTime + (f.duration || 10)),
        startTimeFormatted: f.time,
        endTimeFormatted: f.time,
        totalDuration: f.duration || 10,
        totalSize: f.size || 0,
        totalObjects: f.objects || 0,
        hasMotion: (f.motion || 0) > 0,
        s3Synced: f.s3Synced !== false,
        key: f.key,
        segments: [f]
      };
    } else {
      const gap = (f.startTime || 0) - (current.endTime || 0);
      // If gap is 15 seconds or less, treat as contiguous continuous video
      if (gap <= 15 && f.camera === current.camera) {
        current.segments.push(f);
        current.endTime = f.endTime || (f.startTime + (f.duration || 10));
        current.endTimeFormatted = f.time;
        current.totalDuration += (f.duration || 10);
        current.totalSize += (f.size || 0);
        current.totalObjects += (f.objects || 0);
        if ((f.motion || 0) > 0) current.hasMotion = true;
        if (f.s3Synced === false) current.s3Synced = false;
      } else {
        sessions.push(finalizeSession(current));
        current = {
          sessionId: `session-${f.id || f.key.replace(/[^a-zA-Z0-9]/g, '_')}`,
          camera: f.camera,
          date: f.date,
          hour: f.hour,
          startTime: f.startTime,
          endTime: f.endTime || (f.startTime + (f.duration || 10)),
          startTimeFormatted: f.time,
          endTimeFormatted: f.time,
          totalDuration: f.duration || 10,
          totalSize: f.size || 0,
          totalObjects: f.objects || 0,
          hasMotion: (f.motion || 0) > 0,
          s3Synced: f.s3Synced !== false,
          key: f.key,
          segments: [f]
        };
      }
    }
  }

  if (current) {
    sessions.push(finalizeSession(current));
  }

  return sessions.filter(s => s.totalDuration >= 3).reverse();
}

function finalizeSession(s) {
  const mins = Math.floor(s.totalDuration / 60);
  const secs = Math.round(s.totalDuration % 60);
  const durFormatted = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  const sizeMb = (s.totalSize / (1024 * 1024)).toFixed(2) + ' MB';

  return {
    ...s,
    durationFormatted: durFormatted,
    sizeFormatted: sizeMb,
    segmentCount: s.segments.length,
    timeRange: `${s.startTimeFormatted} - ${s.endTimeFormatted}`
  };
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

// --- API: FRIGATE TRACKED EVENTS PROXY ---
// Cached Daily Event Summary for instantaneous pagination count
let cachedEventSummary = null;
let lastSummaryFetch = 0;
let isFetchingSummary = false;

async function getOrFetchEventSummary() {
  const now = Date.now();
  if (cachedEventSummary && (now - lastSummaryFetch < 120000)) {
    return cachedEventSummary;
  }
  if (isFetchingSummary && cachedEventSummary) {
    return cachedEventSummary;
  }
  isFetchingSummary = true;
  try {
    const res = await globalThis.fetch(`${FRIGATE_URL}/api/events/summary?timezone=Asia/Jakarta`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      cachedEventSummary = await res.json();
      lastSummaryFetch = now;
    }
  } catch (err) {
    console.warn('Failed to fetch events summary:', err.message);
  } finally {
    isFetchingSummary = false;
  }
  return cachedEventSummary || [];
}

// --- PARADEDB EVENTS ENGINE (Instant Local Query < 5ms) ---
async function getEventsFromParadeDB({ cam, lbl, filterDateStr, limit, offset, page, res, rawArray }) {
  // 1. Check if frigate_events has data
  let hasEventsData = false;
  try {
    const chk = await pool.query('SELECT 1 FROM frigate_events LIMIT 1;');
    if (chk.rows.length > 0) hasEventsData = true;
  } catch (_) {}

  if (hasEventsData) {
    let sql = `
      SELECT id, camera, label, sub_label, top_score, score, start_time, end_time, duration,
             has_clip, has_snapshot, date, time, thumbnail_base64, data
      FROM frigate_events
      WHERE (duration IS NULL OR duration >= 3)
    `;
    const sqlParams = [];
    let pIdx = 1;

    if (cam && cam !== 'all') {
      const camList = cam.split(',').map(c => c.trim()).filter(Boolean);
      if (camList.length === 1) {
        sql += ` AND camera = $${pIdx++}`;
        sqlParams.push(camList[0]);
      } else if (camList.length > 1) {
        const placeholders = camList.map(() => `$${pIdx++}`).join(', ');
        sql += ` AND camera IN (${placeholders})`;
        sqlParams.push(...camList);
      }
    }

    if (filterDateStr) {
      sql += ` AND date = $${pIdx++}`;
      sqlParams.push(filterDateStr);
    }

    if (lbl && lbl !== 'all') {
      sql += ` AND label = $${pIdx++}`;
      sqlParams.push(lbl);
    }

    let totalCount = null;
    try {
      const countSql = `SELECT COUNT(*) AS total FROM (${sql}) AS sub;`;
      const countRes = await pool.query(countSql, sqlParams);
      totalCount = parseInt(countRes.rows[0].total, 10);
    } catch (cErr) {
      console.warn('ParadeDB count query failed:', cErr.message);
    }

    sql += ` ORDER BY start_time DESC LIMIT $${pIdx++} OFFSET $${pIdx++};`;
    sqlParams.push(limit, offset);

    const result = await pool.query(sql, sqlParams);
    const rows = result.rows || [];

    const iconMap = {
      person: '🚶',
      car: '🚗',
      motorcycle: '🏍️',
      bicycle: '🚲',
      dog: '🐕',
      cat: '🐈'
    };

    const formatted = rows.map(r => {
      const startTime = Number(r.start_time) || 0;
      const endTime = r.end_time ? Number(r.end_time) : null;
      const duration = Math.round(Number(r.duration) || (endTime ? endTime - startTime : 10));
      const mins = Math.floor(duration / 60);
      const secs = duration % 60;
      const durationFormatted = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

      const startDate = startTime ? new Date(startTime * 1000) : new Date();
      const usStartStr = new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
        timeZone: 'Asia/Jakarta'
      }).format(startDate);

      let endTimeStr = '';
      let usEndStr = '';
      if (endTime) {
        const endDate = new Date(endTime * 1000);
        endTimeStr = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(endDate);
        usEndStr = new Intl.DateTimeFormat('en-US', {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          second: '2-digit',
          hour12: true,
          timeZone: 'Asia/Jakarta'
        }).format(endDate);
      }

      const rawScore = r.top_score || r.score || (r.data && (r.data.top_score || r.data.score)) || 0.75;
      const scoreNum = Math.round(Number(rawScore) * 100);

      return {
        id: r.id,
        camera: r.camera,
        label: r.label || 'person',
        labelIcon: iconMap[r.label] || '🚶',
        subLabel: r.sub_label,
        startTime,
        endTime,
        duration,
        durationFormatted,
        score: scoreNum,
        hasClip: r.has_clip !== false,
        hasSnapshot: r.has_snapshot === true,
        date: r.date,
        time: r.time,
        usStartTime: usStartStr,
        usEndTime: usEndStr,
        timeRange: endTimeStr ? `${r.time} - ${endTimeStr}` : `${r.time}`,
        usTimeRange: usEndStr ? `${usStartStr} - ${usEndStr}` : `${usStartStr}`,
        thumbnailUrl: r.thumbnail_base64 ? `data:image/webp;base64,${r.thumbnail_base64}` : `/api/events/${r.id}/thumbnail.webp`,
        snapshotUrl: `/api/events/${r.id}/snapshot.jpg`,
        clipUrl: `/api/events/${r.id}/clip.mp4`,
        data: r.data || {},
        source: 'paradedb'
      };
    });

    if (rawArray === 'true') {
      return res.json(formatted);
    }

    const effectiveTotal = totalCount !== null ? totalCount : (formatted.length < limit ? offset + formatted.length : offset + limit * 2);
    const totalPages = Math.max(1, Math.ceil(effectiveTotal / limit));

    return res.json({
      events: formatted,
      source: 'paradedb',
      pagination: {
        page,
        limit,
        total: totalCount,
        totalPages,
        hasNext: page < totalPages && formatted.length === limit,
        hasPrev: page > 1
      }
    });
  }

  // 2. Fallback to recordfrigate if events haven't synced yet
  let sql = `
    SELECT id, camera, path, date, hour, start_time, end_time, duration, objects, motion, segment_size
    FROM recordfrigate
    WHERE (duration IS NULL OR duration >= 3)
  `;
  const sqlParams = [];
  let pIdx = 1;

  if (cam && cam !== 'all') {
    const camList = cam.split(',').map(c => c.trim()).filter(Boolean);
    if (camList.length === 1) {
      sql += ` AND camera = $${pIdx++}`;
      sqlParams.push(camList[0]);
    } else if (camList.length > 1) {
      const placeholders = camList.map(() => `$${pIdx++}`).join(', ');
      sql += ` AND camera IN (${placeholders})`;
      sqlParams.push(...camList);
    }
  }

  if (filterDateStr) {
    sql += ` AND date = $${pIdx++}`;
    sqlParams.push(filterDateStr);
  }

  if (lbl === 'person') {
    sql += ` AND objects > 0`;
  }

  let totalCount = null;
  try {
    const countSql = `SELECT COUNT(*) AS total FROM (${sql}) AS sub;`;
    const countRes = await pool.query(countSql, sqlParams);
    totalCount = parseInt(countRes.rows[0].total, 10);
  } catch (cErr) {
    console.warn('ParadeDB count query failed:', cErr.message);
  }

  sql += ` ORDER BY start_time DESC LIMIT $${pIdx++} OFFSET $${pIdx++};`;
  sqlParams.push(limit, offset);

  const result = await pool.query(sql, sqlParams);
  const rows = result.rows || [];

  const formatted = rows.map(r => {
    const startTime = Number(r.start_time) || 0;
    const endTime = r.end_time ? Number(r.end_time) : (startTime + (Number(r.duration) || 10));
    const duration = Math.round(Number(r.duration) || 10);
    const mins = Math.floor(duration / 60);
    const secs = duration % 60;
    const durationFormatted = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

    const startDate = startTime ? new Date(startTime * 1000) : new Date();
    const dateStr = r.date || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(startDate);
    const timeStr = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(startDate);
    const usStartStr = new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
      timeZone: 'Asia/Jakarta'
    }).format(startDate);

    return {
      id: r.id,
      camera: r.camera,
      label: (r.objects && r.objects > 0) ? 'person' : 'motion',
      labelIcon: (r.objects && r.objects > 0) ? '🚶' : '⚡',
      subLabel: null,
      startTime,
      endTime,
      duration,
      durationFormatted,
      score: (r.objects && r.objects > 0) ? 85 : 70,
      hasClip: true,
      hasSnapshot: true,
      date: dateStr,
      time: timeStr,
      usStartTime: usStartStr,
      usEndTime: '',
      timeRange: `${timeStr} (Sesi)`,
      usTimeRange: `${usStartStr}`,
      thumbnailUrl: `/api/events/${r.id}/thumbnail.webp`,
      snapshotUrl: `/api/events/${r.id}/snapshot.jpg`,
      clipUrl: `/api/recordings/stream?key=${encodeURIComponent(r.path)}`,
      data: { score: (r.objects && r.objects > 0) ? 0.85 : 0.70 },
      source: 'paradedb'
    };
  });

  if (rawArray === 'true') {
    return res.json(formatted);
  }

  const effectiveTotal = totalCount !== null ? totalCount : (formatted.length < limit ? offset + formatted.length : offset + limit * 2);
  const totalPages = Math.max(1, Math.ceil(effectiveTotal / limit));

  return res.json({
    events: formatted,
    source: 'paradedb',
    pagination: {
      page,
      limit,
      total: totalCount,
      totalPages,
      hasNext: page < totalPages && formatted.length === limit,
      hasPrev: page > 1
    }
  });
}

// List events with metadata and pagination
app.get('/api/events', requireAuth, async (req, res) => {
  try {
    const { camera, cameras, label, labels, before, after, date, rawArray } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 30));
    const offset = (page - 1) * limit;

    const params = new URLSearchParams();

    const cam = camera || cameras;
    if (cam && cam !== 'all') {
      params.append('cameras', cam);
    }

    params.append('limit', String(limit));
    params.append('offset', String(offset));
    params.append('min_length', '3'); // Filter in SQLite: exclude events < 3 seconds

    const lbl = label || labels;
    if (lbl && lbl !== 'all') {
      params.append('labels', lbl);
    }

    // Date filtering (YYYY-MM-DD in Asia/Jakarta GMT+7)
    let filterDateStr = '';
    if (date && date !== 'all' && date !== '') {
      filterDateStr = date;
      const startDay = Math.floor(new Date(`${date}T00:00:00+07:00`).getTime() / 1000);
      const endDay = Math.floor(new Date(`${date}T23:59:59+07:00`).getTime() / 1000);
      if (!after && !isNaN(startDay)) params.append('after', String(startDay));
      if (!before && !isNaN(endDay)) params.append('before', String(endDay));
    } else {
      if (before) params.append('before', before);
      if (after) params.append('after', after);
    }

    // DEFAULT TO PARADEDB: PostgreSQL runs locally on VPS, has 0ms network latency,
    // and eliminates 502 Bad Gateway timeouts from Frigate/Tailscale.
    // Only query Frigate if ?source=frigate is explicitly requested!
    if (req.query.source !== 'frigate') {
      return await getEventsFromParadeDB({ cam, lbl, filterDateStr, limit, offset, page, res, rawArray });
    }

    // Otherwise, try Frigate with a 3.5s timeout; on failure/timeout, fall back to ParadeDB seamlessly!
    let events = null;
    try {
      const frigateApiUrl = `${FRIGATE_URL}/api/events?${params.toString()}`;
      const fRes = await globalThis.fetch(frigateApiUrl, { signal: AbortSignal.timeout(3500) });
      if (fRes.ok) {
        events = await fRes.json();
      }
    } catch (fErr) {
      console.warn('Frigate API unreachable or timed out, falling back to ParadeDB:', fErr.message);
    }

    if (!events) {
      return await getEventsFromParadeDB({ cam, lbl, filterDateStr, limit, offset, page, res, rawArray });
    }

    const formatted = events.map(e => {
      const startTime = Number(e.start_time) || 0;
      const endTime = e.end_time ? Number(e.end_time) : null;
      const duration = endTime ? Math.max(0, Math.round(endTime - startTime)) : 0;

      // Filter out video with duration < 3 seconds per user requirement
      if (duration < 3) return null;

      const mins = Math.floor(duration / 60);
      const secs = duration % 60;
      const durationFormatted = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

      const startDate = startTime ? new Date(startTime * 1000) : new Date();
      const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(startDate);
      const timeStr = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(startDate);

      const usStartStr = new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
        timeZone: 'Asia/Jakarta'
      }).format(startDate);

      let endTimeStr = '';
      let usEndStr = '';
      if (endTime) {
        const endDate = new Date(endTime * 1000);
        endTimeStr = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(endDate);
        usEndStr = new Intl.DateTimeFormat('en-US', {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          second: '2-digit',
          hour12: true,
          timeZone: 'Asia/Jakarta'
        }).format(endDate);
      }

      const rawScore = e.top_score || (e.data && e.data.top_score) || (e.data && e.data.score) || 0.7;
      const scoreNum = Math.round(Number(rawScore) * 100);

      // Icon for common object labels
      const iconMap = {
        person: '🚶',
        car: '🚗',
        motorcycle: '🏍️',
        bicycle: '🚲',
        dog: '🐕',
        cat: '🐈',
        bus: '🚌',
        truck: '🚚'
      };
      const labelIcon = iconMap[e.label] || '🎯';

      return {
        id: e.id,
        camera: e.camera,
        label: e.label,
        labelIcon: labelIcon,
        subLabel: e.sub_label,
        startTime,
        endTime,
        duration,
        durationFormatted,
        score: scoreNum,
        hasClip: e.has_clip !== false,
        hasSnapshot: e.has_snapshot === true,
        date: dateStr,
        time: timeStr,
        usStartTime: usStartStr,
        usEndTime: usEndStr,
        timeRange: endTimeStr ? `${timeStr} - ${endTimeStr}` : `${timeStr} (In progress)`,
        usTimeRange: usEndStr ? `${usStartStr} - ${usEndStr}` : `${usStartStr} (In progress)`,
        thumbnailUrl: `/api/events/${e.id}/thumbnail.webp`,
        snapshotUrl: `/api/events/${e.id}/snapshot.jpg`,
        clipUrl: `/api/events/${e.id}/clip.mp4`,
        data: e.data || {}
      };
    }).filter(Boolean);

    if (rawArray === 'true') {
      return res.json(formatted);
    }

    // Calculate total count using cached daily summary
    let totalCount = null;
    try {
      const summary = await getOrFetchEventSummary();
      if (summary && summary.length > 0) {
        let filtered = summary;
        if (filterDateStr) {
          filtered = filtered.filter(item => item.day === filterDateStr);
        }
        if (cam && cam !== 'all') {
          const camList = cam.split(',').map(c => c.trim());
          filtered = filtered.filter(item => camList.includes(item.camera));
        }
        if (lbl && lbl !== 'all') {
          filtered = filtered.filter(item => item.label === lbl);
        }
        totalCount = filtered.reduce((acc, cur) => acc + (Number(cur.count) || 0), 0);
      }
    } catch (_) {}

    const effectiveTotal = totalCount !== null ? totalCount : (formatted.length < limit ? offset + formatted.length : offset + limit * 2);
    const totalPages = Math.max(1, Math.ceil(effectiveTotal / limit));

    res.json({
      events: formatted,
      pagination: {
        page,
        limit,
        total: totalCount,
        totalPages,
        hasNext: page < totalPages && formatted.length === limit,
        hasPrev: page > 1
      }
    });
  } catch (err) {
    console.error('Failed to proxy Frigate events, falling back to ParadeDB:', err.message);
    try {
      const cam = req.query.camera || req.query.cameras;
      const lbl = req.query.label || req.query.labels;
      const filterDateStr = req.query.date || '';
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 30));
      const offset = (page - 1) * limit;
      return await getEventsFromParadeDB({ cam, lbl, filterDateStr, limit, offset, page, res, rawArray: req.query.rawArray });
    } catch (fallbackErr) {
      res.status(500).json({ error: 'Failed to retrieve events', details: fallbackErr.message });
    }
  }
});

// --- API: GEMINI AI SURVEILLANCE INTELLIGENCE ---
const aiAnalysisCache = new Map();

async function requestGeminiGenerate(parts) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured in environment');
  }

  const models = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.8-flash'];
  let lastError = null;

  for (const model of models) {
    try {
      const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
      const gRes = await globalThis.fetch(geminiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            response_mime_type: 'application/json'
          }
        })
      });

      if (gRes.ok) {
        const gData = await gRes.json();
        const rawText = gData.candidates?.[0]?.content?.parts?.[0]?.text;
        if (rawText) {
          try {
            return JSON.parse(rawText);
          } catch (_) {
            return { summary: rawText, riskLevel: 'Sedang', recommendation: 'Verifikasi rekaman visual secara langsung.' };
          }
        }
      } else {
        const errText = await gRes.text();
        console.warn(`Gemini (${model}) returned ${gRes.status}:`, errText);
        lastError = new Error(`Gemini HTTP ${gRes.status}`);
      }
    } catch (err) {
      console.warn(`Gemini (${model}) error:`, err.message);
      lastError = err;
    }
  }

  throw lastError || new Error('Failed to reach Gemini API');
}

// AI Analysis for Single Event
app.post('/api/ai/analyze-event', requireAuth, async (req, res) => {
  try {
    const { eventId } = req.body;
    if (!eventId) return res.status(400).json({ error: 'Missing eventId' });

    if (aiAnalysisCache.has(eventId)) {
      return res.json({ success: true, analysis: aiAnalysisCache.get(eventId), cached: true });
    }

    // 1. Fetch event metadata from Frigate
    const metaRes = await globalThis.fetch(`${FRIGATE_URL}/api/events/${eventId}`);
    const event = metaRes.ok ? await metaRes.json() : null;

    // 2. Fetch thumbnail or snapshot as base64
    let b64Image = null;
    let mimeType = 'image/webp';
    try {
      let imgRes = await globalThis.fetch(`${FRIGATE_URL}/api/events/${eventId}/thumbnail.webp`);
      if (!imgRes.ok) {
        imgRes = await globalThis.fetch(`${FRIGATE_URL}/api/events/${eventId}/snapshot.jpg`);
        mimeType = 'image/jpeg';
      }
      if (imgRes.ok) {
        const buf = await imgRes.arrayBuffer();
        b64Image = Buffer.from(buf).toString('base64');
      }
    } catch (_) {}

    const camName = event ? (event.camera || '').replace(/_/g, ' ').toUpperCase() : 'CCTV';
    const label = event ? event.label : 'objek';
    const startTimeStr = event && event.start_time ? new Date(event.start_time * 1000).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) : '';
    const durSec = event && event.end_time ? Math.round(event.end_time - event.start_time) : 0;

    const parts = [];
    if (b64Image) {
      parts.push({
        inline_data: {
          mime_type: mimeType,
          data: b64Image
        }
      });
    }

    parts.push({
      text: `Kamu adalah SkyGuard AI - Analis Intelijen Keamanan Pengawasan CCTV profesional.
Analisis rekaman kejadian berikut:
- Lokasi Kamera: ${camName}
- Objek Terdeteksi: ${label}
- Waktu Rekaman: ${startTimeStr} WIB
- Durasi Rekaman: ${durSec} detik

Tugasmu:
1. Deskripsikan visual gambar secara ringkas (kondisi pencahayaan, arah gerak, aktivitas yang tampak).
2. Tentukan Tingkat Risiko keamanan: "Rendah" (aktivitas wajar/rutin/penghuni), "Sedang" (aktivitas di luar jam wajar/perlu perhatian), atau "Tinggi" (mencurigakan/potensi penyusupan).
3. Berikan Rekomendasi Tindakan Keamanan untuk pemilik/petugas keamanan.

Format respon dalam JSON valid:
{
  "summary": "Deskripsi intelijen ringkas (2-3 kalimat dalam Bahasa Indonesia)",
  "riskLevel": "Rendah" | "Sedang" | "Tinggi",
  "activity": "Deskripsi aktivitas singkat",
  "recommendation": "Rekomendasi tindakan keamanan praktis"
}`
    });

    const parsed = await requestGeminiGenerate(parts);
    aiAnalysisCache.set(eventId, parsed);
    res.json({ success: true, analysis: parsed, cached: false });

  } catch (err) {
    console.error('AI Event Analysis Error:', err);
    res.status(500).json({ error: 'Failed to generate AI analysis', details: err.message });
  }
});

// Daily Security Intelligence Briefing
app.post('/api/ai/daily-briefing', requireAuth, async (req, res) => {
  try {
    const { date, camera } = req.body;
    const targetDate = date || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date());

    const startDay = Math.floor(new Date(`${targetDate}T00:00:00+07:00`).getTime() / 1000);
    const endDay = Math.floor(new Date(`${targetDate}T23:59:59+07:00`).getTime() / 1000);

    let frigateUrl = `${FRIGATE_URL}/api/events?after=${startDay}&before=${endDay}&limit=80`;
    if (camera && camera !== 'all') frigateUrl += `&cameras=${camera}`;

    const fRes = await globalThis.fetch(frigateUrl);
    const events = fRes.ok ? await fRes.json() : [];

    const validEvents = events.filter(e => {
      const dur = e.end_time ? (e.end_time - e.start_time) : 0;
      return dur >= 3;
    });

    if (validEvents.length === 0) {
      return res.json({
        success: true,
        briefing: {
          title: `Laporan Intelijen Keamanan SkyGuard - ${targetDate}`,
          totalEvents: 0,
          overallRisk: 'Rendah',
          executiveSummary: `Kondisi aman dan kondusif. Tidak ada rekaman kejadian pergerakan mencurigakan yang terdeteksi pada tanggal ${targetDate}.`,
          peakHours: 'Nihil / Tenang',
          keyHighlights: [
            'Tidak ada objek (orang/kendaraan) yang melanggar batas pemantauan.',
            'Semua feed kamera beroperasi normal tanpa peringatan bahaya.'
          ],
          securityRecommendations: [
            'Pertahankan pemantauan berkala pada jam malam.',
            'Pastikan konektivitas kamera dan sinkronisasi cloud tetap aktif.'
          ]
        }
      });
    }

    const promptText = `Kamu adalah SkyGuard AI - Chief Security Intelligence Analyst.
Buat laporan ringkasan keamanan eksekutif ("Daily Surveillance Intelligence Briefing") untuk tanggal ${targetDate} WIB:
- Total Kejadian Terdeteksi (> 3 detik): ${validEvents.length}
- Kamera yang Terpantau: ${[...new Set(validEvents.map(e => e.camera))].join(', ') || 'Semua Kamera'}
- Sampel Kejadian Utama: ${JSON.stringify(validEvents.slice(0, 15).map(e => ({
  cam: e.camera,
  label: e.label,
  time: new Date(e.start_time * 1000).toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta' }),
  dur: e.end_time ? Math.round(e.end_time - e.start_time) + 's' : 'active'
})))}

Format respon dalam JSON valid:
{
  "title": "Laporan Intelijen Keamanan SkyGuard - ${targetDate}",
  "totalEvents": ${validEvents.length},
  "overallRisk": "Rendah" | "Sedang" | "Tinggi",
  "executiveSummary": "Ringkasan situasi keamanan hari ini secara komprehensif (2-3 kalimat)",
  "peakHours": "Waktu/jam dengan aktivitas tertinggi",
  "keyHighlights": ["Poin penting 1", "Poin penting 2", "Poin penting 3"],
  "securityRecommendations": ["Rekomendasi 1", "Rekomendasi 2"]
}`;

    const briefing = await requestGeminiGenerate([{ text: promptText }]);
    res.json({ success: true, briefing });

  } catch (err) {
    console.error('AI Daily Briefing Error:', err);
    res.status(500).json({ error: 'Failed to generate daily briefing', details: err.message });
  }
});

// Single event details (With ParadeDB Fallback)
app.get('/api/events/:id', requireAuth, async (req, res) => {
  try {
    const eventId = req.params.id;
    let data = null;

    // 1. Check frigate_events first
    try {
      const dbEv = await pool.query('SELECT * FROM frigate_events WHERE id = $1 LIMIT 1;', [eventId]);
      if (dbEv.rows.length > 0) {
        const r = dbEv.rows[0];
        data = {
          id: r.id,
          camera: r.camera,
          label: r.label,
          top_score: r.top_score,
          score: r.score,
          start_time: Number(r.start_time),
          end_time: r.end_time ? Number(r.end_time) : null,
          duration: Number(r.duration) || 10,
          has_clip: r.has_clip !== false,
          has_snapshot: r.has_snapshot === true,
          data: r.data || {}
        };
      }
    } catch (_) {}

    // 2. Check Frigate
    if (!data) {
      try {
        const fRes = await globalThis.fetch(`${FRIGATE_URL}/api/events/${eventId}`, { signal: AbortSignal.timeout(2000) });
        if (fRes.ok) data = await fRes.json();
      } catch (_) {}
    }

    // 3. Check recordfrigate
    if (!data) {
      const dbRes = await pool.query('SELECT * FROM recordfrigate WHERE id = $1 LIMIT 1;', [eventId]);
      if (dbRes.rows.length > 0) {
        const r = dbRes.rows[0];
        data = {
          id: r.id,
          camera: r.camera,
          label: (r.objects && r.objects > 0) ? 'person' : 'motion',
          start_time: Number(r.start_time),
          end_time: Number(r.end_time),
          duration: Number(r.duration) || 10,
          has_clip: true,
          data: { score: (r.objects && r.objects > 0) ? 0.85 : 0.70 }
        };
      }
    }

    if (!data) return res.status(404).send('Event not found');
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch event detail', details: err.message });
  }
});

// Event Thumbnail Proxy (With ParadeDB & Clean SVG Fallback)
app.get('/api/events/:id/thumbnail.webp', requireAuth, async (req, res) => {
  try {
    const eventId = req.params.id;

    // 1. Check ParadeDB frigate_events first (< 1ms instant!)
    try {
      const dbRes = await pool.query('SELECT thumbnail_base64 FROM frigate_events WHERE id = $1 LIMIT 1;', [eventId]);
      if (dbRes.rows.length > 0 && dbRes.rows[0].thumbnail_base64) {
        res.setHeader('Content-Type', 'image/webp');
        res.setHeader('Cache-Control', 'public, max-age=86400');
        const buffer = Buffer.from(dbRes.rows[0].thumbnail_base64, 'base64');
        return res.send(buffer);
      }
    } catch (_) {}

    // 2. Fallback to Frigate
    try {
      const fRes = await globalThis.fetch(`${FRIGATE_URL}/api/events/${eventId}/thumbnail.webp`, { signal: AbortSignal.timeout(2000) });
      if (fRes.ok) {
        res.setHeader('Content-Type', 'image/webp');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        const buffer = await fRes.arrayBuffer();
        return res.send(Buffer.from(buffer));
      }
    } catch (_) {}

    try {
      const snapRes = await globalThis.fetch(`${FRIGATE_URL}/api/events/${eventId}/snapshot.jpg`, { signal: AbortSignal.timeout(2000) });
      if (snapRes.ok) {
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        const buffer = await snapRes.arrayBuffer();
        return res.send(Buffer.from(buffer));
      }
    } catch (_) {}

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
      <rect width="320" height="180" fill="#0b111e"/>
      <circle cx="160" cy="90" r="26" fill="#1e293b"/>
      <polygon points="153,77 173,90 153,103" fill="#38bdf8"/>
      <text x="160" y="140" fill="#94a3b8" font-size="11" font-family="sans-serif" text-anchor="middle">S3 RustFS Recording</text>
    </svg>`;
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(svg);
  } catch (err) {
    res.status(200).send('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#0b111e"/></svg>');
  }
});

// Event Snapshot Proxy (With Clean SVG Fallback)
app.get('/api/events/:id/snapshot.jpg', requireAuth, async (req, res) => {
  try {
    const eventId = req.params.id;
    try {
      const fRes = await globalThis.fetch(`${FRIGATE_URL}/api/events/${eventId}/snapshot.jpg`, { signal: AbortSignal.timeout(2000) });
      if (fRes.ok) {
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        const buffer = await fRes.arrayBuffer();
        return res.send(Buffer.from(buffer));
      }
    } catch (_) {}

    try {
      const thumbRes = await globalThis.fetch(`${FRIGATE_URL}/api/events/${eventId}/thumbnail.webp`, { signal: AbortSignal.timeout(2000) });
      if (thumbRes.ok) {
        res.setHeader('Content-Type', 'image/webp');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        const buffer = await thumbRes.arrayBuffer();
        return res.send(Buffer.from(buffer));
      }
    } catch (_) {}

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
      <rect width="320" height="180" fill="#0b111e"/>
      <circle cx="160" cy="90" r="26" fill="#1e293b"/>
      <polygon points="153,77 173,90 153,103" fill="#38bdf8"/>
      <text x="160" y="140" fill="#94a3b8" font-size="11" font-family="sans-serif" text-anchor="middle">S3 RustFS Recording</text>
    </svg>`;
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(svg);
  } catch (err) {
    res.status(200).send('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180" fill="#0b111e"/></svg>');
  }
});

// --- API: S3 RUSTFS EVENT RECORDING PLAYBACK (POWERED BY PARADEDB) ---
// Finds all S3 recording segments for a given Frigate event using ParadeDB (0% OpenWrt CPU)
app.get('/api/events/:id/s3-recording', requireAuth, async (req, res) => {
  try {
    const eventId = req.params.id;

    // 1. Get event metadata - check local ParadeDB first (< 1ms)!
    let event = null;
    try {
      const dbRes = await pool.query('SELECT camera, path, start_time, end_time, duration FROM recordfrigate WHERE id = $1 LIMIT 1;', [eventId]);
      if (dbRes.rows.length > 0) {
        event = dbRes.rows[0];
      }
    } catch (_) {}

    if (!event) {
      try {
        const fRes = await globalThis.fetch(`${FRIGATE_URL}/api/events/${eventId}`, { signal: AbortSignal.timeout(2000) });
        if (fRes.ok) event = await fRes.json();
      } catch (_) {}
    }

    if (!event || !event.camera || !event.start_time) {
      return res.status(404).json({ error: 'Event metadata not found' });
    }

    const camera = event.camera;
    const startTime = Number(event.start_time) - 1.0;
    const endTime = Number(event.end_time || (event.start_time + (event.duration || 10))) + 1.0;
    const duration = Math.round(endTime - startTime);

    // 2. Query ParadeDB for matching recording segments in S3 RustFS
    const querySql = `
      SELECT id, camera, path, start_time, end_time, duration, segment_size
      FROM recordfrigate
      WHERE camera = $1
        AND start_time <= $3
        AND (end_time >= $2 OR (start_time + duration) >= $2)
      ORDER BY start_time ASC;
    `;
    const result = await pool.query(querySql, [camera, startTime, endTime]);

    if (!result.rows || result.rows.length === 0) {
      return res.json({
        success: false,
        source: 's3_rustfs',
        message: 'Segmen video kejadian ini sedang dalam proses sinkronisasi ke S3 RustFS.',
        camera,
        startTime,
        endTime,
        duration,
        segments: []
      });
    }

    const segments = result.rows.map(r => {
      const key = r.path.replace(/^\/media\/frigate\//, '');
      return {
        id: r.id,
        key: key,
        camera: r.camera,
        startTime: r.start_time,
        endTime: r.end_time,
        duration: Math.round(r.duration || (r.end_time - r.start_time) || 10),
        sizeBytes: r.segment_size,
        streamUrl: `/api/recordings/stream?key=${encodeURIComponent(key)}`
      };
    });

    res.json({
      success: true,
      source: 's3_rustfs',
      eventId,
      camera,
      startTime: event.start_time,
      endTime: event.end_time,
      duration: event.duration || duration,
      segments
    });

  } catch (err) {
    console.error('Error fetching S3 segments for event:', err);
    res.status(500).json({ error: 'Failed to find S3 segments in ParadeDB', details: err.message });
  }
});

// Event Clip Stream - ALWAYS DIRECTLY FROM AWS S3 RUSTFS (Zero OpenWrt CPU usage!)
app.get('/api/events/:id/clip.mp4', requireAuth, async (req, res) => {
  try {
    const eventId = req.params.id;
    const range = req.headers.range;

    // 1. Check local ParadeDB first for instant exact path (< 1ms)!
    let key = null;
    try {
      const dbRes = await pool.query('SELECT path FROM recordfrigate WHERE id = $1 LIMIT 1;', [eventId]);
      if (dbRes.rows.length > 0) {
        key = dbRes.rows[0].path.replace(/^\/media\/frigate\//, '');
      }
    } catch (_) {}

    // 2. If not found by direct ID, search by camera and time window
    if (!key) {
      let event = null;
      try {
        const fRes = await globalThis.fetch(`${FRIGATE_URL}/api/events/${eventId}`, { signal: AbortSignal.timeout(2000) });
        if (fRes.ok) event = await fRes.json();
      } catch (_) {}

      if (event && event.camera && event.start_time) {
        const camera = event.camera;
        const startTime = Number(event.start_time) - 1.0;
        const endTime = Number(event.end_time || (event.start_time + (event.duration || 10))) + 1.0;

        const querySql = `
          SELECT path, start_time, end_time, duration
          FROM recordfrigate
          WHERE camera = $1
            AND start_time <= $3
            AND (end_time >= $2 OR (start_time + duration) >= $2)
          ORDER BY start_time ASC
          LIMIT 1;
        `;
        const result = await pool.query(querySql, [camera, startTime, endTime]);
        if (result.rows && result.rows.length > 0) {
          key = result.rows[0].path.replace(/^\/media\/frigate\//, '');
        }
      }
    }

    if (!key) {
      return res.status(404).send('Rekaman kejadian belum tersedia di AWS S3 RustFS');
    }

    // 3. Stream directly from AWS S3 RustFS with Range support (Zero OpenWrt CPU!)
    const command = new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Range: range || undefined
    });

    const s3Response = await s3.send(command);

    res.setHeader('X-Storage-Source', 's3_rustfs');
    res.setHeader('X-S3-Synced', 'true');

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

    return s3Response.Body.pipe(res);

  } catch (err) {
    console.error(`Error streaming S3 clip for event ${req.params.id}:`, err.message);
    res.status(500).send(`S3 streaming error: ${err.message}`);
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

// --- API: EVENTS BATCH SYNC TO PARADEDB (Called from OpenWrt) ---
app.post('/api/events/batch-sync', async (req, res) => {
  const syncKey = req.headers['x-sync-key'] || req.query.key;
  if (syncKey !== SYNC_KEY) {
    return res.status(401).json({ error: 'Invalid or missing X-Sync-Key' });
  }

  const events = Array.isArray(req.body) ? req.body : (req.body.events || []);
  if (!events.length) {
    return res.json({ success: true, count: 0, message: 'Empty events batch' });
  }

  try {
    const ids = [];
    const cameras = [];
    const labels = [];
    const subLabels = [];
    const topScores = [];
    const scores = [];
    const startTimes = [];
    const endTimes = [];
    const durations = [];
    const hasClips = [];
    const hasSnapshots = [];
    const dates = [];
    const times = [];
    const thumbs = [];
    const dataList = [];

    for (const e of events) {
      if (!e.id || !e.camera || !e.label) continue;

      const startTime = Number(e.start_time) || 0;
      const endTime = e.end_time ? Number(e.end_time) : null;
      const dur = (endTime && startTime) ? Math.max(0, endTime - startTime) : (Number(e.duration) || 0);

      const startDate = startTime ? new Date(startTime * 1000) : new Date();
      const dateStr = e.date || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(startDate);
      const timeStr = e.time || new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(startDate);

      ids.push(String(e.id));
      cameras.push(String(e.camera));
      labels.push(String(e.label));
      subLabels.push(e.sub_label ? String(e.sub_label) : null);
      topScores.push(e.top_score !== undefined && e.top_score !== null ? Number(e.top_score) : null);
      scores.push(e.score !== undefined && e.score !== null ? Number(e.score) : null);
      startTimes.push(startTime);
      endTimes.push(endTime);
      durations.push(dur);
      hasClips.push(e.has_clip !== false);
      hasSnapshots.push(e.has_snapshot === true);
      dates.push(dateStr);
      times.push(timeStr);
      thumbs.push(e.thumbnail_base64 || null);
      dataList.push(e.data ? (typeof e.data === 'string' ? e.data : JSON.stringify(e.data)) : null);
    }

    if (!ids.length) {
      return res.json({ success: true, count: 0 });
    }

    const query = `
      INSERT INTO frigate_events (
        id, camera, label, sub_label, top_score, score, start_time, end_time, duration,
        has_clip, has_snapshot, date, time, thumbnail_base64, data
      )
      SELECT * FROM UNNEST(
        $1::text[],
        $2::text[],
        $3::text[],
        $4::text[],
        $5::real[],
        $6::real[],
        $7::float8[],
        $8::float8[],
        $9::real[],
        $10::bool[],
        $11::bool[],
        $12::text[],
        $13::text[],
        $14::text[],
        $15::jsonb[]
      )
      ON CONFLICT (id) DO UPDATE SET
        end_time = EXCLUDED.end_time,
        duration = EXCLUDED.duration,
        top_score = COALESCE(EXCLUDED.top_score, frigate_events.top_score),
        score = COALESCE(EXCLUDED.score, frigate_events.score),
        thumbnail_base64 = COALESCE(EXCLUDED.thumbnail_base64, frigate_events.thumbnail_base64),
        data = COALESCE(EXCLUDED.data, frigate_events.data);
    `;

    await pool.query(query, [
      ids,
      cameras,
      labels,
      subLabels,
      topScores,
      scores,
      startTimes,
      endTimes,
      durations,
      hasClips,
      hasSnapshots,
      dates,
      times,
      thumbs,
      dataList
    ]);

    res.json({ success: true, count: ids.length });
  } catch (err) {
    console.error('Events batch sync error:', err);
    res.status(500).json({ error: 'Database insertion error', details: err.message });
  }
});

// --- API: PRUNE EXPIRED RECORDINGS FROM PARADEDB (Mirror Quota Retention) ---
app.post('/api/recordings/prune', async (req, res) => {
  const syncKey = req.headers['x-sync-key'] || req.query.key;
  if (syncKey !== SYNC_KEY) {
    return res.status(401).json({ error: 'Invalid or missing X-Sync-Key' });
  }

  const { before_time, before_date, paths } = req.body || {};

  try {
    let deletedCount = 0;
    if (before_time) {
      const result = await pool.query('DELETE FROM recordfrigate WHERE start_time <= $1;', [Number(before_time)]);
      deletedCount = result.rowCount || 0;
    } else if (before_date) {
      const result = await pool.query('DELETE FROM recordfrigate WHERE date < $1;', [String(before_date)]);
      deletedCount = result.rowCount || 0;
    } else if (Array.isArray(paths) && paths.length > 0) {
      const cleanPaths = paths.map(p => p.replace(/^\/media\/frigate\//, ''));
      const result = await pool.query('DELETE FROM recordfrigate WHERE path = ANY($1::text[]);', [cleanPaths]);
      deletedCount = result.rowCount || 0;
    } else {
      return res.status(400).json({ error: 'Missing before_time, before_date, or paths parameter' });
    }

    console.log(`[PRUNE] Deleted ${deletedCount} records from ParadeDB to match OpenWrt 250GB quota.`);
    res.json({ success: true, deleted_count: deletedCount });
  } catch (err) {
    console.error('Prune error:', err);
    res.status(500).json({ error: 'Database prune error', details: err.message });
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
      const camList = camera.split(',').map(c => c.trim()).filter(Boolean);
      if (camList.length === 1) {
        sql += ` AND camera = $${pIdx++}`;
        params.push(camList[0]);
      } else if (camList.length > 1) {
        const placeholders = camList.map(() => `$${pIdx++}`).join(', ');
        sql += ` AND camera IN (${placeholders})`;
        params.push(...camList);
      }
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

      // S3 sync status check (dates before 2026-10-23 or 2026-10-23 hours <= 14 are in S3)
      const isSynced = r.date < '2026-10-23' || (r.date === '2026-10-23' && parseInt(r.hour, 10) <= 14);

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
        endTime: r.end_time,
        s3Synced: isSynced
      };
    });

    const validFiles = files.filter(f => (f.duration !== undefined ? f.duration >= 3 : true));
    const sessions = groupIntoSessions(validFiles);
    return res.json({ files: validFiles, sessions, count: validFiles.length, sessionCount: sessions.length, source: 'paradedb' });
  } catch (err) {
    console.warn('ParadeDB list query failed, falling back to S3:', err.message);
  }

  // Fallback: S3 ListObjectsV2
  try {
    let prefix = `recordings/${date}/`;
    if (hour !== undefined && hour !== '') {
      const paddedHour = String(hour).padStart(2, '0');
      prefix += `${paddedHour}/`;
      const camList = camera && camera !== 'all' ? camera.split(',').map(c => c.trim()).filter(Boolean) : [];
      if (camList.length === 1) {
        prefix += `${camList[0]}/`;
      }
    }

    const command = new ListObjectsV2Command({
      Bucket: S3_BUCKET,
      Prefix: prefix,
      MaxKeys: 1000
    });

    const data = await s3.send(command);
    const camList = camera && camera !== 'all' ? camera.split(',').map(c => c.trim()).filter(Boolean) : [];
    const files = (data.Contents || []).filter(item => {
      if (!item.Key.endsWith('.mp4')) return false;
      if (camList.length > 0) {
        return camList.some(c => item.Key.includes(`/${c}/`));
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
        lastModified: item.LastModified,
        duration: 10,
        s3Synced: true
      };
    }).sort((a, b) => b.key.localeCompare(a.key));

    const validFiles = files.filter(f => (f.duration !== undefined ? f.duration >= 3 : true));
    const sessions = groupIntoSessions(validFiles);
    res.json({ files: validFiles, sessions, count: validFiles.length, sessionCount: sessions.length, prefix, source: 's3' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to query recordings from S3', details: err.message });
  }
});

// Dynamic HLS Playlist for Continuous Playback of Sessions
app.get('/api/recordings/playlist.m3u8', requireAuth, (req, res) => {
  const { keys } = req.query;
  let keyList = [];
  try {
    keyList = JSON.parse(keys);
  } catch (_) {
    keyList = (keys || '').split(',').map(s => s.trim()).filter(Boolean);
  }

  if (!keyList.length) {
    return res.status(400).send('No keys provided');
  }

  let m3u8 = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:12\n#EXT-X-MEDIA-SEQUENCE:0\n';
  for (const k of keyList) {
    m3u8 += `#EXTINF:10.0,\n/api/recordings/stream?key=${encodeURIComponent(k)}\n`;
  }
  m3u8 += '#EXT-X-ENDLIST\n';

  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Content-Disposition', 'inline; filename="session.m3u8"');
  res.send(m3u8);
});

// HEAD check for quick sync verification
app.head('/api/recordings/stream', requireAuth, async (req, res) => {
  const key = req.query.key;
  if (!key) return res.status(400).end();

  try {
    const head = await s3.send(new HeadObjectCommand({
      Bucket: S3_BUCKET,
      Key: key
    }));
    res.setHeader('X-Storage-Source', 's3');
    res.setHeader('X-S3-Synced', 'true');
    res.setHeader('Content-Type', head.ContentType || 'video/mp4');
    res.setHeader('Content-Length', head.ContentLength || 0);
    res.setHeader('Accept-Ranges', 'bytes');
    return res.status(200).end();
  } catch (err) {
    // S3 NotFound -> check local OpenWrt Frigate
    try {
      const openwrtUrl = `http://100.65.136.42:5000/${key}`;
      const fRes = await globalThis.fetch(openwrtUrl, { method: 'HEAD' });
      if (fRes.ok) {
        res.setHeader('X-Storage-Source', 'openwrt-local');
        res.setHeader('X-S3-Synced', 'false');
        res.setHeader('Content-Type', fRes.headers.get('content-type') || 'video/mp4');
        res.setHeader('Content-Length', fRes.headers.get('content-length') || 0);
        res.setHeader('Accept-Ranges', 'bytes');
        return res.status(200).end();
      }
    } catch (_) {}
    res.setHeader('X-S3-Synced', 'false');
    res.status(404).end();
  }
});

// Stream MP4 Video from S3 (with OpenWrt fallback for fresh unsynced recordings)
app.get('/api/recordings/stream', requireAuth, async (req, res) => {
  const key = req.query.key;
  if (!key) {
    return res.status(400).send('Missing key parameter');
  }

  const range = req.headers.range;

  // 1. Try S3 first
  try {
    const command = new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      Range: range || undefined
    });

    const s3Response = await s3.send(command);

    res.setHeader('X-Storage-Source', 's3');
    res.setHeader('X-S3-Synced', 'true');

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

    return s3Response.Body.pipe(res);
  } catch (s3Err) {
    console.warn(`S3 stream error for ${key}:`, s3Err.message);
    res.status(404).send(`Video segment not found in AWS S3 RustFS: ${s3Err.message}`);
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
