/**
 * SkyGuard Surveillance Recordings & Events Controller
 * Native Frigate Tracked Object Details, Gemini AI Intelligence & 24/7 Archive
 */

let currentPrimaryMode = 'events'; // 'events' (default) or 'archive'
let loadedEvents = [];
let loadedFiles = [];
let loadedSessions = [];
let activeCamera = 'all';
let pendingCamera = 'all';
let pendingCameraName = 'All Cameras';

document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('recordings-filter-form');
  const dateSelect = document.getElementById('filter-date');
  const cameraInput = document.getElementById('filter-camera');
  const hourSelect = document.getElementById('filter-hour');
  const labelSelect = document.getElementById('filter-label');

  // Fields
  const fieldFilterLabel = document.getElementById('field-filter-label');
  const fieldFilterDate = document.getElementById('field-filter-date');
  const fieldFilterHour = document.getElementById('field-filter-hour');
  const archiveViewToggle = document.getElementById('archive-view-mode-toggle');

  const resultsTitle = document.getElementById('results-title');
  const resultsCount = document.getElementById('results-count');
  const resultsEmpty = document.getElementById('results-empty');
  const resultsEmptyMsg = document.getElementById('results-empty-msg');
  const resultsLoading = document.getElementById('results-loading');
  const resultsLoadingMsg = document.getElementById('results-loading-msg');
  const clipsGrid = document.getElementById('clips-grid');

  // Frigate Popover Controls
  const cameraBtn = document.getElementById('camera-dropdown-btn');
  const cameraPopover = document.getElementById('camera-popover');
  const selectedCameraText = document.getElementById('selected-camera-text');
  const radioItems = document.querySelectorAll('.camera-radio-item');
  const btnApply = document.getElementById('btn-camera-apply');
  const btnReset = document.getElementById('btn-camera-reset');

  // Archive view mode toggle (sessions vs segments)
  const btnModeSessions = document.getElementById('btn-mode-sessions');
  const btnModeSegments = document.getElementById('btn-mode-segments');
  let currentArchiveMode = 'sessions';

  if (btnModeSessions && btnModeSegments) {
    btnModeSessions.addEventListener('click', () => {
      if (currentArchiveMode !== 'sessions') {
        currentArchiveMode = 'sessions';
        btnModeSessions.classList.add('active');
        btnModeSegments.classList.remove('active');
        renderArchiveResults();
      }
    });

    btnModeSegments.addEventListener('click', () => {
      if (currentArchiveMode !== 'segments') {
        currentArchiveMode = 'segments';
        btnModeSegments.classList.add('active');
        btnModeSessions.classList.remove('active');
        renderArchiveResults();
      }
    });
  }

  // Multi-Select Camera Radio/Pill Selector
  const recCamSelector = document.getElementById('recordings-camera-selector');
  const recCamPills = document.querySelectorAll('#recordings-camera-selector .cam-radio-pill');
  const recPillAll = document.querySelector('#recordings-camera-selector [data-cam="all"]');

  if (recCamSelector && recCamPills.length > 0) {
    recCamPills.forEach(pill => {
      pill.addEventListener('click', () => {
        const targetCam = pill.dataset.cam;

        if (targetCam === 'all') {
          // Turn ON 'all', turn OFF all others
          recCamPills.forEach(p => p.classList.remove('active'));
          pill.classList.add('active');
          if (cameraInput) cameraInput.value = 'all';
        } else {
          // Specific camera clicked: Turn OFF 'all'
          if (recPillAll) recPillAll.classList.remove('active');

          // Toggle this camera
          pill.classList.toggle('active');

          // Collect active camera IDs
          const activeCamIds = [];
          recCamPills.forEach(p => {
            if (p !== recPillAll && p.classList.contains('active')) {
              activeCamIds.push(p.dataset.cam);
            }
          });

          if (activeCamIds.length === 0) {
            // None active, revert to all
            if (recPillAll) recPillAll.classList.add('active');
            if (cameraInput) cameraInput.value = 'all';
          } else {
            if (cameraInput) cameraInput.value = activeCamIds.join(',');
          }
        }

        currentEventPage = 1;
        triggerSearch();
      });
    });
  }

  // When date is changed in select, trigger search immediately
  if (dateSelect) {
    dateSelect.addEventListener('change', () => {
      triggerSearch();
    });
  }

  // Handle Form Submit
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    triggerSearch();
  });

  function triggerSearch() {
    if (currentPrimaryMode === 'events') {
      loadTrackedEvents();
    } else {
      searchArchiveRecordings();
    }
  }

  // Mode Switcher function (attached to window)
  window.setPrimaryMode = function(mode) {
    currentPrimaryMode = mode;
    const tabEvents = document.getElementById('tab-mode-events');
    const tabArchive = document.getElementById('tab-mode-archive');
    const submitText = document.getElementById('btn-submit-text');

    if (mode === 'events') {
      tabEvents.classList.add('active');
      tabArchive.classList.remove('active');
      fieldFilterLabel.style.display = 'block';
      fieldFilterDate.style.display = 'block'; // ALWAYS VISIBLE
      fieldFilterHour.style.display = 'none';
      archiveViewToggle.style.display = 'none';
      resultsTitle.textContent = 'Tracked Object Events (Video Utuh)';
      submitText.textContent = 'Cari Kejadian';
      loadTrackedEvents();
    } else {
      tabArchive.classList.add('active');
      tabEvents.classList.remove('active');
      fieldFilterLabel.style.display = 'none';
      fieldFilterDate.style.display = 'block'; // ALWAYS VISIBLE
      fieldFilterHour.style.display = 'block';
      archiveViewToggle.style.display = 'flex';
      if (paginationContainer) paginationContainer.style.display = 'none';
      resultsTitle.textContent = '24/7 Continuous Recordings Archive';
      submitText.textContent = 'Cari Rekaman 24/7';
      searchArchiveRecordings();
    }
  };

  // Load available dates on startup
  loadAvailableDates();

  async function loadAvailableDates() {
    try {
      const res = await fetch('/api/recordings/dates');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      dateSelect.innerHTML = '<option value="">Semua Tanggal (Terbaru)</option>';
      if (data.dates && data.dates.length > 0) {
        data.dates.forEach(d => {
          const opt = document.createElement('option');
          opt.value = d;
          opt.textContent = `${d}`;
          dateSelect.appendChild(opt);
        });
      }
    } catch (err) {
      console.warn('Could not populate date list:', err);
    }
  }

  // Pagination State for Tracked Events
  let currentEventPage = 1;
  const eventPageLimit = 30;
  let totalEventPages = 1;
  let totalEventCount = 0;

  // Pagination Elements
  const paginationContainer = document.getElementById('events-pagination-container');
  const paginationInfoText = document.getElementById('pagination-info-text');
  const btnPageFirst = document.getElementById('btn-page-first');
  const btnPagePrev = document.getElementById('btn-page-prev');
  const btnPageNext = document.getElementById('btn-page-next');
  const btnPageLast = document.getElementById('btn-page-last');
  const paginationNumbers = document.getElementById('pagination-numbers');
  const inputPageJump = document.getElementById('input-page-jump');
  const btnPageJump = document.getElementById('btn-page-jump');

  if (btnPageFirst) btnPageFirst.addEventListener('click', () => goToPage(1));
  if (btnPagePrev) btnPagePrev.addEventListener('click', () => goToPage(currentEventPage - 1));
  if (btnPageNext) btnPageNext.addEventListener('click', () => goToPage(currentEventPage + 1));
  if (btnPageLast) btnPageLast.addEventListener('click', () => goToPage(totalEventPages));
  if (btnPageJump && inputPageJump) {
    btnPageJump.addEventListener('click', () => {
      const p = parseInt(inputPageJump.value, 10);
      if (!isNaN(p) && p >= 1 && p <= totalEventPages) {
        goToPage(p);
      }
    });
    inputPageJump.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        btnPageJump.click();
      }
    });
  }

  function goToPage(page) {
    if (page < 1 || page > totalEventPages) return;
    loadTrackedEvents(page);
    const resultsHeader = document.querySelector('.results-header');
    if (resultsHeader) {
      window.scrollTo({
        top: resultsHeader.offsetTop - 70,
        behavior: 'smooth'
      });
    }
  }

  function renderEventPagination(pagination, currentCount) {
    if (!paginationContainer) return;

    if (currentPrimaryMode !== 'events') {
      paginationContainer.style.display = 'none';
      return;
    }

    currentEventPage = pagination.page || 1;
    totalEventPages = pagination.totalPages || 1;
    totalEventCount = pagination.total !== null && pagination.total !== undefined ? pagination.total : currentCount;

    if (totalEventPages <= 1 && currentCount <= 0) {
      paginationContainer.style.display = 'none';
      return;
    }

    paginationContainer.style.display = 'flex';

    const startIdx = ((currentEventPage - 1) * eventPageLimit) + 1;
    const endIdx = startIdx + currentCount - 1;
    if (pagination.total) {
      paginationInfoText.innerHTML = `Menampilkan <strong>${startIdx} - ${endIdx}</strong> dari <strong>${pagination.total.toLocaleString('id-ID')}</strong> video kejadian`;
    } else {
      paginationInfoText.innerHTML = `Halaman <strong>${currentEventPage}</strong> dari <strong>${totalEventPages}</strong>`;
    }

    // Button disabled states
    if (btnPageFirst) btnPageFirst.disabled = currentEventPage <= 1;
    if (btnPagePrev) btnPagePrev.disabled = currentEventPage <= 1;
    if (btnPageNext) btnPageNext.disabled = currentEventPage >= totalEventPages;
    if (btnPageLast) btnPageLast.disabled = currentEventPage >= totalEventPages;

    if (inputPageJump) {
      inputPageJump.max = totalEventPages;
      inputPageJump.value = currentEventPage;
    }

    // Render Page Number Buttons (smart sliding window)
    if (paginationNumbers) {
      paginationNumbers.innerHTML = '';
      const maxButtons = 5;
      let startPage = Math.max(1, currentEventPage - 2);
      let endPage = Math.min(totalEventPages, startPage + maxButtons - 1);
      if (endPage - startPage < maxButtons - 1) {
        startPage = Math.max(1, endPage - maxButtons + 1);
      }

      if (startPage > 1) {
        const b1 = document.createElement('button');
        b1.type = 'button';
        b1.className = 'pag-num-btn';
        b1.textContent = '1';
        b1.onclick = () => goToPage(1);
        paginationNumbers.appendChild(b1);
        if (startPage > 2) {
          const dots = document.createElement('span');
          dots.className = 'pag-dots';
          dots.textContent = '...';
          paginationNumbers.appendChild(dots);
        }
      }

      for (let p = startPage; p <= endPage; p++) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `pag-num-btn ${p === currentEventPage ? 'active' : ''}`;
        btn.textContent = p;
        btn.onclick = () => goToPage(p);
        paginationNumbers.appendChild(btn);
      }

      if (endPage < totalEventPages) {
        if (endPage < totalEventPages - 1) {
          const dots = document.createElement('span');
          dots.className = 'pag-dots';
          dots.textContent = '...';
          paginationNumbers.appendChild(dots);
        }
        const bLast = document.createElement('button');
        bLast.type = 'button';
        bLast.className = 'pag-num-btn';
        bLast.textContent = totalEventPages;
        bLast.onclick = () => goToPage(totalEventPages);
        paginationNumbers.appendChild(bLast);
      }
    }
  }

  // LOAD TRACKED EVENTS (WITH 30 PER PAGE PAGINATION)
  async function loadTrackedEvents(page = 1) {
    currentEventPage = page;
    resultsLoading.style.display = 'block';
    resultsLoadingMsg.textContent = `Memuat video kejadian halaman ${currentEventPage}...`;
    resultsEmpty.style.display = 'none';
    clipsGrid.style.display = 'none';
    if (paginationContainer) paginationContainer.style.display = 'none';
    resultsCount.textContent = `Memuat Frigate Events (Hal ${currentEventPage})...`;

    const cam = cameraInput.value || 'all';
    const label = labelSelect ? labelSelect.value : 'all';
    const date = dateSelect ? dateSelect.value : '';

    const queryParams = new URLSearchParams({
      page: String(currentEventPage),
      limit: String(eventPageLimit)
    });
    if (cam && cam !== 'all') queryParams.append('cameras', cam);
    if (label && label !== 'all') queryParams.append('labels', label);
    if (date) queryParams.append('date', date);

    try {
      const res = await fetch(`/api/events?${queryParams.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      resultsLoading.style.display = 'none';

      const events = Array.isArray(data) ? data : (data.events || []);
      const pagination = data.pagination || { page: currentEventPage, limit: eventPageLimit, total: events.length, totalPages: 1 };

      // Ensure no video with duration < 3s appears in the tab
      loadedEvents = (events || []).filter(e => (e.duration === undefined || e.duration >= 3));

      if (!loadedEvents.length) {
        resultsEmpty.style.display = 'block';
        const dateNote = date ? ` untuk tanggal ${date}` : '';
        const camLabel = (cameraInput && cameraInput.value !== 'all') ? cameraInput.value : 'Semua Kamera';
        resultsEmptyMsg.textContent = `Tidak ada rekaman kejadian objek (> 3 detik) untuk kamera "${camLabel}"${dateNote} (Halaman ${currentEventPage}).`;
        resultsCount.textContent = '0 kejadian ditemukan';
        if (paginationContainer) paginationContainer.style.display = 'none';
        return;
      }

      const totalTxt = pagination.total ? `${pagination.total.toLocaleString('id-ID')} Total Kejadian` : `${loadedEvents.length} Kejadian`;
      resultsCount.textContent = `${totalTxt} • Halaman ${currentEventPage} dari ${pagination.totalPages} (30 video per halaman)`;
      renderTrackedEvents(loadedEvents);
      clipsGrid.style.display = 'grid';

      renderEventPagination(pagination, loadedEvents.length);

    } catch (err) {
      console.warn('Events fetch failed, automatically falling back to ParadeDB archive:', err);
      // Seamless auto-fallback to ParadeDB archive search
      searchArchiveRecordings();
    }
  }

  function renderTrackedEvents(events) {
    clipsGrid.innerHTML = '';

    events.forEach(event => {
      // Strict client-side check: exclude < 3s
      if (event.duration !== undefined && event.duration < 3) return;

      const card = document.createElement('div');
      card.className = 'clip-card event-card';

      const camName = event.camera.replace(/_/g, ' ').toUpperCase();
      const scorePct = `${event.score}%`;
      const durText = event.durationFormatted || 'Clip Utuh';
      const timeDisplay = event.usStartTime || `${event.date} ${event.time}`;

      card.innerHTML = `
        <div class="clip-thumbnail" onclick="openTrackedObjectModal('${event.id}')">
          <div class="clip-aspect-wrapper">
            <img class="event-thumb-img" src="${event.thumbnailUrl}" loading="lazy" alt="${event.label}" onerror="this.src='/api/events/${event.id}/snapshot.jpg'">

            <div class="clip-play-overlay">
              <svg width="44" height="44" viewBox="0 0 24 24" fill="currentColor">
                <polygon points="5 3 19 12 5 21 5 3"></polygon>
              </svg>
            </div>

            <!-- Top Badges: Object type + Confidence score, Camera Name -->
            <div class="clip-badges-top">
              <span class="badge-event-label">${event.labelIcon} ${event.label} (${scorePct})</span>
              <span class="badge-event-cam">${camName}</span>
            </div>

            <!-- Bottom Badges: Event Start Time & Full Duration -->
            <div class="clip-badges-bottom">
              <span class="clip-badge-time">⏱️ ${timeDisplay}</span>
              <span class="clip-badge-dur" style="background:#0284c7;color:#fff;font-weight:700;">${durText}</span>
            </div>
          </div>
        </div>

        <div class="clip-info">
          <div class="clip-meta">
            <span class="clip-camera">${camName}</span>
            <span class="clip-session-tag">🎯 Video Utuh (${durText})</span>
          </div>

          <div class="clip-actions">
            <div class="clip-btn-group">
              <button class="btn btn-primary btn-xs" onclick="openTrackedObjectModal('${event.id}')">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg> Putar Video
              </button>
              <a href="${event.clipUrl}" download class="btn btn-secondary btn-xs" title="Download video rekaman utuh (MP4)">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>
              </a>
            </div>
            <span class="clip-date-tag" title="Tanggal Kejadian">
              ${event.date}
            </span>
          </div>
        </div>
      `;

      clipsGrid.appendChild(card);
    });
  }

  // LOAD 24/7 ARCHIVE RECORDINGS
  async function searchArchiveRecordings() {
    const camera = cameraInput.value;
    const date = dateSelect.value;
    const hour = hourSelect.value;

    if (!date) {
      resultsEmpty.style.display = 'block';
      resultsEmptyMsg.textContent = 'Silakan pilih tanggal untuk mencari arsip rekaman 24/7.';
      resultsCount.textContent = 'Pilih Tanggal';
      return;
    }

    resultsLoading.style.display = 'block';
    resultsLoadingMsg.textContent = 'Memuat rekaman dari ParadeDB / S3...';
    resultsEmpty.style.display = 'none';
    clipsGrid.style.display = 'none';
    resultsCount.textContent = 'Searching...';

    try {
      const queryParams = new URLSearchParams({ date });
      if (camera && camera !== 'all') queryParams.append('camera', camera);
      if (hour !== '') queryParams.append('hour', hour);

      const res = await fetch(`/api/recordings/list?${queryParams.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      resultsLoading.style.display = 'none';
      // Filter out duration < 3 seconds
      loadedFiles = (data.files || []).filter(f => (f.duration === undefined || f.duration >= 3));
      loadedSessions = (data.sessions || []).filter(s => (s.totalDuration === undefined || s.totalDuration >= 3));

      if (!loadedFiles.length) {
        resultsEmpty.style.display = 'block';
        resultsEmptyMsg.textContent = `Tidak ada rekaman (> 3 detik) untuk tanggal ${date} dengan filter yang dipilih.`;
        resultsCount.textContent = '0 clips found';
        return;
      }

      renderArchiveResults();
      clipsGrid.style.display = 'grid';

    } catch (err) {
      console.error('Archive search failed:', err);
      resultsLoading.style.display = 'none';
      resultsEmpty.style.display = 'block';
      resultsEmptyMsg.textContent = `Error loading recordings: ${err.message}`;
      resultsCount.textContent = 'Error';
    }
  }

  function renderArchiveResults() {
    if (currentArchiveMode === 'sessions') {
      resultsCount.textContent = `${loadedSessions.length} Video Sesi Utuh (${loadedFiles.length} segmen)`;
      renderArchiveSessions(loadedSessions);
    } else {
      resultsCount.textContent = `${loadedFiles.length} Segmen (≥ 3 Detik)`;
      renderArchiveClips(loadedFiles);
    }
  }

  function renderArchiveSessions(sessions) {
    clipsGrid.innerHTML = '';
    sessions.forEach((session, sIdx) => {
      if (session.totalDuration && session.totalDuration < 3) return;

      const card = document.createElement('div');
      card.className = `clip-card session-card ${session.totalObjects > 0 ? 'has-event' : ''}`;
      const camName = session.camera.replace(/_/g, ' ').toUpperCase();
      const streamUrl = `/api/recordings/stream?key=${encodeURIComponent(session.key)}`;

      let badgesHtml = '';
      if (session.totalObjects > 0) badgesHtml += `<span class="badge-obj">🎯 ${session.totalObjects} obj</span>`;
      if (session.hasMotion) badgesHtml += `<span class="badge-motion">⚡ Motion</span>`;

      const isSynced = session.s3Synced === true;
      const syncBadgeClass = isSynced ? 'badge-s3-synced' : 'badge-s3-pending';
      const syncBadgeText = isSynced ? '☁️ S3 Synced' : '⏳ Local (Pending S3)';

      card.innerHTML = `
        <div class="clip-thumbnail" onclick="playArchiveSession(${sIdx})">
          <div class="clip-aspect-wrapper">
            <video class="clip-preview-video" preload="none" muted playsinline data-src="${streamUrl}#t=0.5"></video>
            <div class="clip-play-overlay">
              <svg width="42" height="42" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
            </div>
            <div class="clip-badges-top">
              <div style="display:flex;gap:4px;align-items:center;">${badgesHtml}</div>
              <span class="badge-sync ${syncBadgeClass}">${syncBadgeText}</span>
            </div>
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
              <button class="btn btn-primary btn-xs" onclick="playArchiveSession(${sIdx})">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg> Putar Video Utuh
              </button>
            </div>
            <span class="clip-date-tag">${session.date}</span>
          </div>
        </div>
      `;
      clipsGrid.appendChild(card);
    });
  }

  function renderArchiveClips(files) {
    clipsGrid.innerHTML = '';
    files.forEach(file => {
      if (file.duration && file.duration < 3) return;

      const card = document.createElement('div');
      card.className = 'clip-card';
      const camName = file.camera.replace(/_/g, ' ').toUpperCase();
      const streamUrl = `/api/recordings/stream?key=${encodeURIComponent(file.key)}`;

      card.innerHTML = `
        <div class="clip-thumbnail" onclick="playSingleClip('${file.key}', '${camName}', '${file.date} ${file.time}', '${file.sizeFormatted}')">
          <div class="clip-aspect-wrapper">
            <video class="clip-preview-video" preload="none" muted playsinline data-src="${streamUrl}#t=0.5"></video>
            <div class="clip-play-overlay">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>
            </div>
            <div class="clip-badges-bottom">
              <span class="clip-badge-time">${file.time}</span>
              <span class="clip-badge-dur">${file.duration || 10}s</span>
            </div>
          </div>
        </div>
        <div class="clip-info">
          <div class="clip-meta">
            <span class="clip-camera">${camName}</span>
            <span class="clip-size">${file.sizeFormatted}</span>
          </div>
          <div class="clip-actions">
            <button class="btn btn-primary btn-xs" onclick="playSingleClip('${file.key}', '${camName}', '${file.date} ${file.time}', '${file.sizeFormatted}')">
              Play Clip
            </button>
            <a href="${streamUrl}" download class="btn btn-secondary btn-xs">Download</a>
          </div>
        </div>
      `;
      clipsGrid.appendChild(card);
    });
  }

  // Keyboard shortcut (ESC)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      window.closeTrackedModal();
      window.closeVideoModal();
      window.closeDailyBriefingModal();
    }
  });

  // Export state
  window._skyguardState = {
    getLoadedEvents: () => loadedEvents,
    getLoadedSessions: () => loadedSessions
  };

  // Start with Tracked Events
  loadTrackedEvents();
});

