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

  // IMPORTANT: build the item objects ONCE and reuse the SAME references on
  // every update. systray2 stamps an internal `__id` onto each item during
  // init() (addInternalId) and resolves clicks through that id — but it does
  // NOT re-stamp on an `update-menu`. If we handed it fresh objects each time,
  // post-update clicks would carry an undefined id, systray2 would throw while
  // resolving them, and our handler would never fire. That's the "can stop but
  // can't start the server again" bug. Mutating these in place keeps the ids
  // (and therefore clicks) alive across toggles.
  const items = [
    { title: 'Open dashboard', tooltip: 'Open the PhotoSync Server dashboard', enabled: true },
    { title: 'Stop server', tooltip: 'Start/stop backups', enabled: true },
    { title: 'Open backup folder', tooltip: 'Show where photos are saved', enabled: true },
    SysTray.separator,
    { title: 'Quit PhotoSync Server', tooltip: 'Stop and exit', enabled: true },
  ];
  const applyRunning = (isRunning) => {
    items[TOGGLE].title = isRunning ? 'Stop server' : 'Start server';
  };
  applyRunning(running);

  const systray = new SysTray({
    menu: {
      icon: running ? icons.running : icons.stopped,
      isTemplateIcon: false,
      title: '',
      tooltip: tooltip || 'PhotoSync Server',
      items,
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
        applyRunning(isRunning); // mutate the shared items in place (keeps __id)
        systray.sendAction({
          type: 'update-menu',
          menu: {
            icon: isRunning ? icons.running : icons.stopped,
            isTemplateIcon: false,
            title: '',
            tooltip: tip || 'PhotoSync Server',
            items,
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
