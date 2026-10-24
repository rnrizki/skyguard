/**
 * SkyGuard S3 Recordings Archive Controller
 * Unified Continuous Event/Session Playback, Frigate Radio Selector, Real Thumbnails & S3 Sync Verification
 */

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('recordings-filter-form');
  const dateSelect = document.getElementById('filter-date');
  const cameraInput = document.getElementById('filter-camera');
  const hourSelect = document.getElementById('filter-hour');
  const resultsCount = document.getElementById('results-count');
  const resultsEmpty = document.getElementById('results-empty');
  const resultsLoading = document.getElementById('results-loading');
  const clipsGrid = document.getElementById('clips-grid');
  const modal = document.getElementById('video-modal');

  // View Mode Controls (Video Utuh / Sesi vs Segmen 10s)
  const btnModeSessions = document.getElementById('btn-mode-sessions');
  const btnModeSegments = document.getElementById('btn-mode-segments');
  let currentViewMode = 'sessions'; // default to unified continuous video sessions
  let loadedFiles = [];
  let loadedSessions = [];

  if (btnModeSessions && btnModeSegments) {
    btnModeSessions.addEventListener('click', () => {
      if (currentViewMode !== 'sessions') {
        currentViewMode = 'sessions';
        btnModeSessions.classList.add('active');
        btnModeSegments.classList.remove('active');
        renderResults();
      }
    });

    btnModeSegments.addEventListener('click', () => {
      if (currentViewMode !== 'segments') {
        currentViewMode = 'segments';
        btnModeSegments.classList.add('active');
        btnModeSessions.classList.remove('active');
        renderResults();
      }
    });
  }

  // Frigate-Style Camera Popover Controls
  const cameraBtn = document.getElementById('camera-dropdown-btn');
  const cameraPopover = document.getElementById('camera-popover');
  const selectedCameraText = document.getElementById('selected-camera-text');
  const radioItems = document.querySelectorAll('.camera-radio-item');
  const btnApply = document.getElementById('btn-camera-apply');
  const btnReset = document.getElementById('btn-camera-reset');

  let activeCamera = cameraInput.value || 'all';
  let pendingCamera = activeCamera;
  let pendingCameraName = 'All Cameras';

  // Toggle Camera Popover
  if (cameraBtn && cameraPopover) {
    cameraBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isVisible = cameraPopover.style.display === 'block';
      cameraPopover.style.display = isVisible ? 'none' : 'block';
      cameraBtn.classList.toggle('open', !isVisible);
    });

    // Close popover when clicking outside
    document.addEventListener('click', (e) => {
      if (!cameraPopover.contains(e.target) && !cameraBtn.contains(e.target)) {
        cameraPopover.style.display = 'none';
        cameraBtn.classList.remove('open');
      }
    });

    // Camera Radio Switch Selection
    radioItems.forEach(item => {
      item.addEventListener('click', () => {
        const camId = item.getAttribute('data-cam');
        const camName = item.getAttribute('data-name');
        pendingCamera = camId;
        pendingCameraName = camName;

        // Update active UI switch
        radioItems.forEach(i => {
          const isSelected = i.getAttribute('data-cam') === camId;
          i.classList.toggle('active', isSelected);
          const pill = i.querySelector('.toggle-pill');
          if (pill) pill.classList.toggle('active', isSelected);
        });
      });
    });

    // Apply button
    if (btnApply) {
      btnApply.addEventListener('click', () => {
        activeCamera = pendingCamera;
        cameraInput.value = activeCamera;
        selectedCameraText.textContent = pendingCameraName;
        cameraPopover.style.display = 'none';
        cameraBtn.classList.remove('open');
        searchRecordings();
      });
    }

    // Reset button
    if (btnReset) {
      btnReset.addEventListener('click', () => {
        activeCamera = 'all';
        pendingCamera = 'all';
        pendingCameraName = 'All Cameras';
        cameraInput.value = 'all';
        selectedCameraText.textContent = 'All Cameras';

        radioItems.forEach(i => {
          const isAll = i.getAttribute('data-cam') === 'all';
          i.classList.toggle('active', isAll);
          const pill = i.querySelector('.toggle-pill');
          if (pill) pill.classList.toggle('active', isAll);
        });

        cameraPopover.style.display = 'none';
        cameraBtn.classList.remove('open');
        searchRecordings();
      });
    }
  }

  // Load available dates from ParadeDB / S3
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
    const camera = cameraInput.value;
    const date = dateSelect.value;
    const hour = hourSelect.value;

    if (!date) return;

    // Show loading UI
    resultsLoading.style.display = 'block';
    resultsEmpty.style.display = 'none';
    clipsGrid.style.display = 'none';
    resultsCount.textContent = 'Searching ParadeDB...';

    try {
      const queryParams = new URLSearchParams({ date });
      if (camera && camera !== 'all') queryParams.append('camera', camera);
      if (hour !== '') queryParams.append('hour', hour);

      const res = await fetch(`/api/recordings/list?${queryParams.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      resultsLoading.style.display = 'none';

      loadedFiles = data.files || [];
      loadedSessions = data.sessions || [];

      if (!loadedFiles.length) {
        resultsEmpty.style.display = 'block';
        resultsEmpty.querySelector('p').textContent = `No video clips found for date ${date} with selected filters.`;
        resultsCount.textContent = '0 clips found';
        return;
      }

      renderResults();
      clipsGrid.style.display = 'grid';

    } catch (err) {
      console.error('Search failed:', err);
      resultsLoading.style.display = 'none';
      resultsEmpty.style.display = 'block';
      resultsEmpty.querySelector('p').textContent = `Error loading recordings: ${err.message}`;
      resultsCount.textContent = 'Error';
    }
  }

  function renderResults() {
    if (currentViewMode === 'sessions') {
      resultsCount.textContent = `${loadedSessions.length} Video Kejadian/Sesi Utuh (${loadedFiles.length} segmen)`;
      renderSessions(loadedSessions);
    } else {
      resultsCount.textContent = `${loadedFiles.length} Segmen 10 Detik`;
      renderClips(loadedFiles);
    }
  }

  // IntersectionObserver for lazy-loading video frame thumbnails
  let videoObserver = null;
  function initVideoObserver() {
    if (videoObserver) {
      videoObserver.disconnect();
    }

    videoObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const video = entry.target;
          if (video.dataset.src && !video.src) {
            video.src = video.dataset.src;
            video.load();

            video.addEventListener('loadedmetadata', () => {
              // Ensure frame paints immediately in Safari / WebKit
              video.currentTime = 0.5;
            });

            video.onloadeddata = () => {
              video.style.opacity = '1';
            };

            video.onerror = () => {
              const card = video.closest('.clip-card');
              if (card) {
                const syncBadge = card.querySelector('.badge-sync');
                if (syncBadge && !syncBadge.classList.contains('badge-s3-synced')) {
                  syncBadge.className = 'badge-sync badge-s3-missing';
                  syncBadge.textContent = '❌ Offline';
                }
              }
            };
          }
          observer.unobserve(video);
        }
      });
    }, {
      rootMargin: '150px 0px'
    });
  }

  // RENDER CONTINUOUS SESSIONS (VIDEO UTUH KEJADIAN)
  function renderSessions(sessions) {
    clipsGrid.innerHTML = '';
    initVideoObserver();

    sessions.forEach((session, sIdx) => {
      const card = document.createElement('div');
      card.className = `clip-card session-card ${session.totalObjects > 0 ? 'has-event' : ''}`;

      const camName = session.camera.replace(/_/g, ' ').toUpperCase();

      // Detection badges
      let badgesHtml = '';
      if (session.totalObjects > 0) {
        badgesHtml += `<span class="badge-obj" title="${session.totalObjects} deteksi objek dalam kejadian ini">🎯 ${session.totalObjects} obj</span>`;
      }
      if (session.hasMotion) {
        badgesHtml += `<span class="badge-motion" title="Pergerakan terdeteksi">⚡ Motion</span>`;
      }

      // S3 Sync Status Badge
      const isSynced = session.s3Synced === true;
      const syncBadgeClass = isSynced ? 'badge-s3-synced' : 'badge-s3-pending';
      const syncBadgeText = isSynced ? '☁️ S3 Synced' : '⏳ Local (Pending S3)';

      const streamUrl = `/api/recordings/stream?key=${encodeURIComponent(session.key)}`;

      card.innerHTML = `
        <div class="clip-thumbnail" onclick="playSession(${sIdx})">
          <div class="clip-aspect-wrapper">
            <video class="clip-preview-video" preload="none" muted playsinline data-src="${streamUrl}#t=0.5"></video>

            <div class="clip-play-overlay">
              <svg width="42" height="42" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5 3 19 12 5 21 5 3"></polygon>
              </svg>
            </div>

            <!-- Top Badges: Detections & S3 Sync -->
            <div class="clip-badges-top">
              <div style="display:flex;gap:4px;align-items:center;">
                ${badgesHtml}
              </div>
              <span class="badge-sync ${syncBadgeClass}">
                ${syncBadgeText}
              </span>
            </div>

            <!-- Bottom Badges: Time Range & Full Duration -->
            <div class="clip-badges-bottom">
              <span class="clip-badge-time">⏱️ ${session.timeRange}</span>
              <span class="clip-badge-dur" style="background:#0284c7;color:#fff;font-weight:700;">${session.durationFormatted}</span>
            </div>
          </div>
        </div>

        <div class="clip-info">
          <div class="clip-meta">
            <span class="clip-camera">${camName}</span>
            <span class="clip-session-tag">🔗 ${session.segmentCount} Segmen Utuh</span>
          </div>

          <div class="clip-actions">
            <div class="clip-btn-group">
              <button class="btn btn-primary btn-xs" onclick="playSession(${sIdx})">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg> Putar Video Utuh (${session.durationFormatted})
              </button>
            </div>
            <span class="clip-date-tag" title="Tanggal Rekaman">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                <line x1="16" y1="2" x2="16" y2="6"></line>
                <line x1="8" y1="2" x2="8" y2="6"></line>
                <line x1="3" y1="10" x2="21" y2="10"></line>
              </svg>
              ${session.date}
            </span>
          </div>
        </div>
      `;

      // Hover-to-preview video snippet
      card.addEventListener('mouseenter', () => {
        const video = card.querySelector('.clip-preview-video');
        if (video && video.readyState >= 2) {
          video.play().catch(() => {});
        }
      });

      card.addEventListener('mouseleave', () => {
        const video = card.querySelector('.clip-preview-video');
        if (video) {
          video.pause();
          video.currentTime = 0.5;
        }
      });

      clipsGrid.appendChild(card);

      const videoEl = card.querySelector('.clip-preview-video');
      if (videoEl && videoObserver) {
        videoObserver.observe(videoEl);
      }
    });
  }

  // RENDER RAW 10-SECOND SEGMENTS
  function renderClips(files) {
    clipsGrid.innerHTML = '';
    initVideoObserver();

    files.forEach(file => {
      const card = document.createElement('div');
      card.className = 'clip-card';

      const camName = file.camera.replace(/_/g, ' ').toUpperCase();

      let badgesHtml = '';
      if (file.objects && file.objects > 0) {
        badgesHtml += `<span class="badge-obj" title="${file.objects} object detections">🎯 ${file.objects} obj</span>`;
      }
      if (file.motion && file.motion > 0) {
        badgesHtml += `<span class="badge-motion" title="Motion detected">⚡ Motion</span>`;
      }

      const isSynced = file.s3Synced === true;
      const syncBadgeClass = isSynced ? 'badge-s3-synced' : 'badge-s3-pending';
      const syncBadgeText = isSynced ? '☁️ S3 Synced' : '⏳ Local (Pending S3)';

      const streamUrl = `/api/recordings/stream?key=${encodeURIComponent(file.key)}`;

      card.innerHTML = `
        <div class="clip-thumbnail" onclick="playRecording('${file.key}', '${camName}', '${file.date} ${file.time}', '${file.sizeFormatted}')">
          <div class="clip-aspect-wrapper">
            <video class="clip-preview-video" preload="none" muted playsinline data-src="${streamUrl}#t=0.5"></video>

            <div class="clip-play-overlay">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5 3 19 12 5 21 5 3"></polygon>
              </svg>
            </div>

            <div class="clip-badges-top">
              <div style="display:flex;gap:4px;align-items:center;">
                ${badgesHtml}
              </div>
              <span class="badge-sync ${syncBadgeClass}" data-key="${file.key}">
                ${syncBadgeText}
              </span>
            </div>

            <div class="clip-badges-bottom">
              <span class="clip-badge-time">${file.time}</span>
              ${file.duration ? `<span class="clip-badge-dur">${file.duration}s</span>` : ''}
            </div>
          </div>
        </div>
        <div class="clip-info">
          <div class="clip-meta">
            <span class="clip-camera">${camName}</span>
            <span class="clip-size">${file.sizeFormatted}</span>
          </div>
          <div class="clip-actions">
            <div class="clip-btn-group">
              <button class="btn btn-primary btn-xs" onclick="playRecording('${file.key}', '${camName}', '${file.date} ${file.time}', '${file.sizeFormatted}')">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg> Play 10s
              </button>
              <a href="${streamUrl}" download class="btn btn-secondary btn-xs" title="Download clip">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
              </a>
            </div>
            <span class="clip-date-tag" title="Tanggal Rekaman">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
                <line x1="16" y1="2" x2="16" y2="6"></line>
                <line x1="8" y1="2" x2="8" y2="6"></line>
                <line x1="3" y1="10" x2="21" y2="10"></line>
              </svg>
              ${file.date}
            </span>
          </div>
        </div>
      `;

      card.addEventListener('mouseenter', () => {
        const video = card.querySelector('.clip-preview-video');
        if (video && video.readyState >= 2) {
          video.play().catch(() => {});
        }
      });

      card.addEventListener('mouseleave', () => {
        const video = card.querySelector('.clip-preview-video');
        if (video) {
          video.pause();
          video.currentTime = 0.5;
        }
      });

      clipsGrid.appendChild(card);

      const videoEl = card.querySelector('.clip-preview-video');
      if (videoEl && videoObserver) {
        videoObserver.observe(videoEl);
      }
    });
  }

  // Keyboard escape listener to close video modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.style.display !== 'none') {
      window.closeVideoModal();
    }
  });

  // Export current session state
  window._skyguardState = {
    getSessions: () => loadedSessions,
    getFiles: () => loadedFiles
  };
});

// CONTINUOUS PLAYLIST ENGINE (PLAYBACK TANPA PUTUS)
let activeSession = null;
let activeSegmentIndex = 0;

window.playSession = function(sessionIdx) {
  const sessions = window._skyguardState ? window._skyguardState.getSessions() : [];
  const session = sessions[sessionIdx];
  if (!session || !session.segments || !session.segments.length) return;

  activeSession = session;
  activeSegmentIndex = 0;

  const modal = document.getElementById('video-modal');
  const sessionNav = document.getElementById('modal-session-nav');
  const counter = document.getElementById('modal-segment-counter');
  if (sessionNav) sessionNav.style.display = 'flex';
  if (counter) counter.style.display = 'inline-flex';

  playSegmentInSession(0);
  modal.style.display = 'flex';
};

function playSegmentInSession(idx) {
  if (!activeSession || idx < 0 || idx >= activeSession.segments.length) return;
  activeSegmentIndex = idx;
  const seg = activeSession.segments[idx];
  const player = document.getElementById('modal-video-player');
  const title = document.getElementById('modal-video-title');
  const subtitle = document.getElementById('modal-video-subtitle');
  const counter = document.getElementById('modal-segment-counter');
  const downloadBtn = document.getElementById('modal-download-btn');

  const camName = activeSession.camera.replace(/_/g, ' ').toUpperCase();
  title.textContent = `${camName} - Kejadian / Sesi Utuh (${activeSession.timeRange})`;
  subtitle.textContent = `Durasi Total: ${activeSession.durationFormatted} • Ukuran: ${activeSession.sizeFormatted}`;
  
  if (counter) {
    counter.textContent = `Segmen ${idx + 1} / ${activeSession.segments.length} (${seg.time})`;
  }

  const streamUrl = `/api/recordings/stream?key=${encodeURIComponent(seg.key)}`;
  downloadBtn.href = streamUrl;

  player.src = streamUrl;
  player.playbackRate = 1.0;
  window.resetSpeedButtons();

  player.play().catch(e => console.warn('Modal autoplay blocked:', e));

  // Seamless continuous playback: automatically play next segment when current ends!
  player.onended = () => {
    const autoNext = document.getElementById('chk-auto-next');
    if (!autoNext || autoNext.checked) {
      if (activeSegmentIndex + 1 < activeSession.segments.length) {
        playSegmentInSession(activeSegmentIndex + 1);
      }
    }
  };
}

window.playNextSegment = function() {
  if (activeSession && activeSegmentIndex + 1 < activeSession.segments.length) {
    playSegmentInSession(activeSegmentIndex + 1);
  }
};

window.playPrevSegment = function() {
  if (activeSession && activeSegmentIndex - 1 >= 0) {
    playSegmentInSession(activeSegmentIndex - 1);
  }
};

// Single clip playback (10s raw)
window.playRecording = function(key, camera, timeStr, sizeStr) {
  activeSession = null;
  const modal = document.getElementById('video-modal');
  const player = document.getElementById('modal-video-player');
  const title = document.getElementById('modal-video-title');
  const subtitle = document.getElementById('modal-video-subtitle');
  const sessionNav = document.getElementById('modal-session-nav');
  const counter = document.getElementById('modal-segment-counter');
  const downloadBtn = document.getElementById('modal-download-btn');

  if (sessionNav) sessionNav.style.display = 'none';
  if (counter) counter.style.display = 'none';

  const streamUrl = `/api/recordings/stream?key=${encodeURIComponent(key)}`;

  title.textContent = `${camera} Recording (10 Detik)`;
  subtitle.textContent = `${timeStr} (${sizeStr})`;
  downloadBtn.href = streamUrl;

  player.src = streamUrl;
  player.playbackRate = 1.0;
  window.resetSpeedButtons();

  player.onended = null;

  modal.style.display = 'flex';
  player.play().catch(e => console.warn('Modal autoplay blocked:', e));
};

window.closeVideoModal = function() {
  const modal = document.getElementById('video-modal');
  const player = document.getElementById('modal-video-player');
  activeSession = null;
  if (player) {
    player.pause();
    player.onended = null;
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