// ==========================================================
// ==========================================================
// TRACKED OBJECT DETAILS MODAL (100% AWS S3 RUSTFS & PARADEDB)
// ==========================================================
let activeTrackedEvent = null;
let activeTrackedSegments = [];
let activeTrackedSegmentIdx = 0;

window.openTrackedObjectModal = async function(eventId, initialTab = 'details') {
  const events = window._skyguardState ? window._skyguardState.getLoadedEvents() : [];
  let event = events.find(e => e.id === eventId);

  if (!event) {
    try {
      const res = await fetch(`/api/events/${eventId}`);
      if (res.ok) {
        event = await res.json();
      }
    } catch (_) {}
  }

  if (!event) return;
  activeTrackedEvent = event;

  const modal = document.getElementById('tracked-object-modal');
  const player = document.getElementById('tracked-video-player');
  const downloadBtn = document.getElementById('tracked-download-btn');
  const sessionNav = document.getElementById('tracked-session-nav');
  const segCounter = document.getElementById('tracked-segment-counter');
  const loadingEl = document.getElementById('tracked-video-loading');

  // Reset S3 Segments state
  activeTrackedSegments = [];
  activeTrackedSegmentIdx = 0;
  if (sessionNav) sessionNav.style.display = 'none';

  // Video source & controls (initial placeholder while S3 segments load)
  const initialS3Url = `/api/events/${event.id}/clip.mp4`;
  downloadBtn.href = initialS3Url;
  player.src = initialS3Url;
  player.playbackRate = 1.0;
  window.resetTrackedSpeedButtons();

  // Populate Right Column Details
  const iconEl = document.getElementById('dtl-obj-icon');
  const labelEl = document.getElementById('dtl-obj-label');
  const timeRangeEl = document.getElementById('dtl-obj-timerange');
  const thumbImg = document.getElementById('dtl-thumb-img');

  const label = event.label || 'Object';
  const labelCap = label.charAt(0).toUpperCase() + label.slice(1);
  const icon = event.labelIcon || '🚶';

  if (iconEl) iconEl.textContent = icon;
  if (labelEl) labelEl.textContent = labelCap;
  if (timeRangeEl) timeRangeEl.textContent = event.usTimeRange || `${event.date} ${event.timeRange}`;

  if (thumbImg) {
    thumbImg.src = event.thumbnailUrl || `/api/events/${event.id}/thumbnail.webp`;
    thumbImg.onerror = () => {
      thumbImg.src = `/api/events/${event.id}/snapshot.jpg`;
    };
  }

  // Populate Vertical Timeline
  const timelineContainer = document.getElementById('timeline-items');
  if (timelineContainer) {
    timelineContainer.innerHTML = '';
    const scoreText = `Score: ${event.score || 75}%`;

    // Step 1: Detected
    const step1 = document.createElement('div');
    step1.className = 'timeline-step';
    step1.innerHTML = `
      <div class="timeline-dot"></div>
      <div class="timeline-step-title">${labelCap} detected</div>
      <div class="timeline-step-meta">
        <span class="timeline-score">${scoreText}</span>
        <span class="timeline-step-time">${event.usStartTime || event.time}</span>
      </div>
    `;
    timelineContainer.appendChild(step1);

    // Step 2: Stationary
    const isStationary = event.data && (event.data.stationary === true || event.data.stationary_time);
    if (isStationary || (event.duration && event.duration > 20)) {
      const statTime = event.data && event.data.stationary_time
        ? formatUsTimestamp(event.data.stationary_time)
        : formatUsTimestamp((event.startTime || 0) + 15);

      const step2 = document.createElement('div');
      step2.className = 'timeline-step';
      step2.innerHTML = `
        <div class="timeline-dot"></div>
        <div class="timeline-step-title">${labelCap} became stationary</div>
        <div class="timeline-step-meta">
          <span class="timeline-score">${scoreText}</span>
          <span class="timeline-step-time">${statTime}</span>
        </div>
      `;
      timelineContainer.appendChild(step2);
    }

    // Step 3: Left / Departed
    if (event.endTime && event.endTime > (event.startTime || 0)) {
      const step3 = document.createElement('div');
      step3.className = 'timeline-step';
      step3.innerHTML = `
        <div class="timeline-dot"></div>
        <div class="timeline-step-title">${labelCap} left</div>
        <div class="timeline-step-meta">
          <span class="timeline-score">${scoreText}</span>
          <span class="timeline-step-time">${event.usEndTime || ''}</span>
        </div>
      `;
      timelineContainer.appendChild(step3);
    } else {
      const stepLive = document.createElement('div');
      stepLive.className = 'timeline-step';
      stepLive.innerHTML = `
        <div class="timeline-dot" style="background:#22c55e;"></div>
        <div class="timeline-step-title" style="color:#4ade80;">Currently active / in view</div>
      `;
      timelineContainer.appendChild(stepLive);
    }
  }

  // Switch to initial tab
  const targetTab = (initialTab === 'ai') ? 'details' : initialTab;
  window.switchTrackedTab(targetTab);

  // Open Modal immediately
  modal.style.display = 'flex';

  // 2. Query S3 recording segments via ParadeDB (100% AWS S3 RustFS, 0% OpenWrt CPU!)
  if (loadingEl) loadingEl.style.display = 'flex';

  try {
    const s3Res = await fetch(`/api/events/${eventId}/s3-recording`);
    const s3Data = await s3Res.json();

    if (s3Data.success && s3Data.segments && s3Data.segments.length > 0) {
      activeTrackedSegments = s3Data.segments;
      playTrackedSegment(0);
    } else {
      // Fallback: S3 stream endpoint for event
      const s3ClipUrl = `/api/events/${eventId}/clip.mp4`;
      player.src = s3ClipUrl;
      downloadBtn.href = s3ClipUrl;
      player.playbackRate = 1.0;
      window.resetTrackedSpeedButtons();
      player.play().catch(e => console.warn('Autoplay prevented:', e));
    }
  } catch (err) {
    console.warn('Could not query ParadeDB for S3 segments:', err);
    const s3ClipUrl = `/api/events/${eventId}/clip.mp4`;
    player.src = s3ClipUrl;
    downloadBtn.href = s3ClipUrl;
  } finally {
    if (loadingEl) loadingEl.style.display = 'none';
  }
};

