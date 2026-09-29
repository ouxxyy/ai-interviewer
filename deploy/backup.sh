#!/bin/bash
# Consistent local backup: stop only this service; always start it again on exit.
set -euo pipefail
umask 077
exec 9>/run/ai-interviewer-backup.lock
flock -n 9 || exit 0
install -d -m 700 /www/ai-interviewer/backups
archive="/www/ai-interviewer/backups/data-$(date +%Y%m%d-%H%M%S).tar.gz"
trap 'systemctl start ai-interviewer' EXIT
systemctl stop ai-interviewer
tar -C /www/ai-interviewer -czf "$archive" data
tar -tzf "$archive" >/dev/null
systemctl start ai-interviewer
trap - EXIT
# Retention is scoped to archives produced by this script, never live data.
find /www/ai-interviewer/backups -maxdepth 1 -type f -name 'data-????????-??????.tar.gz' -mtime +7 -delete
stat -c 'backup bytes=%s mode=%a' "$archive"
