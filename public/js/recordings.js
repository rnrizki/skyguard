/**
 * SkyGuard S3 Recordings Archive Controller
 * Queries RustFS S3 storage index, displays clips, and plays video with byte-range scrubbing
 */

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('recordings-filter-form');
  const dateSelect = document.getElementById('filter-date');
  const cameraSelect = document.getElementById('filter-camera');
  const hourSelect = document.getElementById('filter-hour');
  const resultsCount = document.getElementById('results-count');
  const resultsEmpty = document.getElementById('results-empty');
  const resultsLoading = document.getElementById('results-loading');
  const clipsGrid = document.getElementById('clips-grid');
  const modal = document.getElementById('video-modal');

  // Load available dates from S3 bucket
  loadAvailableDates();

  async function loadAvailableDates() {
    try {
      const res = await fetch('/api/recordings/dates');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      const syncBadge = document.getElementById('sync-badge');
      if (syncBadge && data.source === 'paradedb') {
        syncBadge.textContent = 'ParadeDB High-Speed Index (Active)';
      }

      dateSelect.innerHTML = '';
      if (data.dates && data.dates.length > 0) {
        data.dates.forEach(d => {
          const opt = document.createElement('option');
          opt.value = d;
          opt.textContent = d;
          dateSelect.appendChild(opt);
        });

        // Trigger initial search for the latest date
        searchRecordings();
      } else {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = 'No recorded dates found';
        dateSelect.appendChild(opt);
      }
    } catch (err) {
      console.error('Failed to load dates:', err);
      dateSelect.innerHTML = '<option value="">Error loading dates</option>';
    }
  }

  // Handle filter submit
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    searchRecordings();
  });

  async function searchRecordings() {
    const camera = cameraSelect.value;
    const date = dateSelect.value;
    const hour = hourSelect.value;

    if (!date) return;

    // Show loading UI
    resultsLoading.style.display = 'block';
    resultsEmpty.style.display = 'none';
    clipsGrid.style.display = 'none';
    resultsCount.textContent = 'Searching S3...';

    try {
      const queryParams = new URLSearchParams({ date });
      if (camera && camera !== 'all') queryParams.append('camera', camera);
      if (hour !== '') queryParams.append('hour', hour);

      const res = await fetch(`/api/recordings/list?${queryParams.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      resultsLoading.style.display = 'none';

      if (!data.files || data.files.length === 0) {
        resultsEmpty.style.display = 'block';
        resultsEmpty.querySelector('p').textContent = `No video clips found for date ${date} with selected filters.`;
        resultsCount.textContent = '0 clips found';
        return;
      }

      resultsCount.textContent = `${data.files.length} clips found`;
      renderClips(data.files);
      clipsGrid.style.display = 'grid';

    } catch (err) {
      console.error('Search failed:', err);
      resultsLoading.style.display = 'none';
      resultsEmpty.style.display = 'block';
      resultsEmpty.querySelector('p').textContent = `Error loading recordings: ${err.message}`;
      resultsCount.textContent = 'Error';
    }
  }

  function renderClips(files) {
    clipsGrid.innerHTML = '';
    files.forEach(file => {
      const card = document.createElement('div');
      card.className = 'clip-card';

      // Camera display name formatting
      const camName = file.camera.replace(/_/g, ' ').toUpperCase();

      // Object detection & motion badges
      let badgesHtml = '';
      if (file.objects && file.objects > 0) {
        badgesHtml += `<span class="badge-obj" title="${file.objects} object detections">🎯 ${file.objects} obj</span>`;
      }
      if (file.motion && file.motion > 0) {
        badgesHtml += `<span class="badge-motion" title="Motion detected">⚡ Motion</span>`;
      }

      card.innerHTML = `
        <div class="clip-thumbnail" onclick="playRecording('${file.key}', '${camName}', '${file.date} ${file.time}', '${file.sizeFormatted}')">
          <div class="clip-aspect-wrapper">
            <svg class="clip-play-icon" viewBox="0 0 24 24" width="36" height="36" fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3"></polygon>
            </svg>
            <span class="clip-badge-time">${file.time}</span>
          </div>
        </div>
        <div class="clip-info">
          <div class="clip-meta">
            <span class="clip-camera">${camName}</span>
            <div style="display:flex;gap:4px;align-items:center;">
              ${badgesHtml}
              <span class="clip-size">${file.sizeFormatted}</span>
            </div>
          </div>
          <div class="clip-actions">
            <button class="btn btn-primary btn-xs" onclick="playRecording('${file.key}', '${camName}', '${file.date} ${file.time}', '${file.sizeFormatted}')">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg> Play
            </button>
            <a href="/api/recordings/stream?key=${encodeURIComponent(file.key)}" download class="btn btn-secondary btn-xs" title="Download clip">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
            </a>
          </div>
        </div>
      `;
      clipsGrid.appendChild(card);
    });
  }

  // Keyboard escape listener to close video modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.style.display !== 'none') {
      window.closeVideoModal();
    }
  });
});

// Modal playback controls
window.playRecording = function(key, camera, timeStr, sizeStr) {
  const modal = document.getElementById('video-modal');
  const player = document.getElementById('modal-video-player');
  const title = document.getElementById('modal-video-title');
  const subtitle = document.getElementById('modal-video-subtitle');
  const downloadBtn = document.getElementById('modal-download-btn');

  const streamUrl = `/api/recordings/stream?key=${encodeURIComponent(key)}`;

  title.textContent = `${camera} Recording`;
  subtitle.textContent = `${timeStr} (${sizeStr})`;
  downloadBtn.href = streamUrl;

  player.src = streamUrl;
  player.playbackRate = 1.0;
  window.resetSpeedButtons();

  modal.style.display = 'flex';
  player.play().catch(e => console.warn('Modal autoplay blocked:', e));
};

window.closeVideoModal = function() {
  const modal = document.getElementById('video-modal');
  const player = document.getElementById('modal-video-player');
  if (player) {
    player.pause();
    player.src = '';
  }
  if (modal) {
    modal.style.display = 'none';
  }
};

window.setSpeed = function(speed) {
  const player = document.getElementById('modal-video-player');
  if (player) {
    player.playbackRate = speed;
  }
  document.querySelectorAll('.speed-btn').forEach(btn => {
    btn.classList.toggle('active', btn.textContent === `${speed.toFixed(1)}x`);
  });
};

window.resetSpeedButtons = function() {
  document.querySelectorAll('.speed-btn').forEach(btn => {
    btn.classList.toggle('active', btn.textContent === '1.0x');
  });
};