function playTrackedSegment(idx) {
  if (!activeTrackedSegments || idx < 0 || idx >= activeTrackedSegments.length) return;
  activeTrackedSegmentIdx = idx;
  const seg = activeTrackedSegments[idx];

  const player = document.getElementById('tracked-video-player');
  const downloadBtn = document.getElementById('tracked-download-btn');
  const sessionNav = document.getElementById('tracked-session-nav');
  const segCounter = document.getElementById('tracked-segment-counter');

  if (sessionNav) {
    sessionNav.style.display = activeTrackedSegments.length > 1 ? 'flex' : 'none';
  }
  if (segCounter) {
    segCounter.textContent = `Segmen ${idx + 1} / ${activeTrackedSegments.length} (${seg.duration}s)`;
  }

  // Set Video Source directly from AWS S3 RustFS!
  player.src = seg.streamUrl;
  downloadBtn.href = seg.streamUrl;
  downloadBtn.setAttribute('download', `${seg.camera}_${seg.key.split('/').pop()}`);
  player.playbackRate = 1.0;
  window.resetTrackedSpeedButtons();

  player.play().catch(e => console.warn('Autoplay prevented:', e));

  // Seamless auto-advance to next S3 segment when finished
  player.onended = () => {
    if (activeTrackedSegmentIdx + 1 < activeTrackedSegments.length) {
      playTrackedSegment(activeTrackedSegmentIdx + 1);
    }
  };
}

