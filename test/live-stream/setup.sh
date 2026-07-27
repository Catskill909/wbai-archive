#!/bin/sh
# Generates the two artifacts the harness needs but must not commit: a test tone
# and a self-signed cert for the fake station. Safe to re-run.
set -e
cd "$(dirname "$0")"

if [ ! -f tone.mp3 ]; then
  # 3% amplitude on purpose — headless Chrome can still reach the speakers, and
  # a full-volume sine at 440 Hz is a genuinely unpleasant surprise. Ask me how.
  ffmpeg -hide_banner -loglevel error \
    -f lavfi -i "sine=frequency=440:duration=60" -af "volume=0.03" \
    -ac 1 -ar 44100 -b:a 64k -f mp3 tone.mp3 -y
  echo "generated tone.mp3"
fi

if [ ! -f cert.pem ]; then
  openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 30 -nodes \
    -subj "/CN=streaming.wbai.org" \
    -addext "subjectAltName=DNS:streaming.wbai.org" 2>/dev/null
  echo "generated cert.pem / key.pem (self-signed, test only)"
fi

echo "ready — now run ./run.sh"
