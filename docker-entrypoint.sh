#!/bin/sh
set -e

# Fix ownership of the data volume (may have been created by a previous root deployment)
if [ -d /data ]; then
  chown -R appuser:appuser /data
fi

# Drop privileges and run the app as appuser
exec su -s /bin/sh appuser -c "node server/server.js"
