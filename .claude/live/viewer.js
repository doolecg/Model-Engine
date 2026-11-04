// Graph viewer entry: node .claude/live/viewer.js [--idle-min N]. Same server code, viewer routes only.
process.env.MODEL_ENGINE_MODE = 'viewer';
require('./server.js');
