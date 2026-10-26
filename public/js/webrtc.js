/**
 * SkyGuard WebRTC Stream Controller
 * Connects directly to go2rtc edge relay via backend WebRTC proxy
 * Enforces low-latency H.264 streaming and 16:9 anamorphic display
 */

class SkyStreamer {
  constructor(cardId, streamName, videoId, loaderId) {
    this.cardId = cardId;
    this.streamName = streamName;
    this.video = document.getElementById(videoId);
    this.loader = document.getElementById(loaderId);
    this.pc = null;
    this.reconnectTimer = null;
    this.watchdogInterval = null;
    this.lastCurrentTime = -1;
    this.stallTicks = 0;
    this.isClosed = false;
    this.retryCount = 0;
  }

  async connect() {
    if (this.isClosed) return;
    this.cleanupPeerConnection();

    if (this.video) {
      this.video.playsInline = true;
      this.video.muted = true;
    }

    if (this.loader) {
      this.loader.style.display = 'flex';
      this.loader.querySelector('span')?.setText?.('Negotiating WebRTC...') || 
        (this.loader.querySelector('span').textContent = 'Negotiating WebRTC...');
    }

    try {
      this.pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ]
      });

      // Receive only video & audio
      this.pc.addTransceiver('video', { direction: 'recvonly' });
      this.pc.addTransceiver('audio', { direction: 'recvonly' });

      this.pc.ontrack = (event) => {
        if (event.streams && event.streams[0]) {
          this.video.srcObject = event.streams[0];
          this.video.play().catch(e => {
            console.warn(`Autoplay blocked on stream ${this.streamName}:`, e);
          });
          if (this.loader) {
            this.loader.style.display = 'none';
          }
          this.retryCount = 0;
          this.startWatchdog();
        }
      };

      this.pc.onconnectionstatechange = () => {
        const state = this.pc?.connectionState;
        if (state === 'connected') {
          if (this.loader) this.loader.style.display = 'none';
          this.startWatchdog();
        } else if (state === 'failed' || state === 'disconnected') {
          console.warn(`Stream [${this.streamName}] connection state: ${state}. Reconnecting...`);
          this.scheduleReconnect(2500);
        }
      };

      // Create SDP Offer
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      // Wait for ICE gathering to complete or timeout
      await new Promise(resolve => {
        if (this.pc.iceGatheringState === 'complete') {
          resolve();
        } else {
          const checkState = () => {
            if (this.pc.iceGatheringState === 'complete') {
              this.pc.removeEventListener('icegatheringstatechange', checkState);
              resolve();
            }
          };
          this.pc.addEventListener('icegatheringstatechange', checkState);
          setTimeout(resolve, 1500); // 1.5s max gather time
        }
      });

      // Send SDP Offer to SkyGuard WebRTC Proxy
      const response = await fetch(`/api/webrtc?src=${encodeURIComponent(this.streamName)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain'
        },
        body: this.pc.localDescription.sdp
      });

      if (!response.ok) {
        throw new Error(`Proxy error HTTP ${response.status}`);
      }

      const answerSdp = await response.text();
      if (!answerSdp || answerSdp.trim().length === 0) {
        throw new Error('Empty SDP answer received from relay');
      }

      await this.pc.setRemoteDescription({
        type: 'answer',
        sdp: answerSdp
      });

    } catch (err) {
      console.error(`WebRTC streaming error for ${this.streamName}:`, err);
      if (this.loader) {
        this.loader.style.display = 'flex';
        const span = this.loader.querySelector('span');
        if (span) {
          span.textContent = `Retrying (${err.message.substring(0, 28)})...`;
        }
      }
      this.retryCount++;
      const backoff = Math.min(2000 * Math.pow(1.5, this.retryCount), 15000);
      this.scheduleReconnect(backoff);
    }
  }

  scheduleReconnect(delayMs) {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.isClosed) return;
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delayMs);
  }

  startWatchdog() {
    this.stopWatchdog();
    this.lastCurrentTime = -1;
    this.stallTicks = 0;
    this.watchdogInterval = setInterval(() => {
      if (this.isClosed || !this.video || !this.pc) return;
      if (document.visibilityState === 'hidden') return;

      // Ensure video is not paused by browser
      if (this.pc.connectionState === 'connected' && this.video.srcObject) {
        if (this.video.paused) {
          this.video.play().catch(() => {});
        }

        const curTime = this.video.currentTime;
        if (curTime > 0) {
          if (Math.abs(curTime - this.lastCurrentTime) < 0.05) {
            this.stallTicks++;
            // Kickstart playback
            this.video.play().catch(() => {});

            // If time hasn't moved for 3 checks (~7.5s), trigger clean reconnect
            if (this.stallTicks >= 3) {
              console.warn(`[SkyStreamer] Video freeze detected for [${this.streamName}] at ${curTime.toFixed(2)}s. Auto-reconnecting...`);
              this.stallTicks = 0;
              this.connect();
            }
          } else {
            this.stallTicks = 0;
            this.lastCurrentTime = curTime;
          }
        }
      }
    }, 2500);
  }

  stopWatchdog() {
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
    }
  }

  cleanupPeerConnection() {
    this.stopWatchdog();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pc) {
      try {
        this.pc.close();
      } catch (e) {}
      this.pc = null;
    }
  }

  close() {
    this.isClosed = true;
    this.cleanupPeerConnection();
    if (this.video) {
      this.video.srcObject = null;
    }
  }
}

// Global registry of camera streamers
window.skyStreamers = {};

// Auto-recover streams when tab/phone becomes visible again
if (!window._skyStreamerVisibilityAttached) {
  window._skyStreamerVisibilityAttached = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      const streamers = Object.values(window.skyStreamers || {});
      streamers.forEach(streamer => {
        if (streamer && !streamer.isClosed && streamer.video) {
          if (streamer.video.paused) {
            streamer.video.play().catch(() => {});
          }
          streamer.lastCurrentTime = -1;
          streamer.stallTicks = 0;
        }
      });
    }
  });
}
