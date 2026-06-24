'use strict';

const path = require('path');

/**
 * Desktop toast notifications via node-notifier. Loaded lazily so the rest of
 * the app (server + dashboard) still runs if the optional dependency isn't
 * installed yet. Notifications can be toggled from the dashboard.
 */
class Notifier {
  constructor(enabled = true) {
    this.enabled = enabled;
    this._notifier = null;
    try {
      this._notifier = require('node-notifier');
    } catch {
      this._notifier = null; // not installed; notifications silently disabled
    }
  }

  get available() {
    return this._notifier !== null;
  }

  notify(title, message) {
    if (!this.enabled || !this._notifier) return;
    try {
      this._notifier.notify({
        appName: 'PhotoSync Server',
        title,
        message,
        icon: path.join(__dirname, '..', 'assets', 'app.png'),
      });
    } catch {
      /* never let a notification failure affect backups */
    }
  }
}

module.exports = { Notifier };
