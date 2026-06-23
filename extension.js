import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const DEFAULT_REFRESH_INTERVAL = 30; // seconds (fallback rescan)
const DEBOUNCE_MS = 600; // coalesce bursts of file-change events
const RECENT_SUBDIR_MS = 2 * 24 * 60 * 60 * 1000; // watch subdirs modified within 2 days
const SESSION_DIR = GLib.build_filenamev([GLib.get_home_dir(), '.copilot', 'session-state']);
const DEBUG = false;

const CopilotUsageIndicator = GObject.registerClass(
class CopilotUsageIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'Copilot Usage');

        this._extension = extension;
        this._settings = extension.getSettings();
        // Bundled copy of the copilot-usage-cli script, run with node.
        this._scriptPath = GLib.build_filenamev([extension.path, 'copilot-usage.js']);
        this._nodePath = GLib.find_program_in_path('node') || '/usr/bin/node';

        this._data = null;
        this._lastUpdated = null;
        this._lastError = null;

        this._refreshTimeoutId = null;
        this._tickTimeoutId = null;
        this._debounceTimeoutId = null;
        this._scanning = false;
        this._rescanPending = false;

        this._dirMonitor = null;
        this._subdirMonitors = new Map(); // path -> Gio.FileMonitor

        // Panel label: "D: $x.xx  W: $y.yy"
        this._box = new St.BoxLayout({
            style_class: 'panel-status-menu-box copilot-usage-box',
        });
        this.add_child(this._box);

        this._panelLabel = new St.Label({
            text: 'D: $--  W: $--',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'copilot-panel-label',
        });
        this._box.add_child(this._panelLabel);

        this._buildMenu();

        this._setupMonitors();
        this._startTimers();
        this._scan();
    }

    _buildMenu() {
        const header = new PopupMenu.PopupMenuItem('GitHub Copilot Usage');
        header.setSensitive(false);
        header.label.add_style_class_name('copilot-section-title');
        this.menu.addMenuItem(header);

        this._todayItem = new PopupMenu.PopupMenuItem('Today: $--');
        this._todayItem.setSensitive(false);
        this.menu.addMenuItem(this._todayItem);

        this._weekItem = new PopupMenu.PopupMenuItem('This week: $--');
        this._weekItem.setSensitive(false);
        this.menu.addMenuItem(this._weekItem);

        this._monthItem = new PopupMenu.PopupMenuItem('This month: $--');
        this._monthItem.setSensitive(false);
        this.menu.addMenuItem(this._monthItem);

        this._allItem = new PopupMenu.PopupMenuItem('All time: $--');
        this._allItem.setSensitive(false);
        this.menu.addMenuItem(this._allItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._todayMenu = new PopupMenu.PopupSubMenuMenuItem("Today's Sessions");
        this.menu.addMenuItem(this._todayMenu);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._lastUpdatedItem = new PopupMenu.PopupMenuItem('Last updated: --');
        this._lastUpdatedItem.setSensitive(false);
        this._lastUpdatedItem.label.add_style_class_name('copilot-dim-label');
        this.menu.addMenuItem(this._lastUpdatedItem);

        const refreshItem = new PopupMenu.PopupMenuItem('Refresh');
        refreshItem.activate = (_event) => {
            this._scan(); // don't close the menu
        };
        this.menu.addMenuItem(refreshItem);

        const settingsItem = new PopupMenu.PopupMenuItem('Settings');
        settingsItem.connect('activate', () => {
            this._extension.openPreferences();
        });
        this.menu.addMenuItem(settingsItem);
    }

    // --- File watching ---------------------------------------------------

    _setupMonitors() {
        try {
            const dir = Gio.File.new_for_path(SESSION_DIR);
            if (!dir.query_exists(null)) {
                return;
            }

            // Top-level monitor: catches new session sub-directories appearing.
            this._dirMonitor = dir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._dirMonitor.connect('changed', (_monitor, file, _otherFile, eventType) => {
                if (eventType === Gio.FileMonitorEvent.CREATED) {
                    this._addSubdirMonitor(file.get_path());
                }
                this._queueScan();
            });

            // Watch each recently-active session sub-directory, so appends to its
            // events.jsonl (in particular the shutdown event) fire a rescan.
            this._enumerateRecentSubdirs(dir);
        } catch (e) {
            console.error('Copilot Usage: failed to set up file monitors', e);
        }
    }

    _enumerateRecentSubdirs(dir) {
        dir.enumerate_children_async(
            'standard::name,standard::type,time::modified',
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            null,
            (src, res) => {
                let enumerator;
                try {
                    enumerator = src.enumerate_children_finish(res);
                } catch (e) {
                    return;
                }
                const now = GLib.get_real_time() / 1000; // ms
                let info;
                while ((info = enumerator.next_file(null)) !== null) {
                    if (info.get_file_type() !== Gio.FileType.DIRECTORY) {
                        continue;
                    }
                    const mtime = info.get_modification_date_time?.();
                    let mtimeMs = now;
                    if (mtime) {
                        mtimeMs = mtime.to_unix() * 1000;
                    }
                    if (now - mtimeMs > RECENT_SUBDIR_MS) {
                        continue;
                    }
                    const child = dir.get_child(info.get_name());
                    this._addSubdirMonitor(child.get_path());
                }
                enumerator.close_async(GLib.PRIORITY_DEFAULT, null, null);
            }
        );
    }

    _addSubdirMonitor(path) {
        if (!path || this._subdirMonitors.has(path)) {
            return;
        }
        try {
            const file = Gio.File.new_for_path(path);
            if (file.query_file_type(Gio.FileQueryInfoFlags.NONE, null) !== Gio.FileType.DIRECTORY) {
                return;
            }
            const monitor = file.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            monitor.connect('changed', () => this._queueScan());
            this._subdirMonitors.set(path, monitor);
        } catch (e) {
            if (DEBUG) console.error('Copilot Usage: failed to monitor subdir', path, e);
        }
    }

    _queueScan() {
        if (this._debounceTimeoutId) {
            return;
        }
        this._debounceTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
            this._debounceTimeoutId = null;
            this._scan();
            return GLib.SOURCE_REMOVE;
        });
    }

    // --- Scanning --------------------------------------------------------

    _startTimers() {
        const interval = this._settings.get_int('refresh-interval') || DEFAULT_REFRESH_INTERVAL;
        this._refreshTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
            this._scan();
            return GLib.SOURCE_CONTINUE;
        });

        // Refresh the "last updated" relative time once a minute.
        this._tickTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._updateLastUpdatedLabel();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _scan() {
        if (this._scanning) {
            this._rescanPending = true;
            return;
        }
        this._scanning = true;

        let proc;
        try {
            proc = Gio.Subprocess.new(
                [this._nodePath, this._scriptPath, '--json'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
        } catch (e) {
            this._scanning = false;
            this._setError(e.message || 'spawn failed');
            return;
        }

        proc.communicate_utf8_async(null, null, (p, res) => {
            this._scanning = false;
            try {
                const [, stdout, stderr] = p.communicate_utf8_finish(res);
                if (!p.get_successful()) {
                    throw new Error(stderr?.trim() || 'scan script failed');
                }
                this._data = JSON.parse(stdout);
                this._lastUpdated = new Date();
                this._lastError = null;
                if (DEBUG) console.log('Copilot Usage scan:', stdout);
                this._updateDisplay();
            } catch (e) {
                console.error('Copilot Usage: scan failed', e);
                this._setError(e.message || 'scan failed');
            }

            if (this._rescanPending) {
                this._rescanPending = false;
                this._scan();
            }
        });
    }

    // --- Display ---------------------------------------------------------

    _rate() {
        const r = this._settings.get_double('aic-rate');
        return r > 0 ? r : 0.01;
    }

    _dollars(aic) {
        return `$${((aic || 0) * this._rate()).toFixed(2)}`;
    }

    _updateDisplay() {
        if (!this._data) return;

        const today = this._dollars(this._data.today_aic);
        const week = this._dollars(this._data.week_aic);

        this._panelLabel.set_text(`D: ${today}  W: ${week}`);

        this._todayItem.label.set_text(`Today: ${today}`);
        this._weekItem.label.set_text(`This week: ${week}`);
        this._monthItem.label.set_text(`This month: ${this._dollars(this._data.month_aic)}`);
        this._allItem.label.set_text(`All time: ${this._dollars(this._data.all_aic)}`);

        this._updateTodayMenu();
        this._updateLastUpdatedLabel();
    }

    _updateTodayMenu() {
        this._todayMenu.menu.removeAll();
        const today = this._data?.today_sessions || [];

        if (today.length === 0) {
            const empty = new PopupMenu.PopupMenuItem('No sessions today');
            empty.setSensitive(false);
            this._todayMenu.menu.addMenuItem(empty);
        } else {
            for (const s of today) {
                const when = this._formatWhen(s.start_ms);
                const id8 = (s.id || '').slice(0, 8);
                const item = new PopupMenu.PopupMenuItem(
                    `${this._dollars(s.aic)}  ${id8}  ${when}  (${s.total_messages} msg, ${s.tool_calls} tools)`
                );
                item.setSensitive(false);
                item.label.add_style_class_name('copilot-truncate-label');
                item.label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
                this._todayMenu.menu.addMenuItem(item);
            }
        }

        this._todayMenu.label.set_text(`Today's Sessions (${today.length})`);
    }

    _updateLastUpdatedLabel() {
        if (this._lastError) {
            this._lastUpdatedItem.label.set_text(`Error: ${this._lastError}`);
            return;
        }
        if (!this._lastUpdated) {
            this._lastUpdatedItem.label.set_text('Last updated: --');
            return;
        }
        const diffMins = Math.floor((new Date() - this._lastUpdated) / 60000);
        let text;
        if (diffMins < 1) text = 'just now';
        else if (diffMins === 1) text = '1 minute ago';
        else if (diffMins < 60) text = `${diffMins} minutes ago`;
        else {
            const h = Math.floor(diffMins / 60);
            text = h === 1 ? '1 hour ago' : `${h} hours ago`;
        }
        this._lastUpdatedItem.label.set_text(`Last updated: ${text}`);
    }

    _formatWhen(startMs) {
        if (!startMs) return '';
        try {
            const date = new Date(startMs);
            const now = new Date();
            const hh = date.getHours().toString().padStart(2, '0');
            const mm = date.getMinutes().toString().padStart(2, '0');
            const time = `${hh}:${mm}`;
            if (date.toDateString() === now.toDateString()) {
                return time;
            }
            const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
            return `${days[date.getDay()]} ${time}`;
        } catch (e) {
            return '';
        }
    }

    _setError(msg) {
        this._lastError = msg || 'Unknown error';
        this._panelLabel.set_text('D: ERR  W: ERR');
        this._updateLastUpdatedLabel();
    }

    destroy() {
        if (this._refreshTimeoutId) {
            GLib.source_remove(this._refreshTimeoutId);
            this._refreshTimeoutId = null;
        }
        if (this._tickTimeoutId) {
            GLib.source_remove(this._tickTimeoutId);
            this._tickTimeoutId = null;
        }
        if (this._debounceTimeoutId) {
            GLib.source_remove(this._debounceTimeoutId);
            this._debounceTimeoutId = null;
        }
        if (this._dirMonitor) {
            this._dirMonitor.cancel();
            this._dirMonitor = null;
        }
        for (const monitor of this._subdirMonitors.values()) {
            monitor.cancel();
        }
        this._subdirMonitors.clear();
        super.destroy();
    }
});

export default class CopilotUsageExtension extends Extension {
    enable() {
        this._indicator = new CopilotUsageIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
