const express = require('express');
const { engine } = require('express-handlebars');
const cookieParser = require('cookie-parser');
const path = require('path');
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require('@aws-sdk/client-s3');

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

// Middleware
app.use(express.text({ type: ['text/*', 'application/sdp'] }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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

// --- API: S3 RECORDINGS ARCHIVE ---
// List distinct dates in S3
app.get('/api/recordings/dates', requireAuth, async (req, res) => {
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

    res.json({ dates: prefixes });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list dates from S3', details: err.message });
  }
});

// List recordings by camera and date
app.get('/api/recordings/list', requireAuth, async (req, res) => {
  try {
    const { camera, date, hour } = req.query;
    if (!date) {
      return res.status(400).json({ error: 'Date parameter is required (YYYY-MM-DD)' });
    }

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
      // Key format: recordings/2026-10-24/12/camera_02/15.22.mp4
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
    }).sort((a, b) => b.key.localeCompare(a.key)); // newest first

    res.json({ files, count: files.length, prefix });
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
  console.log(`  S3 Endpoint: ${S3_ENDPOINT} (Bucket: ${S3_BUCKET})`);
  console.log(`  go2rtc Relay: ${GO2RTC_URL}`);
  console.log(`=======================================================`);
});
