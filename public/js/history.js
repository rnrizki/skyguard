/**
 * SkyGuard Surveillance History & Scrubbable Timeline Engine
 * Integrates ParadeDB metadata, RustFS S3 video streaming, and real-time motion waveforms.
 */

(function () {
  'use strict';

  // --- State Variables ---
  let availableDates = [];
  let currentDate = '';
  let currentCamera = 'teras_depan'; // Default primary camera
  let segments = [];
  let waveform = [];
  let events = [];
  let dayStartEpoch = 0;

  let currentSegmentIndex = -1;
  let currentPlayheadEpoch = 0;
  let isDragging = false;
  let isPlaying = false;
  let currentSpeed = 1.0;
  let zoomHours = 24; // 24, 12, 6, 1
  let zoomStartMinute = 0; // For zoomed views

  let sideCamDebounceTimer = null;

  // --- DOM Elements ---
  const videoPlayer = document.getElementById('history-video-player');
  const dateSelect = document.getElementById('history-date-select');
  const cameraSelector = document.getElementById('history-camera-selector');
  const dateBadge = document.getElementById('history-date-badge');
  const currentTimestampEl = document.getElementById('history-current-timestamp');

  const videoCamName = document.getElementById('history-video-camera-name');
  const videoSourcePill = document.getElementById('history-video-source');
  const segmentInfoEl = document.getElementById('history-segment-info');
  const videoLoadingEl = document.getElementById('history-video-loading');
  const noVideoEl = document.getElementById('history-no-video');

  const btnPlayPause = document.getElementById('btn-play-pause');
  const iconPlay = document.getElementById('icon-play');
  const iconPause = document.getElementById('icon-pause');
  const labelPlayPause = document.getElementById('label-play-pause');
  const btnJumpBack = document.getElementById('btn-jump-back');
  const btnJumpFwd = document.getElementById('btn-jump-fwd');
  const btnPrevMotion = document.getElementById('btn-prev-motion');
  const btnNextMotion = document.getElementById('btn-next-motion');
  const btnDownloadSeg = document.getElementById('btn-download-segment');
  const btnFullscreen = document.getElementById('btn-fullscreen');

  const scrubberArea = document.getElementById('timeline-scrubber-area');
  const rulerEl = document.getElementById('timeline-ruler');
  const canvas = document.getElementById('timeline-waveform-canvas');
  const ctx = canvas.getContext('2d');
  const playhead = document.getElementById('timeline-playhead');
  const playheadBadge = document.getElementById('playhead-badge');
  const hoverTooltip = document.getElementById('timeline-hover-tooltip');
  const tooltipTime = document.getElementById('tooltip-time');
  const tooltipInfo = document.getElementById('tooltip-info');

  const sideCameraList = document.getElementById('side-camera-list');

  // --- Formatting Helpers ---
  function formatWibTime(epochSeconds) {
    if (!epochSeconds) return '--:--:--';
    const d = new Date(epochSeconds * 1000);
    // Add 7 hours for WIB if using UTC methods or format in Asia/Jakarta
    return d.toLocaleTimeString('id-ID', {
      timeZone: 'Asia/Jakarta',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  }

  function formatWibDateTime(epochSeconds) {
    if (!epochSeconds) return '--';
    const d = new Date(epochSeconds * 1000);
    const dateStr = d.toLocaleDateString('id-ID', {
      timeZone: 'Asia/Jakarta',
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });
    const timeStr = d.toLocaleTimeString('id-ID', {
      timeZone: 'Asia/Jakarta',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
    return `${dateStr} ${timeStr} WIB`;
  }

  function formatMinuteToTime(minuteOfDay) {
    const h = Math.floor(minuteOfDay / 60);
    const m = minuteOfDay % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }

  // --- Initialization ---
  async function init() {
    setupEventListeners();
    await loadAvailableDates();
  }

  // --- Load Dates ---
  async function loadAvailableDates() {
    try {
      const res = await fetch('/api/recordings/dates');
      const data = await res.json();
      availableDates = data.dates || [];

      dateSelect.innerHTML = '';
      if (!availableDates.length) {
        dateSelect.innerHTML = '<option value="">Tidak ada rekaman</option>';
        return;
      }

      availableDates.forEach((d, idx) => {
        const opt = document.createElement('option');
        opt.value = d;
        opt.textContent = `${d} (WIB)`;
        if (idx === 0) opt.selected = true;
        dateSelect.appendChild(opt);
      });

      currentDate = availableDates[0];
      await loadTimeline(currentCamera, currentDate);
    } catch (err) {
      console.error('Failed to load dates:', err);
      dateSelect.innerHTML = '<option value="">Gagal memuat tanggal</option>';
    }
  }

  // --- Load Timeline Data from ParadeDB ---
  async function loadTimeline(camera, date, initialTimestamp = null) {
    dateBadge.textContent = `${date} • ${camera}`;
    videoLoadingEl.style.display = 'flex';
    noVideoEl.style.display = 'none';

    try {
      const url = `/api/history/timeline?camera=${encodeURIComponent(camera)}&date=${encodeURIComponent(date)}`;
      const res = await fetch(url);
      const data = await res.json();

      if (!data.success) {
        throw new Error(data.error || 'Gagal memuat data');
      }

      currentCamera = data.camera;
      currentDate = data.date;
      dayStartEpoch = data.dayStartEpoch;
      segments = data.segments || [];
      waveform = data.waveform || [];
      events = data.events || [];

      // Update camera title
      updateCameraPillUI(currentCamera);
      renderRuler();
      drawWaveform();

      if (segments.length > 0) {
        let targetIndex = 0;
        if (initialTimestamp) {
          targetIndex = findSegmentIndexForEpoch(initialTimestamp);
          if (targetIndex < 0) targetIndex = 0;
        } else {
          // If seeking, pick first segment with motion if available, else latest segment
          const motionIdx = segments.findIndex(s => s.motion > 0 || s.objects > 0);
          targetIndex = motionIdx >= 0 ? motionIdx : 0;
        }

        playSegmentAtIndex(targetIndex, 0, false);
      } else {
        noVideoEl.style.display = 'flex';
        videoLoadingEl.style.display = 'none';
        currentTimestampEl.textContent = `${date} 00:00:00 WIB (Tidak Ada Data)`;
      }
    } catch (err) {
      console.error('Error loading timeline:', err);
      dateBadge.textContent = 'Gagal Memuat';
      videoLoadingEl.style.display = 'none';
    }
  }

  // --- Find Segment by Epoch Time ---
  function findSegmentIndexForEpoch(epoch) {
    if (!segments.length) return -1;
    // Exact containment: startTime <= epoch < endTime
    const exact = segments.findIndex(s => s.startTime <= epoch && epoch < s.endTime);
    if (exact >= 0) return exact;

    // Find closest segment
    let closestIdx = 0;
    let minDiff = Infinity;
    segments.forEach((s, idx) => {
      const diff = Math.abs(s.startTime - epoch);
      if (diff < minDiff) {
        minDiff = diff;
        closestIdx = idx;
      }
    });
    return closestIdx;
  }

  // --- Play Segment by Index ---
  function playSegmentAtIndex(index, seekOffsetSeconds = 0, autoplay = true) {
    if (index < 0 || index >= segments.length) {
      return;
    }

    currentSegmentIndex = index;
    const seg = segments[index];
    currentPlayheadEpoch = seg.startTime + (seekOffsetSeconds || 0);

    videoLoadingEl.style.display = 'flex';
    noVideoEl.style.display = 'none';

    // Set video src to RustFS S3 stream endpoint
    const streamUrl = `/api/recordings/stream?key=${encodeURIComponent(seg.key)}`;
    videoPlayer.src = streamUrl;
    videoPlayer.playbackRate = currentSpeed;

    videoCamName.textContent = getCameraDisplayName(currentCamera);
    segmentInfoEl.textContent = `${seg.time} • ${seg.duration}s ${seg.motion > 0 ? `(Motion: ${seg.motion})` : ''}`;
    btnDownloadSeg.href = streamUrl;
    btnDownloadSeg.setAttribute('download', `${currentCamera}_${seg.date}_${seg.time.replace(':', '.')}.mp4`);

    updatePlayheadPosition();

    videoPlayer.onloadedmetadata = () => {
      videoLoadingEl.style.display = 'none';
      if (seekOffsetSeconds > 0 && seekOffsetSeconds < videoPlayer.duration) {
        videoPlayer.currentTime = seekOffsetSeconds;
      }
      if (autoplay) {
        videoPlayer.play().then(() => {
          setPlayingUI(true);
        }).catch(err => {
          console.warn('Autoplay prevented:', err);
          setPlayingUI(false);
        });
      }
    };

    triggerSideCamerasUpdate(currentPlayheadEpoch);
  }

  // --- Render Time Ruler ---
  function renderRuler() {
    rulerEl.innerHTML = '';
    const isMobile = window.innerWidth <= 640;
    const totalMinutes = zoomHours * 60;
    let stepHours;
    if (zoomHours <= 1) {
      stepHours = isMobile ? 0.25 : 0.1666;
    } else if (zoomHours <= 6) {
      stepHours = isMobile ? 2 : 1;
    } else if (zoomHours <= 12) {
      stepHours = isMobile ? 3 : 2;
    } else {
      stepHours = isMobile ? 4 : 2;
    }
    const stepMinutes = stepHours * 60;

    for (let m = 0; m <= totalMinutes; m += stepMinutes) {
      const absoluteMinute = zoomStartMinute + m;
      if (absoluteMinute > 1440) break;

      const pct = (m / totalMinutes) * 100;
      const tick = document.createElement('div');
      tick.className = 'ruler-tick';
      tick.style.left = `${pct}%`;

      const label = document.createElement('span');
      label.className = 'ruler-label';
      label.textContent = formatMinuteToTime(absoluteMinute);
      tick.appendChild(label);

      rulerEl.appendChild(tick);
    }
  }

  // --- Render Canvas Waveform ---
  function drawWaveform() {
    const rect = scrubberArea.getBoundingClientRect();
    const width = Math.max(rect.width, 300);
    const height = 80;

    canvas.width = width * window.devicePixelRatio;
    canvas.height = height * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

    ctx.clearRect(0, 0, width, height);

    // Background gradient
    const bgGrad = ctx.createLinearGradient(0, 0, 0, height);
    bgGrad.addColorStop(0, '#111827');
    bgGrad.addColorStop(1, '#1e293b');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, width, height);

    if (!waveform.length) return;

    const totalMinutes = zoomHours * 60;
    const startMin = zoomStartMinute;
    const endMin = Math.min(startMin + totalMinutes, 1440);

    const barWidth = Math.max(width / totalMinutes, 1.2);

    // 1. Draw Minute Bars (Motion & Recordings)
    for (let m = startMin; m < endMin; m++) {
      const bin = waveform[m];
      if (!bin) continue;

      const x = ((m - startMin) / totalMinutes) * width;

      if (!bin.hasRec) {
        // Subtle line for empty hours
        ctx.fillStyle = 'rgba(51, 65, 85, 0.25)';
        ctx.fillRect(x, height - 4, barWidth, 4);
        continue;
      }

      // Base recording presence
      let barHeight = 12; // Base height for continuous recording
      let barColor = '#334155'; // Dark slate for continuous without motion

      if (bin.motion > 0) {
        // Scale motion 1 to 100 -> height 16 to 65
        const normMotion = Math.min(bin.motion / 50, 1.0);
        barHeight = 16 + (normMotion * 48);

        if (bin.motion > 20) {
          barColor = '#f59e0b'; // Amber for high motion
        } else {
          barColor = '#06b6d4'; // Cyan for moderate motion
        }
      }

      if (bin.objects > 0 || bin.hasEvent) {
        barHeight = Math.max(barHeight, 52);
        barColor = '#ef4444'; // Red/Orange for AI Objects
      }

      ctx.fillStyle = barColor;
      ctx.fillRect(x, height - barHeight, Math.max(barWidth - 0.5, 1), barHeight);

      // Event Top Dot Indicator
      if (bin.hasEvent) {
        ctx.fillStyle = '#f87171';
        ctx.beginPath();
        ctx.arc(x + (barWidth / 2), height - barHeight - 4, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 2. Center Baseline Accent Line
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height - 1);
    ctx.lineTo(width, height - 1);
    ctx.stroke();
  }

  // --- Update Playhead Position ---
  function updatePlayheadPosition() {
    if (!dayStartEpoch || isDragging) return;

    const secIntoDay = currentPlayheadEpoch - dayStartEpoch;
    const totalSec = zoomHours * 3600;
    const startSec = zoomStartMinute * 60;

    const visibleSec = secIntoDay - startSec;
    const pct = Math.max(0, Math.min(100, (visibleSec / totalSec) * 100));

    playhead.style.left = `${pct}%`;
    const timeStr = formatWibTime(currentPlayheadEpoch);
    playheadBadge.textContent = timeStr;
    currentTimestampEl.textContent = formatWibDateTime(currentPlayheadEpoch);
  }

  // --- Timeline Drag & Click Scrubbing ---
  function handleTimelineInteraction(e, isCommit = false) {
    const rect = scrubberArea.getBoundingClientRect();
    const touchObj = (e.touches && e.touches.length > 0) ? e.touches[0] : ((e.changedTouches && e.changedTouches.length > 0) ? e.changedTouches[0] : e);
    const clientX = (touchObj && typeof touchObj.clientX === 'number') ? touchObj.clientX : e.clientX;
    const offsetX = Math.max(0, Math.min(rect.width, clientX - rect.left));
    const pct = offsetX / rect.width;

    const totalSec = zoomHours * 3600;
    const startSec = zoomStartMinute * 60;
    const targetSec = startSec + (pct * totalSec);
    const targetEpoch = dayStartEpoch + targetSec;

    currentPlayheadEpoch = targetEpoch;

    // Visual needle update immediately
    playhead.style.left = `${pct * 100}%`;
    const timeStr = formatWibTime(targetEpoch);
    playheadBadge.textContent = timeStr;
    currentTimestampEl.textContent = formatWibDateTime(targetEpoch);

    if (isCommit) {
      const idx = findSegmentIndexForEpoch(targetEpoch);
      if (idx >= 0) {
        const seg = segments[idx];
        const offset = Math.max(0, targetEpoch - seg.startTime);
        playSegmentAtIndex(idx, offset, true);
      }
    }
  }

  // --- Event Listeners Setup ---
  function setupEventListeners() {
    // 1. Camera Pills Click
    cameraSelector.addEventListener('click', (e) => {
      const pill = e.target.closest('.cam-radio-pill');
      if (!pill) return;

      cameraSelector.querySelectorAll('.cam-radio-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');

      const cam = pill.dataset.cam;
      const targetCam = cam === 'all' ? 'teras_depan' : cam;
      loadTimeline(targetCam, currentDate, currentPlayheadEpoch);
    });

    // 2. Date Select Change
    dateSelect.addEventListener('change', (e) => {
      currentDate = e.target.value;
      loadTimeline(currentCamera, currentDate);
    });

    // 3. Play / Pause Button
    btnPlayPause.addEventListener('click', () => {
      if (videoPlayer.paused) {
        videoPlayer.play();
        setPlayingUI(true);
      } else {
        videoPlayer.pause();
        setPlayingUI(false);
      }
    });

    // 4. Video Event Handlers
    videoPlayer.addEventListener('play', () => setPlayingUI(true));
    videoPlayer.addEventListener('pause', () => setPlayingUI(false));

    videoPlayer.addEventListener('timeupdate', () => {
      if (isDragging || !segments[currentSegmentIndex]) return;
      const seg = segments[currentSegmentIndex];
      currentPlayheadEpoch = seg.startTime + videoPlayer.currentTime;
      updatePlayheadPosition();
    });

    videoPlayer.addEventListener('ended', () => {
      // Seamless auto-play next segment
      if (currentSegmentIndex + 1 < segments.length) {
        playSegmentAtIndex(currentSegmentIndex + 1, 0, true);
      } else {
        setPlayingUI(false);
      }
    });

    // 5. Jump Buttons
    btnJumpBack.addEventListener('click', () => {
      if (videoPlayer.currentTime > 10) {
        videoPlayer.currentTime -= 10;
      } else if (currentSegmentIndex > 0) {
        playSegmentAtIndex(currentSegmentIndex - 1, 0, true);
      }
    });

    btnJumpFwd.addEventListener('click', () => {
      if (videoPlayer.duration && videoPlayer.currentTime + 10 < videoPlayer.duration) {
        videoPlayer.currentTime += 10;
      } else if (currentSegmentIndex + 1 < segments.length) {
        playSegmentAtIndex(currentSegmentIndex + 1, 0, true);
      }
    });

    // 6. Prev / Next Motion
    btnPrevMotion.addEventListener('click', () => {
      for (let i = currentSegmentIndex - 1; i >= 0; i--) {
        if (segments[i].motion > 0 || segments[i].objects > 0) {
          playSegmentAtIndex(i, 0, true);
          return;
        }
      }
      alert('Tidak ada segmen pergerakan sebelumnya pada tanggal ini.');
    });

    btnNextMotion.addEventListener('click', () => {
      for (let i = currentSegmentIndex + 1; i < segments.length; i++) {
        if (segments[i].motion > 0 || segments[i].objects > 0) {
          playSegmentAtIndex(i, 0, true);
          return;
        }
      }
      alert('Tidak ada segmen pergerakan berikutnya pada tanggal ini.');
    });

    // 7. Speed Selector
    document.querySelectorAll('.speed-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        currentSpeed = parseFloat(e.target.dataset.speed);
        videoPlayer.playbackRate = currentSpeed;
      });
    });

    // 8. Fullscreen
    btnFullscreen.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        document.querySelector('.history-video-container').requestFullscreen().catch(err => {
          console.warn('Fullscreen error:', err);
        });
      } else {
        document.exitFullscreen();
      }
    });

    // 9. Zoom Range Selector
    document.querySelectorAll('.zoom-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        document.querySelectorAll('.zoom-btn').forEach(b => b.classList.remove('active'));
        e.target.classList.add('active');
        zoomHours = parseInt(e.target.dataset.zoom, 10);

        if (zoomHours === 24) {
          zoomStartMinute = 0;
        } else {
          // Center zoom around current playhead
          const secIntoDay = currentPlayheadEpoch - dayStartEpoch;
          const currentMin = Math.floor(secIntoDay / 60);
          zoomStartMinute = Math.max(0, Math.min(1440 - (zoomHours * 60), currentMin - Math.floor((zoomHours * 60) / 2)));
        }

        renderRuler();
        drawWaveform();
        updatePlayheadPosition();
      });
    });

    // 10. Timeline Scrubber Mouse & Touch Dragging
    scrubberArea.addEventListener('mousedown', (e) => {
      isDragging = true;
      handleTimelineInteraction(e, false);
    });

    window.addEventListener('mousemove', (e) => {
      if (isDragging) {
        handleTimelineInteraction(e, false);
      } else {
        handleTimelineHover(e);
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (isDragging) {
        isDragging = false;
        handleTimelineInteraction(e, true);
      }
    });

    scrubberArea.addEventListener('touchstart', (e) => {
      isDragging = true;
      handleTimelineInteraction(e, false);
    }, { passive: true });

    scrubberArea.addEventListener('touchmove', (e) => {
      if (isDragging) {
        if (e.cancelable) e.preventDefault();
        handleTimelineInteraction(e, false);
      }
    }, { passive: false });

    scrubberArea.addEventListener('touchend', (e) => {
      if (isDragging) {
        isDragging = false;
        handleTimelineInteraction(e, true);
      }
    });

    scrubberArea.addEventListener('mouseleave', () => {
      hoverTooltip.style.display = 'none';
    });

    // Redraw waveform on window resize
    window.addEventListener('resize', () => {
      drawWaveform();
      updatePlayheadPosition();
    });
  }

  // --- Hover Tooltip on Timeline ---
  function handleTimelineHover(e) {
    const rect = scrubberArea.getBoundingClientRect();
    if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
      hoverTooltip.style.display = 'none';
      return;
    }

    const offsetX = e.clientX - rect.left;
    const pct = offsetX / rect.width;
    const totalSec = zoomHours * 3600;
    const startSec = zoomStartMinute * 60;
    const hoverSec = startSec + (pct * totalSec);
    const hoverEpoch = dayStartEpoch + hoverSec;

    const minuteIdx = Math.floor(hoverSec / 60);
    const bin = (minuteIdx >= 0 && minuteIdx < 1440) ? waveform[minuteIdx] : null;

    hoverTooltip.style.display = 'block';
    hoverTooltip.style.left = `${offsetX}px`;
    tooltipTime.textContent = formatWibTime(hoverEpoch);

    if (bin && bin.hasRec) {
      if (bin.hasEvent) {
        tooltipInfo.textContent = `🚨 ${bin.eventLabel.toUpperCase()} (${Math.round((bin.eventScore || 0) * 100)}%)`;
      } else if (bin.motion > 0) {
        tooltipInfo.textContent = `Gerakan: ${bin.motion}`;
      } else {
        tooltipInfo.textContent = 'Rekaman Kontinu';
      }
    } else {
      tooltipInfo.textContent = 'Tidak Ada Rekaman';
    }
  }

  // --- Side Camera Previews Update ---
  function triggerSideCamerasUpdate(timestamp) {
    clearTimeout(sideCamDebounceTimer);
    sideCamDebounceTimer = setTimeout(async () => {
      try {
        const url = `/api/history/cameras-at-time?timestamp=${Math.floor(timestamp)}&date=${encodeURIComponent(currentDate)}`;
        const res = await fetch(url);
        const data = await res.json();
        renderSideCamerasList(data.cameras || []);
      } catch (err) {
        console.warn('Failed to update side cameras:', err);
      }
    }, 400);
  }

  function renderSideCamerasList(cams) {
    sideCameraList.innerHTML = '';
    const otherCams = cams.filter(c => c.id !== currentCamera);

    if (!otherCams.length) {
      sideCameraList.innerHTML = '<div class="side-cam-empty">Semua kamera sedang aktif.</div>';
      return;
    }

    otherCams.forEach(c => {
      const card = document.createElement('div');
      card.className = `side-cam-card ${c.hasSegment ? 'has-media' : 'no-media'}`;
      card.title = `Klik untuk beralih ke ${c.name} pada jam ini`;

      const badgeText = c.motion > 0 ? '⚡ Motion' : (c.hasSegment ? 'REC' : 'Kosong');
      const badgeClass = c.motion > 0 ? 'badge-motion' : (c.hasSegment ? 'badge-rec' : 'badge-empty');
      const actionText = c.hasSegment ? 'Tukar &rarr;' : 'Tidak Ada';

      card.innerHTML = `
        <div class="side-cam-thumb">
          <div class="side-cam-placeholder">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"></path>
              <circle cx="12" cy="13" r="4"></circle>
            </svg>
          </div>
          <span class="side-cam-badge ${badgeClass}">${badgeText}</span>
        </div>
        <div class="side-cam-info">
          <span class="side-cam-name">${c.name}</span>
          <span class="side-cam-action">${actionText}</span>
        </div>
      `;

      card.addEventListener('click', () => {
        // Switch to this camera at current timestamp
        loadTimeline(c.id, currentDate, currentPlayheadEpoch);
      });

      sideCameraList.appendChild(card);
    });
  }

  // --- UI Helpers ---
  function setPlayingUI(playing) {
    isPlaying = playing;
    if (playing) {
      iconPlay.style.display = 'none';
      iconPause.style.display = 'inline-block';
      labelPlayPause.textContent = 'Pause';
    } else {
      iconPlay.style.display = 'inline-block';
      iconPause.style.display = 'none';
      labelPlayPause.textContent = 'Play';
    }
  }

  function updateCameraPillUI(camId) {
    cameraSelector.querySelectorAll('.cam-radio-pill').forEach(pill => {
      if (pill.dataset.cam === camId || (camId === 'teras_depan' && pill.dataset.cam === 'all')) {
        pill.classList.add('active');
      } else {
        pill.classList.remove('active');
      }
    });
  }

  function getCameraDisplayName(camId) {
    const pill = cameraSelector.querySelector(`.cam-radio-pill[data-cam="${camId}"]`);
    return pill ? pill.querySelector('span:last-child').textContent : camId;
  }

  // Run on DOM Ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