window.playTrackedNextSegment = function() {
  if (activeTrackedSegmentIdx + 1 < activeTrackedSegments.length) {
    playTrackedSegment(activeTrackedSegmentIdx + 1);
  }
};

window.playTrackedPrevSegment = function() {
  if (activeTrackedSegmentIdx - 1 >= 0) {
    playTrackedSegment(activeTrackedSegmentIdx - 1);
  }
};

function formatUsTimestamp(epochSec) {
  if (!epochSec) return '';
  const d = new Date(Number(epochSec) * 1000);
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZone: 'Asia/Jakarta'
  }).format(d);
}

window.closeTrackedModal = function() {
  const modal = document.getElementById('tracked-object-modal');
  const player = document.getElementById('tracked-video-player');
  activeTrackedEvent = null;
  activeTrackedSegments = [];
  if (player) {
    player.pause();
    player.src = '';
  }
  if (modal) {
    modal.style.display = 'none';
  }
};

window.switchTrackedTab = function(tabName) {
  const pillThumb = document.getElementById('tab-pill-thumb');
  const pillDetails = document.getElementById('tab-pill-details');
  const pillAi = document.getElementById('tab-pill-ai');

  const paneThumb = document.getElementById('tracked-pane-thumbnail');
  const paneDetails = document.getElementById('tracked-pane-details');
  const paneAi = document.getElementById('tracked-pane-ai');

  if (pillThumb) pillThumb.classList.toggle('active', tabName === 'thumbnail');
  if (pillDetails) pillDetails.classList.toggle('active', tabName === 'details');
  if (pillAi) pillAi.classList.toggle('active', tabName === 'ai');

  if (paneThumb) paneThumb.style.display = (tabName === 'thumbnail') ? 'block' : 'none';
  if (paneDetails) paneDetails.style.display = (tabName === 'details') ? 'block' : 'none';
  if (paneAi) paneAi.style.display = (tabName === 'ai') ? 'block' : 'none';

  if (tabName === 'ai' && typeof window.runAiAnalysis === 'function') {
    window.runAiAnalysis();
  }
};

