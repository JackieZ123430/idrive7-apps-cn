'use strict';
// English by default; Chinese contribution: 小白科技杂物社 / Bilibili 小白151 / GitHub JackieZ123430.
const { setLanguage, getLanguage } = require('./i18n');
class LocaleUi {
    constructor(settings, tables, bundle, dynamicText) {
        this.settings = settings; this.tables = tables; this.bundle = bundle; this.dynamicText = dynamicText;
        this.pending = Promise.resolve();
    }
    refresh() {
        // Read the saved selection inside the queue, so rapid changes always finish in the latest language.
        this.pending = this.pending.catch(() => {}).then(() => {
            setLanguage(this.settings.get('language'));
            return this.bundle.setStrings(this.tables[getLanguage()]);
        }).then(() => this.dynamicText.refresh());
        return this.pending;
    }
}
module.exports = { LocaleUi };
