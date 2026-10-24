# SkyGuard - SkyConnection Surveillance System

High-performance enterprise surveillance portal and edge streaming hub for SkyConnection Indonesia.

## Key Features

1. **Edge go2rtc Relay**: Dokploy connects to OpenWrt Frigate RTSP (`rtsp://100.65.136.42:8554/*`) over Tailscale, pulling each camera stream **strictly once** to conserve upstream bandwidth, then serving unlimited concurrent WebRTC streams to web clients.
2. **16:9 Anamorphic Widescreen**: Automatic aspect-ratio correction for Hikvision 1080p Lite (960x1080) camera streams to display in true 16:9 widescreen without distortion.
3. **Multi-Camera Grid**: Interactive monitoring hub with responsive 3x3 (all 9 cameras), 2x2, and 1x1 focus views, fullscreen zoom, and live timestamps.
4. **S3 Recordings Archive**: Direct integration with RustFS S3 storage (`https://s3api1.skyconnection.id`, bucket `frigate`). Filter by date, hour, and camera with in-browser byte-range video streaming, playback speed controls (1.0x to 4.0x), and MP4 clip downloads.
5. **Secure Authentication Gate**: Session-based credentials protection before accessing live feeds or video archives.

## Camera Inventory

- `teras_depan`: Teras Depan (Hikvision Main Stream)
- `camera_02`: Area Kantor (Hikvision Main Stream)
- `camera_03`: Lobi & Koridor (Hikvision Main Stream)
- `camera_04`: Ruang Rapat (Hikvision Main Stream)
- `camera_05`: Ruang Kerja 1 (Hikvision Main Stream)
- `camera_06`: Ruang Kerja 2 (Hikvision Main Stream)
- `camera_07`: Area Belakang (Hikvision Main Stream)
- `camera_08`: Server / NOC Room (Hikvision Main Stream)
- `dcs_5020l`: Indoor Lounge (D-Link DCS-5020L)

## Quick Start (Docker Compose)

```bash
docker compose up -d --build
```

Access at `http://localhost:3000` or via Dokploy domain `https://skyguard.skyconnection.id`.
