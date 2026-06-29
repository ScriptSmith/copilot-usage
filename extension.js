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

// Time buckets, matching the CLI's `periods`. Each is a top-level submenu whose
// title shows the period total and which nests Sessions/Models/Directories/Repositories.
const PERIODS = ['today', 'week', 'month', 'all'];
const PERIOD_LABELS = { today: 'Today', week: 'This week', month: 'This month', all: 'All time' };
const MAX_MENU_ROWS = 15; // cap rows per (sub)menu; show "... N more" beyond this

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

        // One submenu per period (Today / This week / This month / All time). The
        // title carries the period total; inside, nested submenus break that total
        // down by Sessions, Models, Directories, and Repositories.
        this._periodMenus = {};
        for (const key of PERIODS) {
            const root = new PopupMenu.PopupSubMenuMenuItem(`${PERIOD_LABELS[key]}: $--`);
            const sessions = new PopupMenu.PopupSubMenuMenuItem('Sessions');
            const models = new PopupMenu.PopupSubMenuMenuItem('Models');
            const directories = new PopupMenu.PopupSubMenuMenuItem('Directories');
            const repositories = new PopupMenu.PopupSubMenuMenuItem('Repositories');
            root.menu.addMenuItem(sessions);
            root.menu.addMenuItem(models);
            root.menu.addMenuItem(directories);
            root.menu.addMenuItem(repositories);
            this.menu.addMenuItem(root);
            this._makeNestable(root, [sessions, models, directories, repositories]);
            this._periodMenus[key] = { root, sessions, models, directories, repositories };
        }

        // Sessions that ended abnormally (crash/kill/reboot) or are still open
        // never wrote a shutdown event, so their usage is uncounted. A submenu so
        // they can be inspected; the title warns only about recent ones (older are
        // listed but dimmed). Hidden when there are none.
        this._incompleteMenu = new PopupMenu.PopupSubMenuMenuItem('Incomplete sessions');
        this._incompleteMenu.visible = false;
        this.menu.addMenuItem(this._incompleteMenu);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Reconciliation anomalies (collector vs on-disk shutdown). Hidden at zero.
        this._anomaliesMenu = new PopupMenu.PopupSubMenuMenuItem('Anomalies');
        this._anomaliesMenu.visible = false;
        this.menu.addMenuItem(this._anomaliesMenu);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Live-collector status line. Hidden until we know one way or the other.
        this._collectorItem = new PopupMenu.PopupMenuItem('');
        this._collectorItem.setSensitive(false);
        this._collectorItem.label.add_style_class_name('copilot-dim-label');
        this._collectorItem.visible = false;
        this.menu.addMenuItem(this._collectorItem);

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

    // Make `children` (facet submenus) openable *inside* `parentItem` (a period
    // submenu) without collapsing it. GNOME tracks only one open submenu per top
    // menu: when a child opens it asks `_getTopMenu()._setOpenedSubMenu(child)`,
    // which closes the previously-open submenu -- the parent. We give the parent
    // submenu its own opened-child tracking and redirect the children's
    // `_getTopMenu()` to it, so opening a facet closes only a sibling facet, never
    // the parent. The parent's own open/close is still tracked by the real top
    // menu, so opening another period still closes this one.
    _makeNestable(parentItem, children) {
        const parentMenu = parentItem.menu; // a PopupSubMenu (extends PopupMenuBase)
        parentMenu._openedSubMenu = null;
        parentMenu._setOpenedSubMenu = (submenu) => {
            if (parentMenu._openedSubMenu)
                parentMenu._openedSubMenu.close(true);
            parentMenu._openedSubMenu = submenu;
        };
        for (const child of children) {
            child._getTopMenu = () => parentMenu;
        }
        // When the period collapses, close whichever facet was open so reopening
        // starts clean (PopupSubMenu only emits open-state-changed, so the facets'
        // own menu-closed wiring never fires here).
        parentMenu.connect('open-state-changed', (_m, open) => {
            if (!open && parentMenu._openedSubMenu) {
                parentMenu._openedSubMenu.close(false);
                parentMenu._openedSubMenu = null;
            }
        });
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

        // Sourcing: the bundled CLI reads the on-disk session logs (authoritative,
        // billed totals) and -- when a collector URL is configured -- also fetches
        // the live OTLP feed and reconciles the two by session id, returning live
        // totals (*_aic_live), open sessions, and any anomalies. Reconciliation
        // lives in the CLI because only it has the complete on-disk session set.
        const argv = [this._nodePath, this._scriptPath, '--json'];
        const collectorUrl = (this._settings.get_string('collector-url') || '').trim();
        if (collectorUrl) argv.push(`--collector=${collectorUrl}`);

        let proc;
        try {
            proc = Gio.Subprocess.new(
                argv,
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

        const d = this._data;
        const live = !!(d.collector && d.collector.connected);

        // Panel shows today + this week. Prefer live-adjusted totals (on-disk +
        // open sessions) when the collector is connected; else on-disk-only.
        const todayAic = live ? d.today_aic_live : d.today_aic;
        const weekAic = live ? d.week_aic_live : d.week_aic;
        this._panelLabel.set_text(`D: ${this._dollars(todayAic)}  W: ${this._dollars(weekAic)}`);

        this._updatePeriods();
        this._updateIncomplete();
        this._updateAnomalies();
        this._updateCollectorStatus();
        this._updateLastUpdatedLabel();
    }

    _updateAnomalies() {
        const anomalies = this._data?.anomalies || [];
        this._anomaliesMenu.menu.removeAll();
        if (!anomalies.length) {
            this._anomaliesMenu.visible = false;
            return;
        }
        this._anomaliesMenu.visible = true;
        // Warn (⚠ + count) only about recent anomalies; older ones are still
        // listed (dimmed) so they can be inspected without nagging.
        const recent = anomalies.filter(a => a.recent).length;
        this._anomaliesMenu.label.set_text(recent > 0
            ? `⚠ Anomalies (${recent})`
            : `Anomalies (${anomalies.length})`);
        for (const a of anomalies.slice(0, 20)) {
            const id8 = (a.id || '').slice(0, 8);
            let text;
            if (a.type === 'mismatch') {
                text = `${id8}: live ${a.collector_aic} vs shutdown ${a.shutdown_aic} AIC (Δ${a.diff})`;
            } else if (a.type === 'orphan') {
                text = `${id8}: collector ${a.collector_aic} AIC but no session log`;
            } else {
                text = `${id8}: ${a.type}`;
            }
            const item = new PopupMenu.PopupMenuItem(text);
            item.setSensitive(false);
            item.label.add_style_class_name('copilot-truncate-label');
            if (!a.recent) item.label.add_style_class_name('copilot-dim-label');
            item.label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
            this._anomaliesMenu.menu.addMenuItem(item);
        }
    }

    _updateIncomplete() {
        const d = this._data || {};
        const list = d.incomplete_sessions || [];
        this._incompleteMenu.menu.removeAll();
        if (!list.length) {
            this._incompleteMenu.visible = false;
            return;
        }
        this._incompleteMenu.visible = true;
        const recent = (d.incomplete_recent_count != null)
            ? d.incomplete_recent_count
            : list.filter(s => s.recent).length;
        // Show the recent count when some are recent; otherwise a quieter title
        // so old ones can still be inspected without nagging.
        this._incompleteMenu.label.set_text(recent > 0
            ? `${recent} incomplete session${recent === 1 ? '' : 's'}`
            : `Incomplete sessions (${list.length})`);
        for (const s of list.slice(0, MAX_MENU_ROWS)) {
            const id8 = (s.id || '').slice(0, 8);
            const item = new PopupMenu.PopupMenuItem(
                `${id8}  ${this._formatWhen(s.start_ms)}  (${s.total_messages} msg, ${s.tool_calls} tools)`);
            item.setSensitive(false);
            item.label.add_style_class_name('copilot-truncate-label');
            if (!s.recent) item.label.add_style_class_name('copilot-dim-label');
            item.label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
            this._incompleteMenu.menu.addMenuItem(item);
        }
        this._addMoreRow(this._incompleteMenu, list.length);
    }

    _updateCollectorStatus() {
        const c = this._data?.collector;
        if (!c) {
            this._collectorItem.visible = false;
            return;
        }
        this._collectorItem.visible = true;
        if (c.connected) {
            const open = this._data.live_session_count || 0;
            const openTxt = open ? `, ${open} open` : '';
            this._collectorItem.label.set_text(
                `Collector: live (${c.session_count} tracked${openTxt})`);
        } else {
            this._collectorItem.label.set_text('Collector: offline (on-disk totals only)');
        }
    }

    // Refresh every period submenu (title total + the nested Sessions / Models /
    // Directories / Repositories groupings) from the CLI's `periods` array.
    _updatePeriods() {
        const d = this._data || {};
        const live = !!(d.collector && d.collector.connected);
        const byPeriod = {};
        for (const p of (d.periods || [])) byPeriod[p.period] = p;

        for (const key of PERIODS) {
            const refs = this._periodMenus[key];
            if (!refs) continue;
            const p = byPeriod[key];
            if (!p) {
                refs.root.label.set_text(`${PERIOD_LABELS[key]}: $--`);
                continue;
            }

            // Prefer the live-adjusted total when the collector is connected, and
            // note the live delta in the title.
            const baseAic = p.aic || 0;
            const liveAic = (live && typeof p.aic_live === 'number') ? p.aic_live : baseAic;
            const suffix = (live && liveAic > baseAic)
                ? `  (+${this._dollars(liveAic - baseAic)} live)` : '';
            refs.root.label.set_text(`${p.label}: ${this._dollars(liveAic)}${suffix}`);

            this._fillSessionsMenu(refs.sessions, p.sessions);
            this._fillDimensionMenu(refs.models, 'Models', p.models,
                m => `${this._dollars(m.aic)}  ${m.model}  (${m.requests} req)`,
                Pango.EllipsizeMode.END);
            this._fillDimensionMenu(refs.directories, 'Directories', p.directories,
                dir => {
                    const s = dir.sessions === 1 ? '' : 's';
                    return `${this._dollars(dir.aic)}  ${this._shortDir(dir.dir)}  (${dir.sessions} session${s})`;
                },
                // MIDDLE keeps both the cost (start) and the project dir (end) visible.
                Pango.EllipsizeMode.MIDDLE);
            this._fillDimensionMenu(refs.repositories, 'Repositories', p.repositories,
                r => {
                    const n = (r.branches || []).length;
                    const branch = n === 1 ? r.branches[0].branch : `${n} branches`;
                    return `${this._dollars(r.aic)}  ${r.repo}  (${branch})`;
                },
                Pango.EllipsizeMode.END);
        }
    }

    // Collapse the home dir to ~ so directory rows stay readable.
    _shortDir(p) {
        if (!p) return '(unknown)';
        const home = GLib.get_home_dir();
        if (p === home) return '~';
        if (p.startsWith(home + '/')) return '~' + p.slice(home.length);
        return p;
    }

    // Disabled, dim "(none)" placeholder for an empty (sub)menu.
    _addEmptyRow(submenu) {
        const empty = new PopupMenu.PopupMenuItem('(none)');
        empty.setSensitive(false);
        empty.label.add_style_class_name('copilot-dim-label');
        submenu.menu.addMenuItem(empty);
    }

    // "... and N more" footer when a list is capped at MAX_MENU_ROWS.
    _addMoreRow(submenu, total) {
        if (total <= MAX_MENU_ROWS) return;
        const more = new PopupMenu.PopupMenuItem(`... and ${total - MAX_MENU_ROWS} more`);
        more.setSensitive(false);
        more.label.add_style_class_name('copilot-dim-label');
        submenu.menu.addMenuItem(more);
    }

    _fillSessionsMenu(submenu, sessions) {
        submenu.menu.removeAll();
        const list = sessions || [];
        submenu.label.set_text(`Sessions (${list.length})`);
        if (!list.length) {
            this._addEmptyRow(submenu);
            return;
        }
        for (const s of list.slice(0, MAX_MENU_ROWS)) {
            const when = this._formatWhen(s.start_ms);
            const id8 = (s.id || '').slice(0, 8);
            // Live (still-open) sessions come from the collector and have no
            // message/tool counts yet; mark them and skip the (msg, tools) tail.
            const detail = s.live
                ? `  ${s.running ? '● live' : 'open'}`
                : `  (${s.total_messages} msg, ${s.tool_calls} tools)`;
            const item = new PopupMenu.PopupMenuItem(
                `${this._dollars(s.aic)}  ${id8}  ${when}${detail}`);
            item.setSensitive(false);
            item.label.add_style_class_name('copilot-truncate-label');
            item.label.clutter_text.set_ellipsize(Pango.EllipsizeMode.END);
            submenu.menu.addMenuItem(item);
        }
        this._addMoreRow(submenu, list.length);
    }

    // Populate a dimension submenu (Models / Directories / Repositories) for a
    // period. Rows are display-only; long labels ellipsize per ellipsizeMode.
    _fillDimensionMenu(submenu, title, items, rowText, ellipsizeMode) {
        submenu.menu.removeAll();
        const list = items || [];
        submenu.label.set_text(`${title} (${list.length})`);
        if (!list.length) {
            this._addEmptyRow(submenu);
            return;
        }
        for (const it of list.slice(0, MAX_MENU_ROWS)) {
            const item = new PopupMenu.PopupMenuItem(rowText(it));
            item.setSensitive(false);
            item.label.add_style_class_name('copilot-truncate-label');
            item.label.clutter_text.set_ellipsize(ellipsizeMode);
            submenu.menu.addMenuItem(item);
        }
        this._addMoreRow(submenu, list.length);
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
            const p2 = n => n.toString().padStart(2, '0');
            const time = `${p2(date.getHours())}:${p2(date.getMinutes())}`;
            // Same day: time only. Periods can span months/years, so older
            // sessions need a date: MM-DD this year, YYYY-MM-DD otherwise.
            if (date.toDateString() === now.toDateString()) return time;
            const md = `${p2(date.getMonth() + 1)}-${p2(date.getDate())}`;
            if (date.getFullYear() === now.getFullYear()) return `${md} ${time}`;
            return `${date.getFullYear()}-${md}`;
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
