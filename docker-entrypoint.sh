#!/bin/sh
set -e

echo "Applying database migrations..."
npx prisma migrate deploy

if [ "$SEED_ON_START" = "true" ]; then
  echo "Seeding database (SEED_ON_START=true)..."
  npx tsx prisma/seed.ts
fi

echo "Starting PKT API..."
exec node dist/server.js
