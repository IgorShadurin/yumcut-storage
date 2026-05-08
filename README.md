# YumCut Storage

Storage worker service for YumCut. This repository handles media persistence and media-serving endpoints used by the main YumCut app.

Related links:

- Main YumCut app repository: https://github.com/IgorShadurin/app.yumcut.com
- YumCut website: https://yumcut.com/

## What This Service Does

- Stores uploaded media files under a configurable media root.
- Serves stored media through `/api/media/[...path]`.
- Exposes storage-oriented API routes for uploads/deletes and health checks.
- Supports CORS allowlists and optional signed media access controls.

## Local Development

1. Install dependencies:

```bash
npm install
```

2. Create local env config:

```bash
cp env.example .env.local
```

3. Start dev server:

```bash
npm run dev
```

By default this repo runs on `http://localhost:3333` in dev mode.

## Quality Checks

```bash
npm run lint
npm run types:check
npm test
```
