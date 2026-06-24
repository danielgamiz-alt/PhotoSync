'use strict';

const fs = require('fs');

/**
 * System-tray icon + menu via systray2 (which ships a tiny helper binary).
 * Lazy/guarded: if systray2 isn't installed, returns null and the app keeps
 * running headlessly (dashboard still works).
 *
 * handlers = { onOpenDashboard, onToggleServer, onOpenFolder, onQuit }
 */
async function createTray({ runningIcoPath, stoppedIcoPath, running, tooltip, handlers }) {
  let SysTray;
  try {
    SysTray = require('systray2').default;
  } catch {
    return null;
  }

  const icoBase64 = (p) => fs.readFileSync(p).toString('base64');
  const icons = { running: icoBase64(runningIcoPath), stopped: icoBase64(stoppedIcoPath) };

  // Menu order is fixed so we can dispatch clicks by seq_id.
  const TOGGLE = 1;
  const buildItems = (isRunning) => [
    { title: 'Open dashboard', tooltip: 'Open the PhotoSync Server dashboard', enabled: true },
    { title: isRunning ? 'Stop server' : 'Start server', tooltip: 'Start/stop backups', enabled: true },
    { title: 'Open backup folder', tooltip: 'Show where photos are saved', enabled: true },
    SysTray.separator,
    { title: 'Quit PhotoSync Server', tooltip: 'Stop and exit', enabled: true },
  ];

  const systray = new SysTray({
    menu: {
      icon: running ? icons.running : icons.stopped,
      isTemplateIcon: false,
      title: '',
      tooltip: tooltip || 'PhotoSync Server',
      items: buildItems(running),
    },
    debug: false,
    copyDir: true,
  });

  systray.onClick((action) => {
    try {
      switch (action.seq_id) {
        case 0:
          handlers.onOpenDashboard();
          break;
        case TOGGLE:
          handlers.onToggleServer();
          break;
        case 2:
          handlers.onOpenFolder();
          break;
        case 4:
          handlers.onQuit();
          break;
      }
    } catch {
      /* ignore click handler errors */
    }
  });

  await systray.ready();

  return {
    update({ running: isRunning, tooltip: tip }) {
      try {
        systray.sendAction({
          type: 'update-menu',
          menu: {
            icon: isRunning ? icons.running : icons.stopped,
            isTemplateIcon: false,
            title: '',
            tooltip: tip || 'PhotoSync Server',
            items: buildItems(isRunning),
          },
        });
      } catch {
        /* tray update is best-effort */
      }
    },
    kill() {
      try {
        systray.kill(false);
      } catch {
        /* already gone */
      }
    },
  };
}

module.exports = { createTray };
