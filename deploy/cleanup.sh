#!/bin/bash
# ReClip cleanup — delete files (not db rows) older than 24h
# DB rows stay so users see "expired" status in history
set -e
DOWNLOADS_DIR="/opt/reclip/downloads"
if [ -d "$DOWNLOADS_DIR" ]; then
    # Delete files older than 24h
    find "$DOWNLOADS_DIR" -type f -mmin +1440 -delete 2>/dev/null || true
    # Delete now-empty job dirs
    find "$DOWNLOADS_DIR" -mindepth 1 -type d -empty -delete 2>/dev/null || true
fi
