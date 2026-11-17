'use strict';
/** Changed-reader qualification reuses maintained real and mock bidirectional latency cases. */
const path = require('node:path');
const base = require('./logs-qualification.config');
module.exports = { ...base, testMatch: 'logs-scroll.spec.js',
    grep: /Logs bidirectional history.*flow\/bottom|Logs real byte cursors.*timeline\/top/,
    webServer: { ...base.webServer, cwd: process.env.PCM_NAV_REPO
        ? path.join(process.env.PCM_NAV_REPO, 'pcm-connectathon/ui') : __dirname },
    projects: base.projects.slice(0, 2) };
