const path = require('path');

// In a packaged build, files the runner needs are unpacked next to app.asar,
// because launchd starts them with a plain Node runtime that can't read the archive.
function unpacked(p) {
  return p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

module.exports = { unpacked };
