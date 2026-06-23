'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const CONFIG_FILE = path.join(__dirname, '..', 'config.json');

const DEFAULTS = {
  port: 8420,
  discoveryPort: 38899,
  // Where photos are stored. Point this at your external SSD,
  // e.g. "E:/PhotoBackup" on Windows or "/mnt/ssd/photos" on a Raspberry Pi.
  storagePath: path.join(__dirname, '..', 'photos'),
  serverName: os.hostname(),
  // Optional shared secret. If non-empty, clients must send it
  // as the "x-api-key" header on every request.
  apiKey: '',
  // Optional second folder/drive that backups are also copied to, so the
  // backup itself has a backup. Empty = disabled.
  mirrorPath: '',
};

function load(argv) {
  let fileConfig = {};
  if (fs.existsSync(CONFIG_FILE)) {
    fileConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } else {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULTS, null, 2) + '\n');
    console.log(`Created default config at ${CONFIG_FILE}`);
  }

  const config = { ...DEFAULTS, ...fileConfig };

  // CLI overrides: --storage <path> --port <n> --name <name>
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--storage' && argv[i + 1]) config.storagePath = argv[++i];
    if (argv[i] === '--port' && argv[i + 1]) config.port = parseInt(argv[++i], 10);
    if (argv[i] === '--discovery-port' && argv[i + 1]) config.discoveryPort = parseInt(argv[++i], 10);
    if (argv[i] === '--name' && argv[i + 1]) config.serverName = argv[++i];
  }

  config.storagePath = path.resolve(config.storagePath);

  // Stable id so phones can tell servers apart even if the IP changes.
  const idFile = path.join(path.dirname(CONFIG_FILE), '.server-id');
  if (fs.existsSync(idFile)) {
    config.serverId = fs.readFileSync(idFile, 'utf8').trim();
  } else {
    config.serverId = crypto.randomUUID();
    fs.writeFileSync(idFile, config.serverId + '\n');
  }

  return config;
}

// Persist the user-facing fields back to config.json. Runtime-only fields
// (serverId) are deliberately not written. Returns the persisted subset.
function save(config) {
  const persistable = {
    port: config.port,
    discoveryPort: config.discoveryPort,
    storagePath: config.storagePath,
    serverName: config.serverName,
    apiKey: config.apiKey,
    mirrorPath: config.mirrorPath || '',
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(persistable, null, 2) + '\n');
  return persistable;
}

module.exports = { load, save, CONFIG_FILE, DEFAULTS };
