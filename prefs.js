import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class CopilotUsagePreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Copilot Usage',
            icon_name: 'dialog-information-symbolic',
        });
        window.add(page);

        const settingsGroup = new Adw.PreferencesGroup({
            title: 'Settings',
        });
        page.add(settingsGroup);

        // Fallback rescan interval
        const intervalRow = new Adw.SpinRow({
            title: 'Refresh Interval',
            subtitle: 'Fallback rescan period in seconds. File changes are detected in real time; this just backstops anything missed.',
            adjustment: new Gtk.Adjustment({
                lower: 5,
                upper: 600,
                step_increment: 5,
                page_increment: 30,
                value: settings.get_int('refresh-interval'),
            }),
        });
        intervalRow.connect('notify::value', () => {
            settings.set_int('refresh-interval', intervalRow.get_value());
        });
        settingsGroup.add(intervalRow);

        // AIC -> dollars rate
        const rateRow = new Adw.SpinRow({
            title: 'Dollars per AIC',
            subtitle: '1 AIC = $0.01 by default.',
            digits: 4,
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 1,
                step_increment: 0.001,
                page_increment: 0.01,
                value: settings.get_double('aic-rate'),
            }),
        });
        rateRow.connect('notify::value', () => {
            settings.set_double('aic-rate', rateRow.get_value());
        });
        settingsGroup.add(rateRow);

        const infoGroup = new Adw.PreferencesGroup({
            title: 'About',
        });
        page.add(infoGroup);

        const infoRow = new Adw.ActionRow({
            title: 'How it works',
            subtitle: 'Reads AIC cost from the session.shutdown event in each\n~/.copilot/session-state/<id>/events.jsonl file. Only closed\nsessions report a cost, so open sessions appear once they exit.\nThe panel shows today (since midnight) and this week (since Monday).',
        });
        infoRow.set_activatable(false);
        infoGroup.add(infoRow);
    }
}
