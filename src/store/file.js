'use strict';
// File storage adapter: keeps the whole app state in one JSON file.
// Used by the local Docker deployment (the file lives on a mounted volume).
// Other deployments (e.g. AWS) provide another adapter with the same two methods.
const fs = require('fs');
const path = require('path');

function createFileStore(dataDir) {
  const file = path.join(dataDir, 'db.json');
  fs.mkdirSync(dataDir, { recursive: true });

  return {
    name: `file (${file})`,

    async load() {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        if (e.code === 'ENOENT') return null; // first run
        // keep a copy of an unreadable file instead of silently overwriting it
        const bad = `${file}.corrupt-${Date.now()}`;
        try { fs.copyFileSync(file, bad); } catch (_) {}
        console.error(`Could not read ${file} (${e.message}); saved a copy to ${bad} and starting fresh`);
        return null;
      }
    },

    // write to a temp file then rename, so a crash mid-write never leaves a half-written file
    async save(db) {
      const tmp = `${file}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(db));
      await fs.promises.rename(tmp, file);
    },
  };
}

module.exports = { createFileStore };
