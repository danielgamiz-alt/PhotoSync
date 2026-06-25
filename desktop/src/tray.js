'use strict';

const fs = require('fs');

/**
 * System-tray icon + menu via systray2 (which ships a tiny helper binary).
 * Lazy/guarded: if systray2 isn't installed, returns null and the app keeps
 * running headlessly (dashboard still works).
 *
 * handlers = { onOpenDashboard, onSetRunning, onOpenFolder, onQuit }
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
  // Rather than one toggle whose label has to change (the Windows tray binary
  // won't re-render an item's *title* on an update), we use two fixed-label
  // buttons and just flip which one is enabled. Greying is an `enabled` change,
  // which `update-item` DOES apply in place.
  const START = 1;
  const STOP = 2;

  // IMPORTANT: build the item objects ONCE and reuse the SAME references on
  // every update. systray2 stamps an internal `__id` onto each item during
  // init() (addInternalId) and resolves clicks through that id — but it does
  // NOT re-stamp on an `update-menu`. If we handed it fresh objects each time,
  // post-update clicks would carry an undefined id, systray2 would throw while
  // resolving them, and our handler would never fire. That's the "can stop but
  // can't start the server again" bug. Mutating these in place keeps the ids
  // (and therefore clicks) alive across updates.
  const items = [
    { title: 'Open dashboard', tooltip: 'Open the PhotoSync Server dashboard', enabled: true },
    { title: 'Start server', tooltip: 'Start backups', enabled: !running },
    { title: 'Stop server', tooltip: 'Stop backups', enabled: running },
    { title: 'Open backup folder', tooltip: 'Show where photos are saved', enabled: true },
    SysTray.separator,
    { title: 'Quit PhotoSync Server', tooltip: 'Stop and exit', enabled: true },
  ];
  const applyRunning = (isRunning) => {
    // Grey out whichever action doesn't apply in the current state.
    items[START].enabled = !isRunning;
    items[STOP].enabled = isRunning;
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
        case START:
          handlers.onSetRunning(true);
          break;
        case STOP:
          handlers.onSetRunning(false);
          break;
        case 3:
          handlers.onOpenFolder();
          break;
        case 5:
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
        // The tray icon is a menu-level property, refreshed via update-menu.
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
        // The Start/Stop enabled (grey) state is item-level; update-menu won't
        // re-render it, so refresh each button with update-item (resolved by its
        // __id — the documented, Windows-supported way to change an item).
        systray.sendAction({ type: 'update-item', item: items[START] });
        systray.sendAction({ type: 'update-item', item: items[STOP] });
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