// ==========================================================
// GEMINI AI EVENT ANALYSIS
// ==========================================================
window.runAiAnalysis = async function(forceRefresh = false) {
  if (!activeTrackedEvent) return;

  const loadingEl = document.getElementById('ai-loading');
  const resultsBox = document.getElementById('ai-results-box');
  const riskBadge = document.getElementById('ai-risk-level-badge');
  const summaryEl = document.getElementById('ai-summary-text');
  const activityEl = document.getElementById('ai-activity-text');
  const recEl = document.getElementById('ai-recommendation-text');

  if (!forceRefresh && activeTrackedEvent._aiAnalysis) {
    displayAiAnalysis(activeTrackedEvent._aiAnalysis);
    return;
  }

  loadingEl.style.display = 'block';
  resultsBox.style.display = 'none';
  riskBadge.className = 'badge badge-warning';
  riskBadge.textContent = 'Menganalisis...';

  try {
    const res = await fetch('/api/ai/analyze-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventId: activeTrackedEvent.id })
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const analysis = data.analysis;

    activeTrackedEvent._aiAnalysis = analysis;
    displayAiAnalysis(analysis);

  } catch (err) {
    console.error('AI Analysis Failed:', err);
    loadingEl.style.display = 'none';
    resultsBox.style.display = 'block';
    riskBadge.className = 'badge badge-danger';
    riskBadge.textContent = 'Error';
    summaryEl.textContent = `Gagal menjalankan analisis AI: ${err.message}`;
    activityEl.textContent = '--';
    recEl.textContent = 'Silakan periksa koneksi atau coba beberapa saat lagi.';
  }
};

function displayAiAnalysis(analysis) {
  const loadingEl = document.getElementById('ai-loading');
  const resultsBox = document.getElementById('ai-results-box');
  const riskBadge = document.getElementById('ai-risk-level-badge');
  const summaryEl = document.getElementById('ai-summary-text');
  const activityEl = document.getElementById('ai-activity-text');
  const recEl = document.getElementById('ai-recommendation-text');

  loadingEl.style.display = 'none';
  resultsBox.style.display = 'block';

  const risk = analysis.riskLevel || 'Sedang';
  let badgeClass = 'badge-risk-sedang';
  if (risk.toLowerCase().includes('rendah')) badgeClass = 'badge-risk-rendah';
  if (risk.toLowerCase().includes('tinggi')) badgeClass = 'badge-risk-tinggi';

  riskBadge.className = `badge ${badgeClass}`;
  riskBadge.textContent = `Risiko: ${risk}`;

  summaryEl.textContent = analysis.summary || 'Tidak ada deskripsi.';
  activityEl.textContent = analysis.activity || 'Aktivitas normal di area pengawasan.';
  recEl.textContent = analysis.recommendation || 'Lanjutkan pemantauan rutin.';
}

// ==========================================================
// GEMINI AI DAILY BRIEFING MODAL
// ==========================================================
window.openDailyBriefingModal = function() {
  const modal = document.getElementById('daily-briefing-modal');
  modal.style.display = 'flex';
  window.loadDailyBriefing();
};

window.closeDailyBriefingModal = function() {
  const modal = document.getElementById('daily-briefing-modal');
  if (modal) modal.style.display = 'none';
};

window.loadDailyBriefing = async function(forceRefresh = false) {
  const dateSelect = document.getElementById('filter-date');
  const cameraInput = document.getElementById('filter-camera');
  const loadingEl = document.getElementById('briefing-loading');
  const contentEl = document.getElementById('briefing-content');
  const subtitleEl = document.getElementById('briefing-subtitle');

  const selectedDate = (dateSelect && dateSelect.value) ? dateSelect.value : '';
  const selectedCam = (cameraInput && cameraInput.value) ? cameraInput.value : 'all';

  loadingEl.style.display = 'block';
  contentEl.innerHTML = '';
  subtitleEl.textContent = `Menganalisis rangkuman keamanan untuk tanggal: ${selectedDate || 'Hari Ini'}...`;

  try {
    const res = await fetch('/api/ai/daily-briefing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date: selectedDate, camera: selectedCam })
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const b = data.briefing;

    loadingEl.style.display = 'none';
    subtitleEl.textContent = b.title || 'Laporan Ringkasan Intelijen Keamanan SkyGuard';

    const risk = b.overallRisk || 'Rendah';
    let riskClass = 'badge-risk-rendah';
    if (risk.toLowerCase().includes('sedang')) riskClass = 'badge-risk-sedang';
    if (risk.toLowerCase().includes('tinggi')) riskClass = 'badge-risk-tinggi';

    const highlightsHtml = (b.keyHighlights || []).map(h => `<li>${h}</li>`).join('');
    const recHtml = (b.securityRecommendations || []).map(r => `<li>${r}</li>`).join('');

    contentEl.innerHTML = `
      <div class="briefing-card">
        <div class="briefing-header-block">
          <div class="briefing-stat">
            <span class="stat-num">${b.totalEvents || 0}</span>
            <span class="stat-desc">Total Kejadian Terverifikasi</span>
          </div>
          <div>
            <span class="badge ${riskClass}" style="font-size:0.85rem;padding:0.35rem 0.75rem;">
              Status Risiko: ${risk}
            </span>
          </div>
        </div>

        <div class="briefing-exec-summary">
          <label style="font-size:0.75rem;font-weight:700;color:#38bdf8;text-transform:uppercase;letter-spacing:0.05em;">
            🛡️ Ringkasan Eksekutif Keamanan:
          </label>
          <p style="font-size:0.85rem;line-height:1.5;color:#f1f5f9;margin-top:0.35rem;">
            ${b.executiveSummary || 'Tidak ada kejadian mencurigakan yang dilaporkan hari ini.'}
          </p>
          ${b.peakHours ? `<div style="font-size:0.75rem;color:#94a3b8;margin-top:0.5rem;">⏱️ <strong>Waktu Puncak Aktivitas:</strong> ${b.peakHours}</div>` : ''}
        </div>

        ${highlightsHtml ? `
        <div class="briefing-exec-summary">
          <label style="font-size:0.75rem;font-weight:700;color:#cbd5e1;text-transform:uppercase;">
            🔍 Poin Pengamatan Kunci:
          </label>
          <ul class="briefing-list">
            ${highlightsHtml}
          </ul>
        </div>
        ` : ''}

        ${recHtml ? `
        <div class="briefing-exec-summary" style="border-color:rgba(56, 189, 248, 0.3);">
          <label style="font-size:0.75rem;font-weight:700;color:#38bdf8;text-transform:uppercase;">
            💡 Rekomendasi Tindakan Keamanan:
          </label>
          <ul class="briefing-list">
            ${recHtml}
          </ul>
        </div>
        ` : ''}
      </div>
    `;

  } catch (err) {
    console.error('Failed to load daily briefing:', err);
    loadingEl.style.display = 'none';
    contentEl.innerHTML = `
      <div class="alert-error">
        <strong>Gagal membuat laporan intelijen AI:</strong> ${err.message}.
        Silakan periksa koneksi internet ke Gemini API.
      </div>
    `;
  }
};

window.setTrackedSpeed = function(speed) {
  const player = document.getElementById('tracked-video-player');
  if (player) player.playbackRate = speed;
  document.querySelectorAll('.tracked-video-controls .speed-btn').forEach(btn => {
    btn.classList.toggle('active', btn.textContent === `${speed.toFixed(1)}x`);
  });
};

window.resetTrackedSpeedButtons = function() {
  document.querySelectorAll('.tracked-video-controls .speed-btn').forEach(btn => {
    btn.classList.toggle('active', btn.textContent === '1.0x');
  });
};

// ==========================================================
// 24/7 ARCHIVE FALLBACK MODAL ENGINE
// ==========================================================
let activeSession = null;
let activeSegmentIndex = 0;

window.playArchiveSession = function(sessionIdx) {
  const sessions = window._skyguardState ? window._skyguardState.getLoadedSessions() : [];
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

window.playSingleClip = function(key, camera, timeStr, sizeStr) {
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
  title.textContent = `${camera} Recording (Clip)`;
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
  activeSession = null;
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
  if (player) player.playbackRate = speed;
  document.querySelectorAll('#video-modal .speed-btn').forEach(btn => {
    btn.classList.toggle('active', btn.textContent === `${speed.toFixed(1)}x`);
  });
};

window.resetSpeedButtons = function() {
  document.querySelectorAll('#video-modal .speed-btn').forEach(btn => {
    btn.classList.toggle('active', btn.textContent === '1.0x');
  });
};
